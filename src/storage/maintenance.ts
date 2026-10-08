import { bookFileKey, isBookFileKey, isCoverFileKey, type BookFileStore } from './file-store';
import type { LibraryDatabase } from '~/data/db';

export interface OrphanReport {
  readonly orphanKeys: readonly string[];
  readonly orphanBytes: number;
  readonly unreachableBooks: readonly { bookId: string; sha256: string }[];
}

/**
 * Finds stored files that no book references, and books whose file is missing.
 *
 * This is the reconciliation step for the import pipeline: because file writes
 * are content-addressed and therefore idempotent, a crash between writing bytes
 * and committing metadata leaves a harmless unreferenced file rather than a
 * broken book. The report is advisory — nothing is deleted here, because
 * removing bytes is an explicit, confirmed action (ADR 0002).
 */
export async function inspectStorage(
  db: LibraryDatabase,
  store: BookFileStore,
): Promise<OrphanReport> {
  const books = await db.books.toArray();
  const referenced = new Set<string>();
  const unreachableBooks: { bookId: string; sha256: string }[] = [];

  for (const book of books) {
    if (book.lifecycle === 'deleted') continue;
    const key = bookFileKey(book.sha256);
    referenced.add(key);
    if (book.coverKey !== undefined) {
      referenced.add(book.coverKey);
    }
    if (!(await store.has(key))) {
      unreachableBooks.push({ bookId: book.id, sha256: book.sha256 });
    }
  }

  const storedKeys = await store.keys();
  const orphanKeys = storedKeys.filter((key) => !referenced.has(key));

  let orphanBytes = 0;
  for (const key of orphanKeys) {
    if (!isBookFileKey(key) && !isCoverFileKey(key)) continue;
    try {
      const blob = await store.get(key);
      orphanBytes += blob.size;
    } catch {
      // Unreadable entries still count as orphans; size is simply unknown.
    }
  }

  return { orphanKeys, orphanBytes, unreachableBooks };
}

/** Removes the given storage keys. Returns how many were removed. */
export async function removeStoredFiles(
  store: BookFileStore,
  keys: readonly string[],
): Promise<number> {
  let removed = 0;
  for (const key of keys) {
    try {
      await store.remove(key);
      removed += 1;
    } catch {
      // Leaving a file behind is safe; it will be reported again next time.
    }
  }
  return removed;
}
