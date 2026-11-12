import {
  DB_SCHEMA_VERSION,
  type AnnotationRow,
  type BookRow,
  type BookTagRow,
  type ProgressRow,
  type SessionRow,
  type ShelfBookRow,
  type ShelfRow,
  type TagRow,
} from '~/data/db';
import { MAX_REPLICATED_ROWS, parseReplicatedRow } from '~/data/replicated-validation';

export const EXPORT_FORMAT = 'book-reader-export';
export const BACKUP_LIMITS = Object.freeze({
  archiveBytes: 128 * 1024 * 1024,
  metadataBytes: 8 * 1024 * 1024,
  originalBytes: 64 * 1024 * 1024,
  coverBytes: 4 * 1024 * 1024,
  entries: 10_002,
  rows: MAX_REPLICATED_ROWS,
});

export interface LibrarySnapshot {
  books: BookRow[];
  progress: ProgressRow[];
  annotations: AnnotationRow[];
  shelves: ShelfRow[];
  shelfBooks: ShelfBookRow[];
  tags: TagRow[];
  bookTags: BookTagRow[];
  sessions: SessionRow[];
}

export const SNAPSHOT_TABLES = [
  'books',
  'progress',
  'annotations',
  'shelves',
  'shelfBooks',
  'tags',
  'bookTags',
  'sessions',
] as const;
export type SnapshotTable = (typeof SNAPSHOT_TABLES)[number];

type ObjectRow = Record<string, unknown>;
function invalid(path: string): never {
  throw new Error(`Invalid backup: ${path}.`);
}
function object(value: unknown, path: string): ObjectRow {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    invalid(`${path} must be an object`);
  return value as ObjectRow;
}

export function snapshotKey(
  table: SnapshotTable,
  row: LibrarySnapshot[SnapshotTable][number],
): string {
  if (table === 'shelfBooks' && 'shelfId' in row) return `${row.shelfId}:${row.bookId}`;
  if (table === 'bookTags' && 'tagId' in row) return `${row.tagId}:${row.bookId}`;
  if ('id' in row) return row.id;
  return row.bookId;
}

/** Validate and project every field; never persist a cast of user-controlled JSON. */
export function parseMetadataExport(json: string, now = Date.now()): LibrarySnapshot {
  if (new TextEncoder().encode(json).byteLength > BACKUP_LIMITS.metadataBytes)
    invalid('metadata exceeds the 8 MiB limit');
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error('The backup file is not valid JSON.');
  }
  const payload = object(value, 'document');
  if (payload.format !== EXPORT_FORMAT) throw new Error('This file is not a book-reader export.');
  if (typeof payload.schemaVersion === 'number' && payload.schemaVersion > DB_SCHEMA_VERSION)
    throw new Error(
      `The backup was made with a newer app version (schema ${payload.schemaVersion}); update before restoring.`,
    );
  if (payload.schemaVersion !== 1 && payload.schemaVersion !== DB_SCHEMA_VERSION)
    invalid('unsupported schemaVersion');
  let total = 0;
  function rows<T>(key: SnapshotTable, parse: (row: ObjectRow, now: number) => T): T[] {
    const value =
      payload[key] === undefined &&
      payload.schemaVersion === 1 &&
      key !== 'books' &&
      key !== 'progress'
        ? []
        : payload[key];
    if (!Array.isArray(value)) invalid(`${key} must be an array`);
    total += value.length;
    if (total > BACKUP_LIMITS.rows) invalid('too many metadata rows');
    return value.map((item) => {
      try {
        return parse(object(item, `${key} row`), now);
      } catch (error) {
        invalid(error instanceof Error ? error.message : `invalid ${key} row`);
      }
    });
  }
  const snapshot: LibrarySnapshot = {
    books: rows('books', (row, now) => parseReplicatedRow('book', row, now)),
    progress: rows('progress', (row, now) => parseReplicatedRow('progress', row, now)),
    annotations: rows('annotations', (row, now) => parseReplicatedRow('annotation', row, now)),
    shelves: rows('shelves', (row, now) => parseReplicatedRow('shelf', row, now)),
    shelfBooks: rows('shelfBooks', (row, now) => parseReplicatedRow('shelf_book', row, now)),
    tags: rows('tags', (row, now) => parseReplicatedRow('tag', row, now)),
    bookTags: rows('bookTags', (row, now) => parseReplicatedRow('book_tag', row, now)),
    sessions: rows('sessions', (row, now) => parseReplicatedRow('session', row, now)),
  };
  for (const table of SNAPSHOT_TABLES) {
    const keys = snapshot[table].map((row) => snapshotKey(table, row));
    if (new Set(keys).size !== keys.length) invalid(`duplicate ${table} identity`);
  }
  if (new Set(snapshot.books.map((book) => book.sha256)).size !== snapshot.books.length)
    invalid('duplicate book content hash');
  const bookIds = new Set(snapshot.books.map((book) => book.id));
  const shelfIds = new Set(snapshot.shelves.map((shelf) => shelf.id));
  const tagIds = new Set(snapshot.tags.map((tag) => tag.id));
  for (const row of [
    ...snapshot.progress,
    ...snapshot.annotations,
    ...snapshot.shelfBooks,
    ...snapshot.bookTags,
    ...snapshot.sessions,
  ]) {
    if (!bookIds.has(row.bookId)) invalid(`orphan book reference ${row.bookId}`);
  }
  if (snapshot.shelfBooks.some((row) => !shelfIds.has(row.shelfId)))
    invalid('orphan shelf reference');
  if (snapshot.bookTags.some((row) => !tagIds.has(row.tagId))) invalid('orphan tag reference');
  return snapshot;
}
