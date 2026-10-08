import type { Book, BookLifecycle } from '~/domain/book';
import type { BookFormat } from '~/domain/enums';
import { assertSha256Hex } from '~/domain/ids';
import type { BookRow } from './db';

export function toBook(row: BookRow): Book {
  return {
    id: row.id,
    sha256: row.sha256,
    title: row.title,
    author: row.author,
    language: row.language,
    format: row.format,
    sizeBytes: row.sizeBytes,
    coverKey: row.coverKey,
    isbn: row.isbn,
    publisher: row.publisher,
    pageCount: row.pageCount,
    metadataIncomplete: row.metadataIncomplete,
    lifecycle: row.lifecycle,
    addedAt: row.addedAt,
    updatedHlc: row.updatedHlc,
    archivedAt: row.archivedAt,
    deletedAt: row.deletedAt,
  };
}

export type BookSort = 'title' | 'author' | 'added_desc' | 'added_asc';

export interface ListBooksOptions {
  readonly search?: string;
  readonly lifecycle?: BookLifecycle | 'all';
  readonly format?: BookFormat;
  readonly sort?: BookSort;
}

/**
 * Fields a caller may change on an existing book. Deliberately excludes
 * `sha256` (content identity), `lifecycle` (has explicit transition methods)
 * and `updatedHlc` (owned by the clock).
 */
export interface BookMetadataPatch {
  title?: string;
  author?: string;
  language?: string;
  isbn?: string;
  publisher?: string;
  pageCount?: number;
  coverKey?: string;
  metadataIncomplete?: boolean;
}

/**
 * Values required to record a newly imported book.
 *
 * The id is supplied by the caller because the file store key for a cover is
 * derived from it, and the cover is written before the metadata transaction
 * commits.
 */
export interface NewBook {
  readonly id: string;
  readonly sha256: string;
  readonly title: string;
  readonly author?: string;
  readonly language?: string;
  readonly format: BookFormat;
  readonly sizeBytes: number;
  readonly coverKey?: string;
  readonly isbn?: string;
  readonly publisher?: string;
  readonly pageCount?: number;
  readonly metadataIncomplete: boolean;
}

export function assertBookInput(input: NewBook): void {
  assertSha256Hex(input.sha256);
  if (input.sizeBytes < 0) {
    throw new Error('Imported file size must not be negative.');
  }
  if (input.title.trim().length === 0) {
    throw new Error('Book title must not be empty.');
  }
}
