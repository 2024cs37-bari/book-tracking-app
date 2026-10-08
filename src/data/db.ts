import Dexie, { type Table } from 'dexie';
import type { BookLifecycle } from '~/domain/book';
import type { BookFormat, LocatorKind, ReadingStatus } from '~/domain/enums';

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

export const DB_SCHEMA_VERSION = 1;
export const DEFAULT_DB_NAME = 'book-reader';

export class LibraryDatabase extends Dexie {
  books!: Table<BookRow, string>;
  progress!: Table<ProgressRow, string>;
  changes!: Table<ChangeRow, string>;
  syncMeta!: Table<SyncMetaRow, string>;
  deviceState!: Table<DeviceStateRow, string>;
  fileTransfers!: Table<FileTransferRow, string>;

  constructor(name: string = DEFAULT_DB_NAME) {
    super(name);

    // Every schema version must be declared here and never edited after
    // release: Dexie replays upgrades for clients that skipped versions. See
    // docs/OPERATIONS.md for the migration rules.
    this.version(DB_SCHEMA_VERSION).stores({
      books: 'id, &sha256, title, format, lifecycle, addedAt',
      progress: 'bookId, status, updatedHlc',
      changes: 'id, entity, entityId, pushedAt, createdAt',
      syncMeta: 'key',
      deviceState: 'bookId, lastOpenedAt, pinnedOffline',
      fileTransfers: 'id, sha256, direction, state, updatedAt',
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
];

export function createDatabase(name?: string): LibraryDatabase {
  return new LibraryDatabase(name);
}
