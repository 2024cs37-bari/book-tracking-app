import type { BookRepository } from '~/data/repositories/book-repository';
import type { ProgressRepository } from '~/data/repositories/progress-repository';
import type { DeviceStateRepository } from '~/data/repositories/device-state-repository';
import { assertLocator, type Locator } from '~/domain/locator';
import { bookFileKey, type BookFileStore } from '~/storage/file-store';
import { bookFileLeases } from '~/storage/book-file-leases';
import { parseHlc } from '~/domain/hlc';
import { PositionJournal, type PositionIntent } from './position-journal';
import {
  DEFAULT_READER_SETTINGS,
  normalizeReaderSettings,
  type ReaderSettings,
  type Renderer,
  type RendererRegistry,
} from '~/reader/renderer';

const SETTINGS_KEY = 'reader-settings-v1';

export type PositionSaveState = 'saved' | 'pending' | 'saving' | 'failed';

export class ReaderSession {
  private pending?: PositionIntent;
  private timer?: ReturnType<typeof setTimeout>;
  private writes = Promise.resolve();
  private unsubscribe?: () => void;
  private closed = false;
  private savingSuspended = false;
  private latest?: Locator;
  private readonly queued = new Set<string>();
  private readonly journal: PositionJournal;
  private state: PositionSaveState = 'saved';
  private readonly stateListeners = new Set<(state: PositionSaveState) => void>();
  constructor(
    readonly renderer: Renderer,
    readonly bookId: string,
    private readonly progress: ProgressRepository,
    private readonly report: (message: string) => void,
    private readonly persistClock: () => Promise<void>,
    private readonly onClose: (write: Promise<void>) => void = () => {},
    journal?: PositionJournal,
    private readonly sha256?: string,
    private readonly journalId = bookId,
  ) {
    this.journal = journal ?? new PositionJournal();
    this.pending = this.journal.read(this.journalId);
    if (this.pending) this.state = 'pending';
  }

  onSaveState(callback: (state: PositionSaveState) => void): () => void {
    this.stateListeners.add(callback);
    callback(this.state);
    return () => this.stateListeners.delete(callback);
  }
  private setState(state: PositionSaveState): void {
    // A failed write stays visible while a new location or retry is pending.
    // Hiding its banner during reflow can itself relocate an EPUB indefinitely.
    if (this.state === 'failed' && (state === 'pending' || state === 'saving')) return;
    this.state = state;
    for (const callback of this.stateListeners) callback(state);
  }

  async open(
    file: Blob,
    startAt: Locator | undefined,
    onPosition: (locator: Locator) => void,
  ): Promise<void> {
    if (this.closed) return;
    this.unsubscribe = this.renderer.onRelocate((locator) => {
      if (this.closed) return;
      try {
        const previous = this.latest;
        this.latest = assertLocator(locator);
        onPosition(locator);
        if (this.savingSuspended) return;
        // Engines also report layout-only relocations. A repeated native
        // position must not manufacture new journal tokens or reset debounce.
        if (
          previous?.kind === locator.kind &&
          previous.value === locator.value &&
          Math.abs(previous.fraction - locator.fraction) < 1e-8
        )
          return;
        this.pending = this.journal.write(this.journalId, this.latest, this.sha256);
        this.setState('pending');
        clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          void this.flush();
        }, 400);
      } catch (error) {
        this.report(`Reader returned an invalid position: ${String(error)}`);
      }
    });
    await this.renderer.open(file, startAt);
    if (this.pending && !this.closed) void this.flush();
  }

  suspendSaving(): void {
    this.savingSuspended = true;
    clearTimeout(this.timer);
  }

  resumeSaving(useCurrentPosition: boolean): Promise<void> {
    this.savingSuspended = false;
    if (!useCurrentPosition && this.pending) {
      this.journal.clear(this.journalId, this.pending.token);
      this.pending = undefined;
      this.setState('saved');
    }
    if (useCurrentPosition && this.latest) {
      this.pending = this.journal.write(this.journalId, this.latest, this.sha256);
      this.setState('pending');
    }
    return this.flush();
  }

  flush(): Promise<void> {
    clearTimeout(this.timer);
    if (this.savingSuspended) return this.writes;
    const intent = this.pending;
    if (intent && !this.queued.has(intent.token)) {
      this.queued.add(intent.token);
      // Retain the latest unsaved intent until its transaction succeeds. A
      // failed older write never replaces a newer relocation or its journal.
      this.writes = this.writes.then(async () => {
        if (this.savingSuspended || this.pending?.token !== intent.token) {
          this.queued.delete(intent.token);
          return;
        }
        this.setState('saving');
        try {
          await this.progress.save({ bookId: this.bookId, locator: intent.locator });
          await this.persistClock();
          this.journal.clear(this.journalId, intent.token);
          if (this.pending?.token === intent.token) {
            this.pending = undefined;
            this.setState('saved');
          }
        } catch (error) {
          if (this.pending?.token === intent.token) this.setState('failed');
          this.report(
            `Position could not be saved: ${String(error)}. Your latest position is retained for retry; keep this page open if possible.`,
          );
        } finally {
          this.queued.delete(intent.token);
        }
      });
    }
    return this.writes;
  }

  close(): Promise<void> {
    if (this.closed) return this.flush();
    this.closed = true;
    this.unsubscribe?.();
    try {
      this.renderer.destroy();
    } catch (error) {
      this.report(`Reader cleanup failed: ${String(error)}`);
    } finally {
      this.onClose(this.flush());
    }
    return this.writes;
  }
}

export class ReaderService {
  private pendingClose = Promise.resolve();
  private readonly journal: PositionJournal;
  constructor(
    private readonly dependencies: {
      books: BookRepository;
      progress: ProgressRepository;
      deviceState: DeviceStateRepository;
      files: BookFileStore;
      renderers: RendererRegistry;
      persistClock(): Promise<void>;
      storageNamespace?: string;
    },
  ) {
    this.journal = new PositionJournal(dependencies.storageNamespace);
  }

  async prepare(
    bookId: string,
    report: (message: string) => void,
  ): Promise<{
    bookId: string;
    title: string;
    session: ReaderSession;
    file: Blob;
    startAt?: Locator;
  }> {
    // A rapid close/reopen must see the last flush, not a stale saved locator.
    await this.pendingClose;
    const { books, progress, files, renderers, deviceState } = this.dependencies;
    const book = await books.getById(bookId);
    if (!book || book.lifecycle === 'deleted') throw new Error('Book not found.');
    const factory = renderers.resolve(book.format);
    if (!factory) throw new Error('Reading is not implemented for this format.');
    const release = await bookFileLeases.acquire(book.sha256);
    try {
      if (!(await files.has(bookFileKey(book.sha256))))
        throw new Error(
          'Original file is missing. Download it from the book page or re-import this book.',
        );
      const file = await files.get(bookFileKey(book.sha256));
      const saved = await progress.get(book.id);
      // UUIDs can change while a reader is open; the original hash cannot.
      const journalId = `sha256:${book.sha256}`;
      for (const legacyId of new Set([bookId, book.id])) {
        const legacy = this.journal.read(legacyId);
        if (legacy?.sha256 !== undefined && legacy.sha256 !== book.sha256)
          this.journal.clear(legacyId, legacy.token);
        else this.journal.migrate(legacyId, journalId);
      }
      this.journal.migrateOriginal(book.sha256, journalId);
      let unsaved = this.journal.read(journalId);
      const durableWall = saved ? parseHlc(saved.updatedHlc)?.wallMs : undefined;
      if (
        unsaved &&
        ((unsaved.sha256 !== undefined && unsaved.sha256 !== book.sha256) ||
          (durableWall !== undefined && durableWall > unsaved.recordedAt))
      ) {
        this.journal.clear(journalId, unsaved.token);
        unsaved = undefined;
      }
      await deviceState.markOpened(book.id);
      return {
        bookId: book.id,
        title: book.title,
        session: new ReaderSession(
          factory.create(),
          book.id,
          progress,
          report,
          this.dependencies.persistClock,
          (write) => {
            release();
            this.pendingClose = Promise.all([this.pendingClose, write]).then(() => {});
          },
          this.journal,
          book.sha256,
          journalId,
        ),
        file,
        startAt: unsaved?.locator ?? saved?.locator ?? undefined,
      };
    } catch (error) {
      release();
      throw error;
    }
  }

  loadSettings(): ReaderSettings {
    try {
      return normalizeReaderSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null'));
    } catch {
      /* Invalid/unavailable local settings use defaults. */
    }
    return DEFAULT_READER_SETTINGS;
  }
  saveSettings(settings: ReaderSettings): void {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(normalizeReaderSettings(settings)));
  }
}
