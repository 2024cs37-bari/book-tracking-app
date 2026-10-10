import { describe, expect, it } from 'vitest';
import { buildNotesMarkdown, notesFilename } from '~/services/notes-markdown';
import type { Annotation } from '~/domain/annotation';

function annotation(partial: Partial<Annotation> & Pick<Annotation, 'kind'>): Annotation {
  return {
    id: partial.id ?? 'a1',
    bookId: 'b1',
    kind: partial.kind,
    locator: partial.locator ?? { kind: 'cfi', value: 'epubcfi(/6/4!/2)', fraction: 0.5 },
    textExcerpt: partial.textExcerpt,
    note: partial.note,
    color: partial.color,
    createdHlc: '0',
    updatedHlc: '0',
    deleted: false,
  };
}

const AT = Date.UTC(2026, 9, 10);

describe('buildNotesMarkdown', () => {
  it('renders an empty state when there are no annotations', () => {
    const md = buildNotesMarkdown('The Odyssey', [], AT);
    expect(md).toContain('# The Odyssey');
    expect(md).toContain('No bookmarks, highlights or notes yet');
  });

  it('orders annotations by reading position and labels each kind', () => {
    const md = buildNotesMarkdown(
      'Book',
      [
        annotation({ id: 'c', kind: 'note', note: 'last', locator: cfi(0.9) }),
        annotation({ id: 'a', kind: 'bookmark', locator: cfi(0.1) }),
        annotation({ id: 'b', kind: 'highlight', textExcerpt: 'middle bit', locator: cfi(0.5) }),
      ],
      AT,
    );
    const order = [md.indexOf('Bookmark'), md.indexOf('Highlight'), md.indexOf('Note')];
    expect(order).toEqual([...order].sort((x, y) => x - y));
    expect(md).toContain('### Bookmark — 10%');
    expect(md).toContain('### Highlight — 50%');
    expect(md).toContain('### Note — 90%');
  });

  it('quotes a highlight excerpt and collapses its whitespace', () => {
    const md = buildNotesMarkdown(
      'Book',
      [annotation({ kind: 'highlight', textExcerpt: 'wrapped\n   over  lines', note: 'why' })],
      AT,
    );
    expect(md).toContain('> wrapped over lines');
    expect(md).toContain('why');
  });

  it('summarizes the count and export date', () => {
    const md = buildNotesMarkdown('Book', [annotation({ kind: 'bookmark' })], AT);
    expect(md).toContain('1 annotation, exported 2026-10-10');
  });
});

describe('notesFilename', () => {
  it('slugifies the title', () => {
    expect(notesFilename('The Odyssey!')).toBe('notes-the-odyssey.md');
  });
  it('falls back when the title has no usable characters', () => {
    expect(notesFilename('…')).toBe('notes-book.md');
  });
});

function cfi(fraction: number): Annotation['locator'] {
  return { kind: 'cfi', value: 'epubcfi(/6/4!/2)', fraction };
}
