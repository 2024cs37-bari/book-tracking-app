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
 * Case-folds a tag name for de-duplication. Unicode-aware lowercasing plus
 * whitespace collapse means "Sci-Fi" and "sci-fi " resolve to one tag.
 */
export function normalizeTagName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
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
