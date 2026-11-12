import { liveQuery } from 'dexie';
import type { LibraryDatabase } from '~/data/db';
import type { SyncEngine } from './engine';
import type { FileTransferEngine } from '~/transfer/engine';
import type { FileTransferRepository } from '~/data/repositories/file-transfer-repository';
import type { BookFileStore } from '~/storage/file-store';
import { bookFileKey } from '~/storage/file-store';
import { failurePolicy, retryDelay } from './network';

export type BackgroundState =
  'idle' | 'running' | 'offline' | 'waiting' | 'paused' | 'auth-required' | 'error';
export interface BackgroundStatus {
  readonly state: BackgroundState;
  readonly lastSuccessAt?: number;
  readonly nextAttemptAt?: number;
  readonly error?: string;
}
export interface BackgroundSyncOptions {
  readonly db: LibraryDatabase;
  readonly sync: Pick<SyncEngine, 'sync'>;
  readonly transfer: Pick<FileTransferEngine, 'run'>;
  readonly transfers: FileTransferRepository;
  readonly files: BookFileStore;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly online?: () => boolean;
  readonly pollMs?: number;
  readonly debounceMs?: number;
}

/** Event-driven metadata sync with bounded polling for remote writes. Starts explicitly at boot. */
export class BackgroundSync {
  private status: BackgroundStatus = { state: 'idle' };
  private readonly listeners = new Set<(status: BackgroundStatus) => void>();
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = true;
  private paused = false;
  private blocked = false;
  private attempts = 0;
  private retryNotBefore = 0;
  private dirty = false;
  private running?: Promise<void>;
  private unsubscribe?: () => void;
  private initializing?: Promise<void>;
  private preferenceChanged = false;
  private readonly now: () => number;
  private readonly online: () => boolean;
  constructor(private readonly options: BackgroundSyncOptions) {
    this.now = options.now ?? Date.now;
    this.online = options.online ?? (() => typeof navigator === 'undefined' || navigator.onLine);
  }
  getStatus(): BackgroundStatus {
    return this.status;
  }
  subscribe(listener: (status: BackgroundStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }
  private update(status: BackgroundStatus): void {
    this.status = { lastSuccessAt: this.status.lastSuccessAt, ...status };
    for (const listener of this.listeners) listener(this.status);
  }
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.initializing = this.initialize().catch((error: unknown) => {
      this.blocked = true;
      this.update({ state: 'error', error: String(error) });
    });
  }
  private async initialize(): Promise<void> {
    const paused = await this.options.db.syncMeta.get('background_paused');
    const successful = await this.options.db.syncMeta.get('background_last_success');
    if (this.stopped) return;
    if (!this.preferenceChanged) this.paused = paused?.value === 'true';
    const lastSuccessAt = successful ? Number(successful.value) : undefined;
    this.update({
      state: this.paused ? 'paused' : 'idle',
      lastSuccessAt: Number.isFinite(lastSuccessAt) ? lastSuccessAt : undefined,
    });
    let prior: string | undefined;
    const subscription = liveQuery(async () => {
      const changes = await this.options.db.changes.where('pushedAt').equals(0).primaryKeys();
      const jobs = await this.options.db.fileTransfers
        .where('state')
        .equals('queued')
        .primaryKeys();
      const paused = await this.options.db.syncMeta.get('background_paused');
      return { signature: JSON.stringify([changes, jobs]), paused: paused?.value === 'true' };
    }).subscribe({
      next: ({ signature, paused }) => {
        if (paused !== this.paused) {
          this.paused = paused;
          if (paused) {
            clearTimeout(this.timer);
            this.update({ state: 'paused' });
          } else this.requestSync();
        }
        if (signature !== prior) {
          prior = signature;
          this.requestSync();
        }
      },
      error: (error) => {
        this.blocked = true;
        this.update({ state: 'error', error: String(error) });
      },
    });
    this.unsubscribe = () => subscription.unsubscribe();
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.wake);
      window.addEventListener('offline', this.offline);
      document.addEventListener('visibilitychange', this.foreground);
    }
    this.schedule(0);
  }
  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.unsubscribe?.();
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.wake);
      window.removeEventListener('offline', this.offline);
      document.removeEventListener('visibilitychange', this.foreground);
    }
  }
  pause(): void {
    this.preferenceChanged = true;
    this.paused = true;
    void this.options.db.syncMeta.put({ key: 'background_paused', value: 'true' }).catch(() => {});
    clearTimeout(this.timer);
    this.update({ state: 'paused' });
  }
  resume(): void {
    this.paused = false;
    void this.retryNow().catch((error: unknown) =>
      this.update({ state: 'error', error: String(error) }),
    );
  }
  /** Retains permanent/auth failures until an explicit retry; local events do not spin on them. */
  async retryNow(): Promise<void> {
    this.preferenceChanged = true;
    await this.initializing;
    await this.options.db.syncMeta.put({ key: 'background_paused', value: 'false' });
    this.blocked = false;
    this.paused = false;
    this.attempts = 0;
    this.retryNotBefore = 0;
    await this.options.transfers.retryFailed();
    if (this.running) {
      this.dirty = true;
      return this.running;
    }
    clearTimeout(this.timer);
    return this.run();
  }
  requestSync(): void {
    if (this.stopped || this.paused || this.blocked) return;
    if (this.running) {
      this.dirty = true;
      return;
    }
    // A local write cannot bypass a server-specified retry deadline.
    if (this.retryNotBefore > this.now()) {
      this.schedule(this.retryNotBefore - this.now());
      return;
    }
    this.schedule(this.options.debounceMs ?? 750);
  }
  private readonly wake = () => {
    if (!this.paused && !this.blocked) this.requestSync();
  };
  private readonly offline = () => {
    clearTimeout(this.timer);
    if (!this.paused && !this.blocked) this.update({ state: 'offline' });
  };
  private readonly foreground = () => {
    if (document.visibilityState === 'visible') this.wake();
  };
  private schedule(delay: number): void {
    if (this.stopped || this.paused || this.blocked) return;
    clearTimeout(this.timer);
    if (!this.online()) {
      this.update({ state: 'offline' });
      return;
    }
    this.update({
      state: delay > 0 ? 'waiting' : 'idle',
      nextAttemptAt: this.now() + delay,
      error: this.status.error,
    });
    this.timer = setTimeout(
      () => {
        const remaining = (this.status.nextAttemptAt ?? 0) - this.now();
        if (remaining > 0) this.schedule(remaining);
        else void this.run();
      },
      Math.max(0, Math.min(delay, 2_147_483_647)),
    );
  }
  private run(): Promise<void> {
    if (this.running) return this.running;
    if (this.stopped || this.paused || this.blocked) return Promise.resolve();
    if (!this.online()) {
      this.update({ state: 'offline' });
      return Promise.resolve();
    }
    this.running = this.cycle().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
  private async cycle(): Promise<void> {
    this.dirty = false;
    this.update({ state: 'running' });
    try {
      const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
      const sync = () => this.options.sync.sync();
      const result = locks
        ? await locks.request(`book-reader:sync:${this.options.db.name}`, sync)
        : await sync();
      // Upload locally held originals after metadata acceptance. Remote-only
      // rows never trigger mass downloading; downloads require an explicit queue job.
      if ((await this.options.db.changes.where('pushedAt').equals(0).count()) === 0) {
        for (const book of await this.options.db.books.toArray()) {
          if (
            book.lifecycle !== 'deleted' &&
            (await this.options.files.has(bookFileKey(book.sha256)))
          )
            await this.options.transfers.ensureUpload(book.sha256);
        }
      }
      if (this.paused || this.stopped) {
        if (this.paused) this.update({ state: 'paused' });
        return;
      }
      await this.options.transfer.run();
      if (this.paused || this.stopped) {
        if (this.paused) this.update({ state: 'paused' });
        return;
      }
      const pending = await this.options.transfers.listPending();
      const auth = pending.find((job) => job.authExpired);
      if (auth) {
        this.blocked = true;
        this.update({ state: 'auth-required', error: auth.error });
        return;
      }
      this.attempts = 0;
      this.retryNotBefore = 0;
      const lastSuccessAt = this.now();
      await this.options.db.syncMeta.put({
        key: 'background_last_success',
        value: String(lastSuccessAt),
      });
      const failed = pending.find((job) => job.state === 'failed');
      this.update({ state: 'idle', lastSuccessAt, error: failed?.error });
      const nextRetry = pending
        .filter((job) => job.retryable !== false)
        .reduce((earliest, job) => Math.min(earliest, job.retryAfter ?? this.now()), Infinity);
      const incomplete =
        !result.caughtUp || (await this.options.db.changes.where('pushedAt').equals(0).count()) > 0;
      this.schedule(
        Math.min(
          incomplete || this.dirty ? 750 : (this.options.pollMs ?? 60_000),
          Math.max(750, nextRetry - this.now()),
        ),
      );
    } catch (error) {
      if (this.stopped || this.paused) return;
      const policy = failurePolicy(error);
      const message = error instanceof Error ? error.message : 'Background synchronization failed.';
      if (!this.online()) {
        this.update({ state: 'offline', error: message });
        return;
      }
      if (policy.authExpired || !policy.retryable) {
        this.blocked = true;
        this.update({ state: policy.authExpired ? 'auth-required' : 'error', error: message });
        return;
      }
      const delay = Math.max(
        policy.retryAfterMs ?? 0,
        retryDelay(this.attempts++, this.options.random),
      );
      this.retryNotBefore = this.now() + delay;
      this.schedule(delay);
      this.update({ ...this.status, error: message });
    }
  }
}
