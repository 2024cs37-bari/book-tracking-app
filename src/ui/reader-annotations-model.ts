import type { Annotation } from '~/domain/annotation';
import type { AnnotationKind } from '~/domain/enums';

/**
 * Framework-free model helpers for the annotations panel. They live in their
 * own module (not the `.tsx`) so they can be unit-tested under the test
 * tsconfig, which does not enable JSX. {@link ReaderAnnotations} re-exports
 * them for callers.
 */

/**
 * A highlight colour offered by the recolour palette. The tokens mirror the
 * renderer colour maps (see pdf-renderer.ts / epub-renderer.ts) so a swatch
 * chosen here renders identically in the book.
 */
export interface HighlightColour {
  readonly token: string;
  readonly label: string;
  readonly css: string;
}

export const HIGHLIGHT_PALETTE: readonly HighlightColour[] = [
  { token: 'yellow', label: 'Yellow', css: '#f6c744' },
  { token: 'green', label: 'Green', css: '#5bd08a' },
  { token: 'blue', label: 'Blue', css: '#5aa9f6' },
  { token: 'pink', label: 'Pink', css: '#f67ab5' },
];

const PALETTE_CSS: Record<string, string> = Object.fromEntries(
  HIGHLIGHT_PALETTE.map((colour) => [colour.token, colour.css]),
);

/**
 * Resolve a stored colour token to a concrete CSS colour. An unknown token is
 * used verbatim (so a future custom colour still renders) and an absent one
 * falls back to yellow, matching the renderers' default.
 */
export function highlightCss(token: string | undefined): string {
  if (token === undefined || token === '') return PALETTE_CSS.yellow ?? '#f6c744';
  return PALETTE_CSS[token] ?? token;
}

export type KindFilter = 'all' | AnnotationKind;
export type ColourFilter = 'all' | string;

export const KIND_FILTERS: readonly { readonly id: KindFilter; readonly label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'highlight', label: 'Highlights' },
  { id: 'note', label: 'Notes' },
  { id: 'bookmark', label: 'Bookmarks' },
];

const KIND_LABELS: Record<AnnotationKind, string> = {
  highlight: 'Highlight',
  note: 'Note',
  bookmark: 'Bookmark',
};

export function kindLabel(kind: AnnotationKind): string {
  return KIND_LABELS[kind];
}

/**
 * Non-deleted annotations ordered by reading position (ascending fraction).
 * Pure, so it is unit-tested directly.
 */
export function sortByFraction(annotations: readonly Annotation[]): Annotation[] {
  return annotations
    .filter((annotation) => !annotation.deleted)
    .slice()
    .sort((a, b) => a.locator.fraction - b.locator.fraction);
}

/** Apply the kind and colour filters. Pure, so it is unit-tested directly. */
export function filterAnnotations(
  annotations: readonly Annotation[],
  kind: KindFilter,
  colour: ColourFilter,
): Annotation[] {
  return annotations.filter((annotation) => {
    if (kind !== 'all' && annotation.kind !== kind) return false;
    if (colour !== 'all' && annotation.color !== colour) return false;
    return true;
  });
}
