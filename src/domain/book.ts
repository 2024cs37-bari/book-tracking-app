import { BOOK_FORMAT_LABELS, renderSupport, type BookFormat, type RenderSupport } from './enums';
import { assertSha256Hex } from './ids';

/**
 * Lifecycle is stored explicitly (rather than being derived from timestamps)
 * so it can be indexed: IndexedDB cannot index null or undefined values, and
 * every library query needs to filter on it.
 */
export type BookLifecycle = 'active' | 'archived' | 'deleted';

export interface Book {
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
  readonly lifecycle: BookLifecycle;
  readonly addedAt: number;
  readonly updatedHlc: string;
  readonly archivedAt?: number;
  readonly deletedAt?: number;
}

const MAX_TITLE_LENGTH = 512;

/**
 * Derives a readable title from a filename. Used when embedded metadata is
 * missing or unparseable, which is expected rather than exceptional.
 */
export function titleFromFilename(filename: string): string {
  const basename = filename.split(/[\\/]/).pop() ?? filename;
  const withoutExtension = basename.replace(/\.[^.]+$/, '');
  const cleaned = withoutExtension.replace(/[_+]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned.length === 0) return 'Untitled';
  return cleaned.slice(0, MAX_TITLE_LENGTH);
}

export function formatLabel(format: BookFormat): string {
  return BOOK_FORMAT_LABELS[format];
}

export function supportLabel(format: BookFormat): string {
  const support: RenderSupport = renderSupport(format);
  return support === 'supported'
    ? 'Supported'
    : support === 'experimental'
      ? 'Experimental'
      : 'Not yet readable';
}

export function displayAuthor(book: Book): string {
  const author = book.author?.trim();
  return author && author.length > 0 ? author : 'Unknown author';
}

export function displayPublisher(book: Book): string {
  const publisher = book.publisher?.trim();
  return publisher && publisher.length > 0 ? publisher : 'Unknown publisher';
}

/** Active books appear in the library; archived and deleted books do not. */
export function isVisible(book: Book): boolean {
  return book.lifecycle === 'active';
}

export function assertBookConsistent(book: Book): void {
  assertSha256Hex(book.sha256);
  if (book.sizeBytes < 0) {
    throw new Error('Book size must not be negative.');
  }
}
