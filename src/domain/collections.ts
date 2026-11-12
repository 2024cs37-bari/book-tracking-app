/**
 * User collections: named shelves and reusable tags, plus their book
 * memberships. Memberships are modeled with add/remove HLCs rather than hard
 * deletes (DATA-MODEL.md §5): a membership is active when it has no removal
 * newer than its add, which lets two devices converge on re-adds and removals
 * without losing history.
 */

import { compareHlc, parseHlc } from './hlc';

export interface Shelf {
  readonly id: string;
  readonly name: string;
  readonly updatedHlc: string;
  readonly deleted: boolean;
}

export interface Tag {
  readonly id: string;
  readonly name: string;
  /** Case-folded name used for de-duplication and lookup. */
  readonly normalizedName: string;
  readonly updatedHlc: string;
  readonly deleted: boolean;
}

export interface ShelfBook {
  readonly shelfId: string;
  readonly bookId: string;
  readonly addedHlc: string;
  readonly removedHlc?: string;
}

export interface BookTag {
  readonly tagId: string;
  readonly bookId: string;
  readonly addedHlc: string;
  readonly removedHlc?: string;
}

export const MAX_COLLECTION_NAME_LENGTH = 200;
// Unicode lowercasing can expand one display character into several code units.
export const MAX_NORMALIZED_TAG_NAME_LENGTH = MAX_COLLECTION_NAME_LENGTH * 3;

/** A membership is active when it has no removal at or after its latest add. */
export function isMembershipActive(membership: {
  readonly addedHlc: string;
  readonly removedHlc?: string;
}): boolean {
  if (membership.removedHlc === undefined) return true;
  const added = parseHlc(membership.addedHlc);
  const removed = parseHlc(membership.removedHlc);
  // A re-add after a removal carries a newer add HLC and wins. If either HLC
  // is unparseable, treat the row conservatively as removed.
  return added !== null && removed !== null && compareHlc(added, removed) > 0;
}

/**
 * Produces a locale-independent lookup key. Unicode default lowercasing plus
 * whitespace collapse means "Sci-Fi" and "sci-fi " resolve to one tag on every
 * device, including devices whose UI locale has different casing rules.
 */
export function normalizeTagName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Accept keys written by the pre-v4 ambient-locale normalizer during recovery/sync. */
export function isCompatibleTagNormalizedName(name: string, normalized: string): boolean {
  const clean = name.trim().replace(/\s+/g, ' ');
  // Unicode's locale-sensitive lowercasing rules differ for Turkish/Azeri and
  // Lithuanian. Explicit locales keep compatibility independent of this device.
  return (
    normalizeTagName(name) === normalized ||
    clean.toLocaleLowerCase('tr') === normalized ||
    clean.toLocaleLowerCase('lt') === normalized
  );
}

export function assertCollectionName(name: string, label: string): string {
  const trimmed = name.trim().replace(/\s+/g, ' ');
  if (trimmed.length === 0) {
    throw new Error(`${label} name must not be empty.`);
  }
  if (trimmed.length > MAX_COLLECTION_NAME_LENGTH) {
    throw new Error(`${label} name must be ${MAX_COLLECTION_NAME_LENGTH} characters or fewer.`);
  }
  return trimmed;
}
