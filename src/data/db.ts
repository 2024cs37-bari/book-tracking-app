import Dexie, { type Table } from 'dexie';
import type { BookLifecycle } from '~/domain/book';
import type { AnnotationKind, BookFormat, LocatorKind, ReadingStatus } from '~/domain/enums';

/**
 * Dexie row types.
 *
 * These mirror the logical schema in docs/DATA-MODEL.md using camelCase field
 * names. Booleans are stored as real booleans; fields that need to be indexed
 * never use booleans or nullable values, because IndexedDB cannot index them.
 */

/** Entities that participate in synchronization. */
export type ReplicatedEntity =
  'book' | 'progress' | 'annotation' | 'shelf' | 'shelf_book' | 'tag' | 'book_tag' | 'session';

export type ChangeOp = 'upsert' | 'delete';

export interface BookRow {
  id: string;
  sha256: string;
  title: string;
  author?: string;
  language?: string;
  format: BookFormat;
  sizeBytes: number;
  coverKey?: string;
  isbn?: string;
  publisher?: string;
  pageCount?: number;
  metadataIncomplete: boolean;
  /** Indexed copy of the lifecycle state; see docs/decisions/0002. */
  lifecycle: BookLifecycle;
  addedAt: number;
  updatedHlc: string;
  archivedAt?: number;
  deletedAt?: number;
}

export interface ProgressRow {
  bookId: string;
  status: ReadingStatus;
  /** Locator fields stay unset until the reader reports a first position. */
  locatorKind?: LocatorKind;
  locatorValue?: string;
  /** Mirrors the locator fraction (0 when there is no position yet). */
  fraction: number;
  updatedHlc: string;
  deviceId: string;
}

/**
 * Local outbox entry. One row per replicated mutation, written in the same
 * transaction as the entity change so a crash can never lose a mutation.
 */
export interface ChangeRow {
  id: string;
  entity: ReplicatedEntity;
  entityId: string;
  op: ChangeOp;
  payload: string;
  hlc: string;
  deviceId: string;
  createdAt: number;
  /** 0 while pending; the acknowledgement timestamp once pushed. */
  pushedAt: number;
}

export interface SyncMetaRow {
  key: string;
  value: string;
}

/** Per-device state. Never replicated: pinning is a local decision. */
export interface DeviceStateRow {
  bookId: string;
  filePresent: boolean;
  pinnedOffline: boolean;
  lastOpenedAt?: number;
}

export type TransferDirection = 'upload' | 'download';
export type TransferState = 'queued' | 'running' | 'failed' | 'complete';

export interface FileTransferRow {
  id: string;
  sha256: string;
  direction: TransferDirection;
  state: TransferState;
  bytesDone: number;
  uploadId?: string;
  partState?: string;
  retryAfter?: number;
  updatedAt: number;
}

/** Highlight, note, or bookmark anchored to a locator (schema v2). */
export interface AnnotationRow {
  id: string;
  bookId: string;
  kind: AnnotationKind;
  locatorKind: LocatorKind;
  locatorValue: string;
  fraction: number;
  textExcerpt?: string;
  note?: string;
  color?: string;
  createdHlc: string;
  updatedHlc: string;
  deleted: boolean;
}

/** Named user collection (schema v2). */
export interface ShelfRow {
  id: string;
  name: string;
  updatedHlc: string;
  deleted: boolean;
}

/** Shelf membership with add/remove ordering (schema v2). */
export interface ShelfBookRow {
  shelfId: string;
  bookId: string;
  addedHlc: string;
  removedHlc?: string;
}

/** Reusable label (schema v2). */
export interface TagRow {
  id: string;
  name: string;
  normalizedName: string;
  updatedHlc: string;
  deleted: boolean;
}

/** Tag membership with add/remove ordering (schema v2). */
export interface BookTagRow {
  tagId: string;
  bookId: string;
  addedHlc: string;
  removedHlc?: string;
}

/** Append-only reading-activity fact (schema v2). */
export interface SessionRow {
  id: string;
  bookId: string;
  startedAt: number;
  durationS: number;
  startFraction?: number;
  endFraction?: number;
  deviceId: string;
}

export const DB_SCHEMA_VERSION = 2;
export const DEFAULT_DB_NAME = 'book-reader';

export class LibraryDatabase extends Dexie {
  books!: Table<BookRow, string>;
  progress!: Table<ProgressRow, string>;
  changes!: Table<ChangeRow, string>;
  syncMeta!: Table<SyncMetaRow, string>;
  deviceState!: Table<DeviceStateRow, string>;
  fileTransfers!: Table<FileTransferRow, string>;
  annotations!: Table<AnnotationRow, string>;
  shelves!: Table<ShelfRow, string>;
  shelfBooks!: Table<ShelfBookRow, [string, string]>;
  tags!: Table<TagRow, string>;
  bookTags!: Table<BookTagRow, [string, string]>;
  sessions!: Table<SessionRow, string>;

  constructor(name: string = DEFAULT_DB_NAME) {
    super(name);

    // Every schema version must be declared here and never edited after
    // release: Dexie replays upgrades for clients that skipped versions. See
    // docs/OPERATIONS.md for the migration rules.
    this.version(1).stores({
      books: 'id, &sha256, title, format, lifecycle, addedAt',
      progress: 'bookId, status, updatedHlc',
      changes: 'id, entity, entityId, pushedAt, createdAt',
      syncMeta: 'key',
      deviceState: 'bookId, lastOpenedAt, pinnedOffline',
      fileTransfers: 'id, sha256, direction, state, updatedAt',
    });

    // v2 adds Phase 2 collections and reading history. Only new tables are
    // declared; v1 tables are inherited unchanged, and no v1 index is edited.
    this.version(2).stores({
      annotations: 'id, bookId, createdHlc, updatedHlc',
      shelves: 'id, name, updatedHlc',
      shelfBooks: '[shelfId+bookId], shelfId, bookId, addedHlc',
      tags: 'id, normalizedName, updatedHlc',
      bookTags: '[tagId+bookId], tagId, bookId, addedHlc',
      sessions: 'id, bookId, startedAt',
    });
  }
}

export interface LocalMigration {
  readonly version: number;
  readonly description: string;
}

/** Documented history, surfaced by the diagnostics view and data exports. */
export const LOCAL_MIGRATIONS: readonly LocalMigration[] = [
  {
    version: 1,
    description:
      'Initial schema: books, progress, changes (outbox), syncMeta, deviceState and fileTransfers.',
  },
  {
    version: 2,
    description:
      'Phase 2 collections and reading history: annotations, shelves, shelfBooks, tags, bookTags and sessions. v1 tables unchanged.',
  },
];

export function createDatabase(name?: string): LibraryDatabase {
  return new LibraryDatabase(name);
}
