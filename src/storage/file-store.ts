import { AppError } from '~/domain/errors';
import { assertSha256Hex } from '~/domain/ids';

export type FileStoreKind = 'opfs' | 'indexeddb' | 'memory';

export interface StoredFileInfo {
  readonly key: string;
  readonly sizeBytes: number;
}

export interface StorageEstimate {
  /** Bytes this origin is currently using, as reported by the browser. */
  readonly usageBytes: number | null;
  /** Bytes available to this origin, as reported by the browser. */
  readonly quotaBytes: number | null;
  /** Whether the browser granted persistent storage. */
  readonly persisted: boolean | null;
}

/**
 * Stores original book bytes and derived cover images.
 *
 * Keys are content-derived, never user-supplied paths, so a hostile filename
 * can never influence where bytes land in the store.
 */
export interface BookFileStore {
  readonly kind: FileStoreKind;
  /** False when the adapter is a non-durable fallback (for example memory). */
  readonly durable: boolean;
  put(key: string, data: Blob): Promise<StoredFileInfo>;
  get(key: string): Promise<Blob>;
  has(key: string): Promise<boolean>;
  remove(key: string): Promise<void>;
  keys(): Promise<string[]>;
  estimate(): Promise<StorageEstimate | null>;
}

const BOOK_PREFIX = 'books';
const COVER_PREFIX = 'covers';

/** Content-addressed key for an original book file. */
export function bookFileKey(sha256: string): string {
  return `${BOOK_PREFIX}/${assertSha256Hex(sha256)}.bin`;
}

/**
 * Key for a cover derivative. Covers are addressed by book id rather than by
 * hash because they are regenerable derivatives, not the source of truth.
 */
export function coverFileKey(bookId: string, extension: string): string {
  const safeExtension = extension.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'bin';
  return `${COVER_PREFIX}/${bookId}.${safeExtension}`;
}

export function isBookFileKey(key: string): boolean {
  return key.startsWith(`${BOOK_PREFIX}/`);
}

export function isCoverFileKey(key: string): boolean {
  return key.startsWith(`${COVER_PREFIX}/`);
}

export function storageUnavailable(message: string, cause?: unknown): AppError {
  return new AppError('storage_unavailable', message, { cause });
}

/** Splits a key into directory segments plus the final entry name. */
export function splitKey(key: string): { directories: string[]; name: string } {
  const segments = key.split('/').filter((segment) => segment.length > 0);
  const name = segments.pop();
  if (name === undefined) {
    throw new AppError('invalid_argument', `Storage key "${key}" is not a valid path.`);
  }
  return { directories: segments, name };
}
