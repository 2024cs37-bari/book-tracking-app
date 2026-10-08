import { AppError } from '~/domain/errors';
import { formatHlc } from '~/domain/hlc';
import type { Book, BookLifecycle } from '~/domain/book';
import {
  assertBookInput,
  toBook,
  type BookMetadataPatch,
  type BookSort,
  type ListBooksOptions,
  type NewBook,
} from '../book-mapping';
import type { BookRow, LibraryDatabase } from '../db';
import { makeChangeRow, type MutationContext } from '../mutations';

/**
 * Reads and writes book metadata.
 *
 * Queries load rows and filter in memory. The library is a single user's
 * collection and lives entirely on the device, so this is bounded and simple;
 * if it ever becomes a bottleneck, the same interface can serve an
 * index-backed implementation without touching callers.
 */
export class BookRepository {
  constructor(
    private readonly db: LibraryDatabase,
    private readonly context: MutationContext,
  ) {}

  async list(options: ListBooksOptions = {}): Promise<Book[]> {
    const lifecycle = options.lifecycle ?? 'active';
    const search = options.search?.trim().toLowerCase() ?? '';

    let rows = await this.db.books.toArray();
    if (lifecycle !== 'all') {
      rows = rows.filter((row) => row.lifecycle === lifecycle);
    }
    if (options.format !== undefined) {
      rows = rows.filter((row) => row.format === options.format);
    }
    if (search.length > 0) {
      rows = rows.filter((row) => matchesSearch(row, search));
    }

    return sortRows(rows, options.sort ?? 'title').map(toBook);
  }

  async getById(id: string): Promise<Book | undefined> {
    const row = await this.db.books.get(id);
    return row === undefined ? undefined : toBook(row);
  }

  async findBySha256(sha256: string): Promise<Book | undefined> {
    const row = await this.db.books.where('sha256').equals(sha256).first();
    return row === undefined ? undefined : toBook(row);
  }

  async countByLifecycle(): Promise<Record<BookLifecycle | 'total', number>> {
    const rows = await this.db.books.toArray();
    const counts = { active: 0, archived: 0, deleted: 0, total: rows.length };
    for (const row of rows) {
      counts[row.lifecycle] += 1;
    }
    return counts;
  }

  /** Total bytes of original files referenced by the library. */
  async referencedBytes(): Promise<number> {
    const rows = await this.db.books.toArray();
    return rows.reduce((total, row) => total + row.sizeBytes, 0);
  }

  /**
   * Records a new book and its outbox entry in one transaction.
   *
   * Callers that need the write to also cover progress (the import pipeline)
   * wrap this in their own Dexie transaction; Dexie reuses the enclosing
   * transaction rather than nesting a new one.
   */
  async insert(input: NewBook): Promise<Book> {
    assertBookInput(input);
    const row: BookRow = {
      id: input.id,
      sha256: input.sha256,
      title: input.title,
      author: input.author,
      language: input.language,
      format: input.format,
      sizeBytes: input.sizeBytes,
      coverKey: input.coverKey,
      isbn: input.isbn,
      publisher: input.publisher,
      pageCount: input.pageCount,
      metadataIncomplete: input.metadataIncomplete,
      lifecycle: 'active',
      addedAt: Date.now(),
      updatedHlc: formatHlc(this.context.clock.next()),
    };

    await this.db.transaction('rw', this.db.books, this.db.changes, async () => {
      await this.db.books.add(row);
      await this.db.changes.add(makeChangeRow(this.context, 'book', row.id, 'upsert', row));
    });

    return toBook(row);
  }

  /**
   * Moves a book between active, archived and deleted.
   *
   * Nothing here removes bytes: file deletion is a separate, explicit action
   * (see docs/decisions/0002-data-lifecycle.md).
   */
  async setLifecycle(id: string, lifecycle: BookLifecycle): Promise<Book> {
    return this.db.transaction('rw', this.db.books, this.db.changes, async () => {
      const row = await this.db.books.get(id);
      if (row === undefined) {
        throw new AppError('not_found', `Book ${id} is not in the library.`);
      }

      const now = Date.now();
      const next: BookRow = { ...row, lifecycle, updatedHlc: formatHlc(this.context.clock.next()) };

      // Timestamps are indexed, so they must be removed rather than set to
      // null when a book returns to the active state.
      if (lifecycle === 'archived') {
        next.archivedAt = now;
        delete next.deletedAt;
      } else if (lifecycle === 'deleted') {
        next.deletedAt = now;
        delete next.archivedAt;
      } else {
        delete next.archivedAt;
        delete next.deletedAt;
      }

      await this.db.books.put(next);
      await this.db.changes.add(makeChangeRow(this.context, 'book', id, 'upsert', next));
      return toBook(next);
    });
  }

  async updateMetadata(id: string, patch: BookMetadataPatch): Promise<Book> {
    return this.db.transaction('rw', this.db.books, this.db.changes, async () => {
      const row = await this.db.books.get(id);
      if (row === undefined) {
        throw new AppError('not_found', `Book ${id} is not in the library.`);
      }

      const next: BookRow = {
        ...row,
        ...patch,
        updatedHlc: formatHlc(this.context.clock.next()),
      };
      await this.db.books.put(next);
      await this.db.changes.add(makeChangeRow(this.context, 'book', id, 'upsert', next));
      return toBook(next);
    });
  }
}

function matchesSearch(row: BookRow, lowercaseQuery: string): boolean {
  const haystacks = [row.title, row.author, row.publisher, row.isbn, row.language];
  return haystacks.some(
    (value) => typeof value === 'string' && value.toLowerCase().includes(lowercaseQuery),
  );
}

function sortRows(rows: BookRow[], sort: BookSort): BookRow[] {
  const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
  const sorted = [...rows];
  switch (sort) {
    case 'title':
      sorted.sort((left, right) => collator.compare(left.title, right.title));
      break;
    case 'author':
      sorted.sort((left, right) => {
        const byAuthor = collator.compare(left.author ?? '\uffff', right.author ?? '\uffff');
        return byAuthor !== 0 ? byAuthor : collator.compare(left.title, right.title);
      });
      break;
    case 'added_desc':
      sorted.sort((left, right) => right.addedAt - left.addedAt);
      break;
    case 'added_asc':
      sorted.sort((left, right) => left.addedAt - right.addedAt);
      break;
  }
  return sorted;
}
