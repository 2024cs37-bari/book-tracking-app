/**
 * Enumerations shared by the local database, the reader and (later) the sync
 * payloads. Values are persisted, so treat them as a compatibility surface:
 * adding is safe, renaming or removing requires a migration.
 */

export const BOOK_FORMATS = ['epub', 'mobi', 'azw3', 'pdf', 'fb2', 'cbz'] as const;
export type BookFormat = (typeof BOOK_FORMATS)[number];

export const READING_STATUSES = ['to_read', 'reading', 'finished', 'abandoned'] as const;
export type ReadingStatus = (typeof READING_STATUSES)[number];

export const ANNOTATION_KINDS = ['highlight', 'note', 'bookmark'] as const;
export type AnnotationKind = (typeof ANNOTATION_KINDS)[number];

export const LOCATOR_KINDS = ['cfi', 'pdf'] as const;
export type LocatorKind = (typeof LOCATOR_KINDS)[number];

/**
 * How much rendering support a format has today. Importing a format and being
 * able to display it reliably are deliberately separate claims.
 */
export type RenderSupport = 'supported' | 'experimental' | 'deferred';

const RENDER_SUPPORT: Record<BookFormat, RenderSupport> = {
  epub: 'supported',
  pdf: 'supported',
  mobi: 'experimental',
  azw3: 'experimental',
  fb2: 'deferred',
  cbz: 'deferred',
};

export function renderSupport(format: BookFormat): RenderSupport {
  return RENDER_SUPPORT[format];
}

export function isReaderSupported(format: BookFormat): boolean {
  return RENDER_SUPPORT[format] === 'supported';
}

export const BOOK_FORMAT_LABELS: Record<BookFormat, string> = {
  epub: 'EPUB',
  mobi: 'MOBI',
  azw3: 'AZW3',
  pdf: 'PDF',
  fb2: 'FB2',
  cbz: 'CBZ',
};

export const READING_STATUS_LABELS: Record<ReadingStatus, string> = {
  to_read: 'To read',
  reading: 'Reading',
  finished: 'Finished',
  abandoned: 'Abandoned',
};

export const RENDER_SUPPORT_LABELS: Record<RenderSupport, string> = {
  supported: 'Reader supported',
  experimental: 'Reader support experimental',
  deferred: 'Reading not implemented',
};

export function isBookFormat(value: unknown): value is BookFormat {
  return typeof value === 'string' && (BOOK_FORMATS as readonly string[]).includes(value);
}

export function isReadingStatus(value: unknown): value is ReadingStatus {
  return typeof value === 'string' && (READING_STATUSES as readonly string[]).includes(value);
}

export function isAnnotationKind(value: unknown): value is AnnotationKind {
  return typeof value === 'string' && (ANNOTATION_KINDS as readonly string[]).includes(value);
}

export function isLocatorKind(value: unknown): value is LocatorKind {
  return typeof value === 'string' && (LOCATOR_KINDS as readonly string[]).includes(value);
}
