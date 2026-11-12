import {
  type AnnotationRow,
  type BookRow,
  type BookTagRow,
  type ProgressRow,
  type SessionRow,
  type ShelfBookRow,
  type ShelfRow,
  type TagRow,
  type ReplicatedEntity,
} from './db';
import { isAnnotationKind, isBookFormat, isLocatorKind, isReadingStatus } from '~/domain/enums';
import { compareHlc, MAX_HLC_COUNTER, parseHlc } from '~/domain/hlc';
import { isSha256Hex } from '~/domain/ids';
import {
  isCompatibleTagNormalizedName,
  MAX_COLLECTION_NAME_LENGTH,
  MAX_NORMALIZED_TAG_NAME_LENGTH,
  normalizeTagName,
} from '~/domain/collections';
import { MAX_LOCATOR_VALUE_LENGTH, parsePdfLocator, parsePdfHighlight } from '~/domain/locator';
import { MAX_ANNOTATION_NOTE_LENGTH, MAX_ANNOTATION_EXCERPT_LENGTH } from '~/domain/annotation';
import { MAX_SESSION_DURATION_S } from '~/domain/session';

export const MAX_REPLICATED_ROWS = 100_000;
const MAX_DATE_MS = 8_640_000_000_000_000;

type ObjectRow = Record<string, unknown>;
function invalid(path: string): never {
  throw new Error(`Invalid library record: ${path}.`);
}
function object(value: unknown, path: string): ObjectRow {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    invalid(`${path} must be an object`);
  return value as ObjectRow;
}
function string(row: ObjectRow, key: string, max = 512, allowEmpty = false): string {
  const value = row[key];
  if (
    typeof value !== 'string' ||
    value.length > max ||
    (!allowEmpty && !value.trim()) ||
    value.includes('\u0000')
  )
    invalid(`${key} must be valid text (at most ${max} characters)`);
  return value;
}
function optionalString(row: ObjectRow, key: string, max = 512): string | undefined {
  return row[key] === undefined ? undefined : string(row, key, max, true);
}
function id(row: ObjectRow, key: string): string {
  const value = string(row, key, 128);
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) invalid(`${key} contains unsafe identifier characters`);
  return value;
}
function number(
  row: ObjectRow,
  key: string,
  max = Number.MAX_SAFE_INTEGER,
  integer = true,
): number {
  const value = row[key];
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > max ||
    (integer && !Number.isSafeInteger(value))
  )
    invalid(
      `${key} must be a nonnegative ${integer ? 'integer' : 'number'} no greater than ${max}`,
    );
  return value;
}
function optionalNumber(
  row: ObjectRow,
  key: string,
  max?: number,
  integer = true,
): number | undefined {
  return row[key] === undefined ? undefined : number(row, key, max, integer);
}
function boolean(row: ObjectRow, key: string): boolean {
  if (typeof row[key] !== 'boolean') invalid(`${key} must be true or false`);
  return row[key];
}
function hlc(row: ObjectRow, key: string, now: number): string {
  const value = string(row, key, 180);
  const parsed = parseHlc(value);
  // Leave ample counter room for recovery mutations; reject clock poisoning.
  if (
    !parsed ||
    parsed.counter > MAX_HLC_COUNTER - MAX_REPLICATED_ROWS * 4 ||
    parsed.wallMs > now + 86_400_000 ||
    !/^[a-zA-Z0-9_-]+$/.test(parsed.deviceId)
  )
    invalid(`${key} is invalid or more than 24 hours in the future`);
  return value;
}
function optionalHlc(row: ObjectRow, key: string, now: number): string | undefined {
  return row[key] === undefined ? undefined : hlc(row, key, now);
}
function locator(
  row: ObjectRow,
  optional = false,
): { locatorKind?: 'cfi' | 'pdf'; locatorValue?: string } {
  if (optional && row.locatorKind === undefined && row.locatorValue === undefined) return {};
  if (!isLocatorKind(row.locatorKind)) invalid('locatorKind');
  const value = string(row, 'locatorValue', MAX_LOCATOR_VALUE_LENGTH);
  if (
    row.locatorKind === 'pdf' &&
    (!parsePdfLocator(value) ||
      (value.split(':').length !== 2 &&
        (value.split(':').length !== 4 || !parsePdfHighlight(value))))
  )
    invalid('PDF locator must be a page and offset, with an optional highlight range');
  if (row.locatorKind === 'cfi' && !value.startsWith('epubcfi('))
    invalid('EPUB locator must be a CFI');
  return { locatorKind: row.locatorKind, locatorValue: value };
}
const BOOK_CLOCK_FIELDS = new Set([
  'title',
  'author',
  'language',
  'coverKey',
  'isbn',
  'publisher',
  'pageCount',
  'metadataIncomplete',
  'lifecycle',
  'format',
  'sizeBytes',
  'addedAt',
]);
function bookMetadataClocks(
  row: ObjectRow,
  now: number,
): { metadataHlcs?: Record<string, string> } {
  if (row.metadataHlcs === undefined) return {};
  const clocks = object(row.metadataHlcs, 'metadataHlcs');
  const result: Record<string, string> = {};
  for (const key of Object.keys(clocks)) {
    if (!BOOK_CLOCK_FIELDS.has(key)) invalid('unknown metadata clock field');
    result[key] = hlc(clocks, key, now);
  }
  return { metadataHlcs: result };
}
function parseBook(row: ObjectRow, now: number): BookRow {
  const bookId = id(row, 'id');
  if (!isSha256Hex(row.sha256)) invalid('book sha256');
  if (!isBookFormat(row.format)) invalid('book format');
  if (row.lifecycle !== 'active' && row.lifecycle !== 'archived' && row.lifecycle !== 'deleted')
    invalid('book lifecycle');
  const coverKey = optionalString(row, 'coverKey', 160);
  if (coverKey !== undefined && !/^covers\/[a-zA-Z0-9_-]{1,128}\.[a-z0-9]+$/.test(coverKey))
    invalid('book coverKey');
  const archivedAt = optionalNumber(row, 'archivedAt', MAX_DATE_MS);
  const deletedAt = optionalNumber(row, 'deletedAt', MAX_DATE_MS);
  if (
    (row.lifecycle === 'active' && (archivedAt !== undefined || deletedAt !== undefined)) ||
    (row.lifecycle === 'archived' && (archivedAt === undefined || deletedAt !== undefined)) ||
    (row.lifecycle === 'deleted' && (deletedAt === undefined || archivedAt !== undefined))
  )
    invalid('book lifecycle timestamps');
  return {
    id: bookId,
    ...bookMetadataClocks(row, now),
    sha256: row.sha256,
    title: string(row, 'title'),
    author: optionalString(row, 'author'),
    language: optionalString(row, 'language'),
    format: row.format,
    sizeBytes: number(row, 'sizeBytes'),
    coverKey,
    isbn: optionalString(row, 'isbn'),
    publisher: optionalString(row, 'publisher'),
    pageCount: optionalNumber(row, 'pageCount'),
    metadataIncomplete: boolean(row, 'metadataIncomplete'),
    lifecycle: row.lifecycle,
    addedAt: number(row, 'addedAt', MAX_DATE_MS),
    updatedHlc: hlc(row, 'updatedHlc', now),
    archivedAt,
    deletedAt,
  };
}
function parseProgress(row: ObjectRow, now: number): ProgressRow {
  if (!isReadingStatus(row.status)) invalid('progress status');
  return {
    bookId: id(row, 'bookId'),
    status: row.status,
    ...locator(row, true),
    fraction: number(row, 'fraction', 1, false),
    updatedHlc: hlc(row, 'updatedHlc', now),
    deviceId: id(row, 'deviceId'),
  };
}
function parseAnnotation(row: ObjectRow, now: number): AnnotationRow {
  if (!isAnnotationKind(row.kind)) invalid('annotation kind');
  const position = locator(row);
  const createdHlc = hlc(row, 'createdHlc', now);
  const updatedHlc = hlc(row, 'updatedHlc', now);
  if (compareHlc(parseHlc(createdHlc)!, parseHlc(updatedHlc)!) > 0)
    invalid('annotation creation is later than its update');
  return {
    id: id(row, 'id'),
    bookId: id(row, 'bookId'),
    kind: row.kind,
    locatorKind: position.locatorKind!,
    locatorValue: position.locatorValue!,
    fraction: number(row, 'fraction', 1, false),
    textExcerpt: optionalString(row, 'textExcerpt', MAX_ANNOTATION_EXCERPT_LENGTH),
    note: optionalString(row, 'note', MAX_ANNOTATION_NOTE_LENGTH),
    color: optionalString(row, 'color', 64),
    createdHlc,
    updatedHlc,
    deleted: boolean(row, 'deleted'),
  };
}
function parseShelf(row: ObjectRow, now: number): ShelfRow {
  return {
    id: id(row, 'id'),
    name: string(row, 'name', MAX_COLLECTION_NAME_LENGTH),
    updatedHlc: hlc(row, 'updatedHlc', now),
    deleted: boolean(row, 'deleted'),
  };
}
function parseTag(row: ObjectRow, now: number): TagRow {
  const shelf = parseShelf(row, now);
  const normalizedName = string(row, 'normalizedName', MAX_NORMALIZED_TAG_NAME_LENGTH);
  if (!isCompatibleTagNormalizedName(shelf.name, normalizedName))
    invalid('tag normalizedName does not match its name');
  return { ...shelf, normalizedName: normalizeTagName(shelf.name) };
}
function parseShelfBook(row: ObjectRow, now: number): ShelfBookRow {
  return {
    shelfId: id(row, 'shelfId'),
    bookId: id(row, 'bookId'),
    addedHlc: hlc(row, 'addedHlc', now),
    removedHlc: optionalHlc(row, 'removedHlc', now),
  };
}
function parseBookTag(row: ObjectRow, now: number): BookTagRow {
  return {
    tagId: id(row, 'tagId'),
    bookId: id(row, 'bookId'),
    addedHlc: hlc(row, 'addedHlc', now),
    removedHlc: optionalHlc(row, 'removedHlc', now),
  };
}
function parseSession(row: ObjectRow): SessionRow {
  return {
    id: id(row, 'id'),
    bookId: id(row, 'bookId'),
    startedAt: number(row, 'startedAt', MAX_DATE_MS - MAX_SESSION_DURATION_S * 1000),
    durationS: number(row, 'durationS', MAX_SESSION_DURATION_S),
    startFraction: optionalNumber(row, 'startFraction', 1, false),
    endFraction: optionalNumber(row, 'endFraction', 1, false),
    deviceId: id(row, 'deviceId'),
  };
}

export interface ReplicatedRows {
  book: BookRow;
  progress: ProgressRow;
  annotation: AnnotationRow;
  shelf: ShelfRow;
  shelf_book: ShelfBookRow;
  tag: TagRow;
  book_tag: BookTagRow;
  session: SessionRow;
}

const parsers = {
  book: parseBook,
  progress: parseProgress,
  annotation: parseAnnotation,
  shelf: parseShelf,
  shelf_book: parseShelfBook,
  tag: parseTag,
  book_tag: parseBookTag,
  session: parseSession,
};

/** Project one bounded schema-2 row; graph validation belongs to complete snapshots. */
export function parseReplicatedRow<E extends ReplicatedEntity>(
  entity: E,
  value: unknown,
  now = Date.now(),
): ReplicatedRows[E] {
  const row = parsers[entity](object(value, entity), now);
  if (
    'metadataHlcs' in row &&
    Object.values(row.metadataHlcs ?? {}).some(
      (stamp) => compareHlc(parseHlc(stamp)!, parseHlc(row.updatedHlc)!) > 0,
    )
  )
    invalid('metadata field clock exceeds the book update clock');
  return row as ReplicatedRows[E];
}

/** Same clock bounds for payload provenance, backup rows and wire envelopes. */
export function validateReplicatedHlc(value: unknown, now = Date.now()): string {
  return hlc({ hlc: value }, 'hlc', now);
}
