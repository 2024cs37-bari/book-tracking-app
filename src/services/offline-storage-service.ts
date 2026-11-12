import { saveFile } from '~/storage/save-file';
import Dexie from 'dexie';
import type { LibraryDatabase } from '~/data/db';
import type { DeviceStateRepository } from '~/data/repositories/device-state-repository';
import { bookFileKey, type BookFileStore } from '~/storage/file-store';
import { bookFileLeases, type BookFileLeases } from '~/storage/book-file-leases';
import { verifySha256 } from '~/storage/sha256';

export interface CacheSummary {
  readonly localBytes: number;
  readonly localBooks: number;
  readonly pinnedBooks: number;
  readonly pinnedBytes: number;
}

export interface CacheCleanupResult {
  readonly removedBooks: number;
  readonly freedBytes: number;
  readonly remainingBytes: number;
  readonly targetMet: boolean;
}

export interface OfflineStorageOptions {
  readonly db: LibraryDatabase;
  readonly files: BookFileStore;
  readonly deviceState: DeviceStateRepository;
  readonly leases?: BookFileLeases;
  /** Recheck current remote existence + size; never infer safety from a past upload. */
  readonly verifyRemote?: (hash: string, size: number) => Promise<boolean>;
}

/** Device-local pins and conservative LRU removal; originals without a remote copy stay local. */
export class OfflineStorageService {
  private readonly leases: BookFileLeases;
  private cleanup?: Promise<CacheCleanupResult>;

  constructor(private readonly options: OfflineStorageOptions) {
    this.leases = options.leases ?? bookFileLeases;
  }

  async downloadOriginal(bookId: string): Promise<void> {
    const book = await this.options.db.books.get(bookId);
    if (book === undefined) throw new Error('Book not found.');
    const release = await this.leases.acquire(book.sha256);
    try {
      const blob = await this.options.files.get(bookFileKey(book.sha256));
      if (!(await verifySha256(blob, book.sha256))) {
        throw new Error('The local original failed its integrity check. Re-import a trusted copy.');
      }
      const filename = `${book.title.replace(/[<>:"/\\|?*\p{Cc}]/gu, '_').slice(0, 120) || 'book'}.${book.format}`;
      await saveFile(blob, filename);
    } finally {
      release();
    }
  }

  async setPinned(bookId: string, pinned: boolean): Promise<void> {
    const book = await this.options.db.books.get(bookId);
    if (book === undefined || book.lifecycle === 'deleted') throw new Error('Book not found.');
    const release = await this.leases.acquire(book.sha256);
    try {
      if (pinned) {
        if (!this.options.files.durable)
          throw new Error('Offline pins need durable browser storage.');
        const key = bookFileKey(book.sha256);
        if (!(await this.options.files.has(key)))
          throw new Error('Download this book before pinning it.');
        if (!(await verifySha256(await this.options.files.get(key), book.sha256))) {
          await this.options.db.transaction(
            'rw',
            this.options.db.books,
            this.options.db.deviceState,
            this.options.db.syncMeta,
            async () => {
              const current = await this.options.db.books
                .where('sha256')
                .equals(book.sha256)
                .first();
              if (current) await this.options.deviceState.setFilePresent(current.id, false);
            },
          );
          throw new Error(
            'This original failed its integrity check. Re-import or download it again.',
          );
        }
      }
      // Sync may replace a duplicate UUID while hashing the original. Resolve
      // the immutable content identity again in the same transaction as the pin.
      await this.options.db.transaction(
        'rw',
        this.options.db.books,
        this.options.db.deviceState,
        this.options.db.syncMeta,
        async () => {
          const current = await this.options.db.books.where('sha256').equals(book.sha256).first();
          if (!current || current.lifecycle === 'deleted') throw new Error('Book not found.');
          if (pinned) await this.options.deviceState.setFilePresent(current.id, true);
          await this.options.deviceState.setPinned(current.id, pinned);
        },
      );
    } finally {
      release();
    }
  }

  async summary(): Promise<CacheSummary> {
    const books = await this.options.db.books.toArray();
    const states = new Map(
      (await this.options.db.deviceState.toArray()).map((row) => [row.bookId, row]),
    );
    let localBytes = 0;
    let localBooks = 0;
    let pinnedBooks = 0;
    let pinnedBytes = 0;
    for (const book of books) {
      if (!(await this.options.files.has(bookFileKey(book.sha256)))) continue;
      localBooks++;
      localBytes += book.sizeBytes;
      if (states.get(book.id)?.pinnedOffline) {
        pinnedBooks++;
        pinnedBytes += book.sizeBytes;
      }
    }
    return { localBytes, localBooks, pinnedBooks, pinnedBytes };
  }

  trimToBudget(targetBytes: number): Promise<CacheCleanupResult> {
    if (!Number.isSafeInteger(targetBytes) || targetBytes < 0) {
      return Promise.reject(new Error('Storage budget must be a non-negative whole byte count.'));
    }
    if (this.cleanup !== undefined) return this.cleanup;
    this.cleanup = this.trim(targetBytes).finally(() => {
      this.cleanup = undefined;
    });
    return this.cleanup;
  }

  private async trim(targetBytes: number): Promise<CacheCleanupResult> {
    const verifyRemote = this.options.verifyRemote;
    if (verifyRemote === undefined)
      throw new Error('Configure sync before removing cached originals.');
    if (!this.leases.crossTabSafe && typeof window !== 'undefined') {
      throw new Error(
        'This browser cannot protect books open in another tab. Automatic cleanup is unavailable.',
      );
    }
    const { db, files, deviceState } = this.options;
    const books = await db.books.toArray();
    const states = new Map((await db.deviceState.toArray()).map((row) => [row.bookId, row]));
    books.sort(
      (a, b) => (states.get(a.id)?.lastOpenedAt ?? 0) - (states.get(b.id)?.lastOpenedAt ?? 0),
    );
    let remainingBytes = (await this.summary()).localBytes;
    let removedBooks = 0;
    let freedBytes = 0;
    for (const book of books) {
      if (remainingBytes <= targetBytes) break;
      if (book.lifecycle === 'deleted' || states.get(book.id)?.pinnedOffline) continue;
      const removed = await this.leases.tryExclusive(book.sha256, async () => {
        const key = bookFileKey(book.sha256);
        if (!(await files.has(key)) || (await deviceState.get(book.id))?.pinnedOffline)
          return false;
        if (!(await verifyRemote(book.sha256, book.sizeBytes))) return false;
        // Remote verification can take seconds: canonical IDs, lifecycle and
        // pins may have changed meanwhile. Resolve by hash, then keep metadata
        // writes blocked only across the short local removal (never the HEAD).
        return db.transaction('rw', db.books, db.deviceState, db.syncMeta, async () => {
          const current = await db.books.where('sha256').equals(book.sha256).toArray();
          if (
            current.length === 0 ||
            current.some((row) => row.lifecycle === 'deleted' || row.sizeBytes !== book.sizeBytes)
          )
            return false;
          for (const row of current)
            if ((await deviceState.get(row.id))?.pinnedOffline) return false;
          await Dexie.waitFor(files.remove(key));
          for (const row of current) await deviceState.setFilePresent(row.id, false);
          return true;
        });
      });
      if (removed === true) {
        removedBooks++;
        freedBytes += book.sizeBytes;
        remainingBytes -= book.sizeBytes;
      }
    }
    return { removedBooks, freedBytes, remainingBytes, targetMet: remainingBytes <= targetBytes };
  }
}
