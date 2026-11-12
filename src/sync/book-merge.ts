import { compareHlc, parseHlc } from '~/domain/hlc';
import type { BookRow } from '~/data/db';

export const BOOK_METADATA_FIELDS = [
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
] as const;

/** Capture legacy provenance before the aggregate row HLC advances during a merge. */
export function bookMetadataClocks(row: BookRow): Record<string, string> {
  const clocks = { ...row.metadataHlcs };
  for (const field of BOOK_METADATA_FIELDS) {
    if (clocks[field] === undefined && row[field] !== undefined && row[field] !== '')
      clocks[field] = row.updatedHlc;
  }
  return clocks;
}
function compare(a: string | undefined, b: string | undefined): number {
  if (a === b) return 0;
  const left = a === undefined ? null : parseHlc(a);
  const right = b === undefined ? null : parseHlc(b);
  if (!left) return -1;
  if (!right) return 1;
  return compareHlc(left, right);
}
/** Associative field registers, including explicit field clearing and lifecycle timestamps. */
export function mergeBook(local: BookRow, remote: BookRow): BookRow {
  const lc = bookMetadataClocks(local);
  const rc = bookMetadataClocks(remote);
  const merged = { ...local, metadataHlcs: { ...lc } };
  for (const field of BOOK_METADATA_FIELDS) {
    const order = compare(rc[field], lc[field]);
    const value = (row: BookRow) =>
      field === 'lifecycle'
        ? [row.lifecycle, row.archivedAt ?? null, row.deletedAt ?? null]
        : (row[field] ?? null);
    const useRemote =
      order > 0 || (order === 0 && JSON.stringify(value(remote)) > JSON.stringify(value(local)));
    if (useRemote) {
      Object.assign(merged, { [field]: remote[field] });
      if (rc[field] !== undefined) merged.metadataHlcs[field] = rc[field];
      if (field === 'lifecycle') {
        merged.archivedAt = remote.archivedAt;
        merged.deletedAt = remote.deletedAt;
      }
    }
  }
  merged.updatedHlc =
    compare(remote.updatedHlc, local.updatedHlc) > 0 ? remote.updatedHlc : local.updatedHlc;
  merged.addedAt = Math.min(local.addedAt, remote.addedAt);
  // Extraction completeness is monotonic even across older importing clients.
  merged.metadataIncomplete = local.metadataIncomplete && remote.metadataIncomplete;
  return merged;
}
