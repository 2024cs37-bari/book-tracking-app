import { describe, expect, it } from 'vitest';
import type { Annotation } from '~/domain/annotation';
import {
  filterAnnotations,
  HIGHLIGHT_PALETTE,
  highlightCss,
  kindLabel,
  sortByFraction,
} from '~/ui/reader-annotations-model';

function annotation(partial: Partial<Annotation> & Pick<Annotation, 'id' | 'kind'>): Annotation {
  const fraction = partial.locator?.fraction ?? 0;
  return {
    bookId: 'book-1',
    locator: { kind: 'cfi', value: `cfi-${partial.id}`, fraction },
    createdHlc: '1',
    updatedHlc: '1',
    deleted: false,
    ...partial,
  };
}

describe('reader annotations model', () => {
  it('orders by fraction and drops tombstoned rows', () => {
    const rows = [
      annotation({ id: 'c', kind: 'note', locator: { kind: 'cfi', value: 'c', fraction: 0.9 } }),
      annotation({
        id: 'a',
        kind: 'bookmark',
        locator: { kind: 'cfi', value: 'a', fraction: 0.1 },
      }),
      annotation({
        id: 'gone',
        kind: 'note',
        deleted: true,
        locator: { kind: 'cfi', value: 'g', fraction: 0.2 },
      }),
      annotation({
        id: 'b',
        kind: 'highlight',
        locator: { kind: 'cfi', value: 'b', fraction: 0.5 },
      }),
    ];
    expect(sortByFraction(rows).map((row) => row.id)).toEqual(['a', 'b', 'c']);
  });

  it('does not mutate the input array when sorting', () => {
    const rows = [
      annotation({ id: 'x', kind: 'note', locator: { kind: 'cfi', value: 'x', fraction: 0.7 } }),
      annotation({ id: 'y', kind: 'note', locator: { kind: 'cfi', value: 'y', fraction: 0.2 } }),
    ];
    sortByFraction(rows);
    expect(rows.map((row) => row.id)).toEqual(['x', 'y']);
  });

  it('filters by kind and colour independently', () => {
    const rows = [
      annotation({ id: 'y', kind: 'highlight', color: 'yellow' }),
      annotation({ id: 'g', kind: 'highlight', color: 'green' }),
      annotation({ id: 'n', kind: 'note' }),
    ];
    expect(filterAnnotations(rows, 'highlight', 'all').map((r) => r.id)).toEqual(['y', 'g']);
    expect(filterAnnotations(rows, 'all', 'green').map((r) => r.id)).toEqual(['g']);
    expect(filterAnnotations(rows, 'note', 'all').map((r) => r.id)).toEqual(['n']);
    expect(filterAnnotations(rows, 'highlight', 'green').map((r) => r.id)).toEqual(['g']);
    expect(filterAnnotations(rows, 'all', 'all')).toHaveLength(3);
  });

  it('resolves colour tokens with a yellow fallback', () => {
    expect(highlightCss('green')).toBe('#5bd08a');
    expect(highlightCss(undefined)).toBe('#f6c744');
    expect(highlightCss('')).toBe('#f6c744');
    expect(highlightCss('#abcabc')).toBe('#abcabc');
  });

  it('labels kinds and exposes the four-colour palette', () => {
    expect(kindLabel('bookmark')).toBe('Bookmark');
    expect(kindLabel('highlight')).toBe('Highlight');
    expect(kindLabel('note')).toBe('Note');
    expect(HIGHLIGHT_PALETTE.map((c) => c.token)).toEqual(['yellow', 'green', 'blue', 'pink']);
  });
});
