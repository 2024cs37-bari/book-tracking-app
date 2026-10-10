import { type AnnotationKind } from './enums';
import { assertLocator, type Locator } from './locator';

/**
 * A highlight, note, or bookmark anchored to a position in a book.
 *
 * All three annotation kinds share one shape (DATA-MODEL.md §3): a bookmark is
 * an annotation with no `note` and usually no `textExcerpt`, a highlight adds a
 * colored range, and a note adds user text. Deletion is a tombstone so the
 * mutation can replicate.
 */
export interface Annotation {
  readonly id: string;
  readonly bookId: string;
  readonly kind: AnnotationKind;
  readonly locator: Locator;
  /** The highlighted/surrounding text captured at creation, if any. */
  readonly textExcerpt?: string;
  /** User-authored note body, for note (and optionally highlight) kinds. */
  readonly note?: string;
  /** Highlight color token, e.g. "yellow"; absent for plain bookmarks. */
  readonly color?: string;
  readonly createdHlc: string;
  readonly updatedHlc: string;
  readonly deleted: boolean;
}

export const MAX_ANNOTATION_NOTE_LENGTH = 10_000;
export const MAX_ANNOTATION_EXCERPT_LENGTH = 2_000;

export interface NewAnnotation {
  readonly bookId: string;
  readonly kind: AnnotationKind;
  readonly locator: Locator;
  readonly textExcerpt?: string;
  readonly note?: string;
  readonly color?: string;
}

export function assertNewAnnotation(input: NewAnnotation): void {
  if (input.bookId.trim().length === 0) {
    throw new Error('An annotation must reference a book.');
  }
  assertLocator(input.locator);
  if (input.textExcerpt !== undefined && input.textExcerpt.length > MAX_ANNOTATION_EXCERPT_LENGTH) {
    throw new Error(
      `Annotation excerpt must be ${MAX_ANNOTATION_EXCERPT_LENGTH} characters or fewer.`,
    );
  }
  if (input.note !== undefined && input.note.length > MAX_ANNOTATION_NOTE_LENGTH) {
    throw new Error(`Annotation note must be ${MAX_ANNOTATION_NOTE_LENGTH} characters or fewer.`);
  }
}
