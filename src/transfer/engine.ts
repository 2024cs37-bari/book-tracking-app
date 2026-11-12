import { verifySha256 } from '~/storage/sha256';
import { bookFileKey, type BookFileStore } from '~/storage/file-store';
import { bookFileLeases } from '~/storage/book-file-leases';
import { failurePolicy, retryDelay } from '~/sync/network';
import type { BookRepository } from '~/data/repositories/book-repository';
import type { DeviceStateRepository } from '~/data/repositories/device-state-repository';
import type { FileTransferRepository } from '~/data/repositories/file-transfer-repository';
import type { FileTransferRow } from '~/data/db';
import type { FileTransport } from './transport';
import { FileTransferHttpError } from './http-transport';

export interface FileTransferResult {
  readonly uploaded: number;
  readonly downloaded: number;
  readonly failed: number;
  readonly cancelled: number;
}
export interface FileTransferEngineOptions {
  readonly transfers: FileTransferRepository;
  readonly files: BookFileStore;
  readonly books: BookRepository;
  readonly deviceState: DeviceStateRepository;
  readonly transport: FileTransport;
  readonly concurrency?: number;
  readonly maxJobs?: number;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly lockName?: string;
}

/** Bounded, single-flight durable queue; metadata and reading never wait for its network. */
export class FileTransferEngine {
  private inFlight?: Promise<FileTransferResult>;
  private readonly active = new Map<string, AbortController>();
  constructor(private readonly options: FileTransferEngineOptions) {}

  hasRemoteCopy(sha256: string, sizeBytes: number): Promise<boolean> {
    return this.options.transport.hasRemoteFile?.(sha256, sizeBytes) ?? Promise.resolve(false);
  }
  async cancel(id: string): Promise<void> {
    this.active.get(id)?.abort();
    await this.options.transfers.cancel(id);
  }
  run(): Promise<FileTransferResult> {
    if (this.inFlight) return this.inFlight;
    const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
    const work = () => this.drain();
    this.inFlight = (
      locks ? locks.request(this.options.lockName ?? 'book-reader:transfers', work) : work()
    ).finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }
  private async drain(): Promise<FileTransferResult> {
    await this.options.transfers.recoverRunning();
    const now = (this.options.now ?? Date.now)();
    const queue = (await this.options.transfers.listPending())
      .filter(
        (row) =>
          row.state === 'queued' ||
          (row.retryable !== false &&
            !row.authExpired &&
            (row.retryAfter === undefined || row.retryAfter <= now)),
      )
      .slice(0, this.options.maxJobs ?? 20);
    const result = { uploaded: 0, downloaded: 0, failed: 0, cancelled: 0 };
    let authBlocked = false;
    const worker = async () => {
      for (;;) {
        if (authBlocked) return;
        const row = queue.shift();
        if (!row) return;
        const outcome = await this.processOne(row);
        result[outcome] += 1;
        if ((await this.options.transfers.get(row.id))?.authExpired) authBlocked = true;
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.max(1, Math.min(this.options.concurrency ?? 2, queue.length)) },
        worker,
      ),
    );
    return result;
  }
  private async processOne(row: FileTransferRow): Promise<keyof FileTransferResult> {
    const controller = new AbortController();
    this.active.set(row.id, controller);
    let release: (() => void) | undefined;
    try {
      if ((await this.options.transfers.get(row.id))?.state === 'cancelled') return 'cancelled';
      await this.options.transfers.setState(row.id, 'running');
      release = await bookFileLeases.acquire(row.sha256);
      const outcome =
        row.direction === 'upload'
          ? await this.upload(row, controller.signal)
          : await this.download(row, controller.signal);
      return outcome;
    } catch (error) {
      if (controller.signal.aborted) {
        await this.options.transfers.cancel(row.id);
        return 'cancelled';
      }
      const policy = failurePolicy(error);
      const delay = Math.max(
        policy.retryAfterMs ?? 0,
        retryDelay(row.attempts ?? 0, this.options.random),
      );
      await this.options.transfers.markFailed(row.id, policy.retryable ? delay : undefined, {
        error: error instanceof Error ? error.message : 'Transfer failed.',
        retryable: policy.retryable,
        authExpired: policy.authExpired,
      });
      return 'failed';
    } finally {
      release?.();
      this.active.delete(row.id);
    }
  }
  private async upload(row: FileTransferRow, signal: AbortSignal): Promise<'uploaded'> {
    const key = bookFileKey(row.sha256);
    if (!(await this.options.files.has(key)))
      throw new FileTransferHttpError(
        'The original is no longer stored on this device. Import it again to upload.',
        { retryable: false },
      );
    const blob = await this.options.files.get(key);
    if (blob.size > 100_000_000)
      throw new FileTransferHttpError(
        'This original exceeds the server’s 100 MB upload limit. It remains available locally.',
        { retryable: false },
      );
    const auth = await this.options.transport.beginUpload(row.sha256, blob.size, signal);
    if (!auth.alreadyAvailable) {
      if (!auth.ticket)
        throw new FileTransferHttpError('Upload authorization carried no ticket.', {
          retryable: false,
        });
      await this.options.transport.upload(auth.ticket, blob, signal);
    }
    await this.options.transport.finishUpload(row.sha256, blob.size, signal);
    signal.throwIfAborted();
    await this.options.transfers.markComplete(row.id, blob.size);
    return 'uploaded';
  }
  private async download(row: FileTransferRow, signal: AbortSignal): Promise<'downloaded'> {
    const key = bookFileKey(row.sha256);
    let blob: Blob | undefined;
    if (await this.options.files.has(key)) {
      const existing = await this.options.files.get(key);
      if (await verifySha256(existing, row.sha256)) blob = existing;
    }
    if (!blob) {
      const ticket = await this.options.transport.beginDownload(row.sha256, signal);
      blob = await this.options.transport.download(ticket, signal);
      if (!(await verifySha256(blob, row.sha256)))
        throw new FileTransferHttpError(
          'Downloaded original failed SHA-256 verification. No downloaded bytes were stored.',
          { retryable: false },
        );
      signal.throwIfAborted();
      await this.options.files.put(key, blob);
    }
    signal.throwIfAborted();
    const book = await this.options.books.findBySha256(row.sha256);
    if (book) await this.options.deviceState.setFilePresent(book.id, true);
    await this.options.transfers.markComplete(row.id, blob.size);
    return 'downloaded';
  }
}
