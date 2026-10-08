import type { BookRepository } from '~/data/repositories/book-repository';
import type { ProgressRepository } from '~/data/repositories/progress-repository';
import type { DeviceStateRepository } from '~/data/repositories/device-state-repository';
import { assertLocator, type Locator } from '~/domain/locator';
import { bookFileKey, type BookFileStore } from '~/storage/file-store';
import {
  DEFAULT_READER_SETTINGS,
  type ReaderSettings,
  type Renderer,
  type RendererRegistry,
} from '~/reader/renderer';

const SETTINGS_KEY = 'reader-settings-v1';

export class ReaderSession {
  private pending?: Locator;
  private timer?: ReturnType<typeof setTimeout>;
  private writes = Promise.resolve();
  private unsubscribe?: () => void;
  private closed = false;
  constructor(
    readonly renderer: Renderer,
    private readonly bookId: string,
    private readonly progress: ProgressRepository,
    private readonly report: (message: string) => void,
    private readonly persistClock: () => Promise<void>,
    private readonly onClose: (write: Promise<void>) => void = () => {},
  ) {}

  async open(
    file: Blob,
    startAt: Locator | undefined,
    onPosition: (locator: Locator) => void,
  ): Promise<void> {
    if (this.closed) return;
    this.unsubscribe = this.renderer.onRelocate((locator) => {
      if (this.closed) return;
      this.pending = assertLocator(locator);
      onPosition(locator);
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        void this.flush();
      }, 400);
    });
    await this.renderer.open(file, startAt);
  }
  flush(): Promise<void> {
    clearTimeout(this.timer);
    const locator = this.pending;
    this.pending = undefined;
    if (locator) {
      // Serial writes preserve relocation order even when storage is slow.
      this.writes = this.writes
        .then(async () => {
          await this.progress.save({ bookId: this.bookId, locator });
          await this.persistClock();
        })
        .catch((error: unknown) => this.report(`Position could not be saved: ${String(error)}`));
    }
    return this.writes;
  }
  close(): Promise<void> {
    if (this.closed) return this.flush();
    this.closed = true;
    this.unsubscribe?.();
    this.renderer.destroy();
    const write = this.flush();
    this.onClose(write);
    return write;
  }
}

export class ReaderService {
  private pendingClose = Promise.resolve();
  constructor(
    private readonly dependencies: {
      books: BookRepository;
      progress: ProgressRepository;
      deviceState: DeviceStateRepository;
      files: BookFileStore;
      renderers: RendererRegistry;
      persistClock(): Promise<void>;
    },
  ) {}

  async prepare(
    bookId: string,
    report: (message: string) => void,
  ): Promise<{ title: string; session: ReaderSession; file: Blob; startAt?: Locator }> {
    // A rapid close/reopen must see the last flush, not a stale saved locator.
    await this.pendingClose;
    const { books, progress, files, renderers, deviceState } = this.dependencies;
    const book = await books.getById(bookId);
    if (!book || book.lifecycle === 'deleted') throw new Error('Book not found.');
    const factory = renderers.resolve(book.format);
    if (!factory) throw new Error('Reading is not implemented for this format.');
    if (!(await files.has(bookFileKey(book.sha256))))
      throw new Error('Original file is missing. Re-import this book.');
    const file = await files.get(bookFileKey(book.sha256));
    const saved = await progress.get(bookId);
    await deviceState.markOpened(bookId);
    return {
      title: book.title,
      session: new ReaderSession(
        factory.create(),
        bookId,
        progress,
        report,
        this.dependencies.persistClock,
        (write) => {
          this.pendingClose = Promise.all([this.pendingClose, write]).then(() => {});
        },
      ),
      file,
      startAt: saved?.locator ?? undefined,
    };
  }

  loadSettings(): ReaderSettings {
    try {
      const value = JSON.parse(
        localStorage.getItem(SETTINGS_KEY) ?? 'null',
      ) as Partial<ReaderSettings> | null;
      if (
        value &&
        typeof value.fontSizePx === 'number' &&
        value.fontSizePx >= 12 &&
        value.fontSizePx <= 36 &&
        typeof value.lineHeight === 'number' &&
        value.lineHeight >= 1 &&
        value.lineHeight <= 2.5 &&
        typeof value.marginPx === 'number' &&
        value.marginPx >= 0 &&
        value.marginPx <= 80 &&
        ['light', 'sepia', 'dark'].includes(value.theme ?? '')
      )
        return value as ReaderSettings;
    } catch {
      /* Invalid/unavailable local settings use defaults. */
    }
    return DEFAULT_READER_SETTINGS;
  }
  saveSettings(settings: ReaderSettings): void {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }
}
