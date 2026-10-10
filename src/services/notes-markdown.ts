import type { Annotation } from '~/domain/annotation';

/** Collapses runs of whitespace so an excerpt sits on one Markdown line. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function heading(kind: Annotation['kind'], percent: number): string {
  const label = kind === 'highlight' ? 'Highlight' : kind === 'note' ? 'Note' : 'Bookmark';
  return `### ${label} — ${percent}%`;
}

/**
 * Renders a book's annotations as a portable Markdown document.
 *
 * Annotations are ordered by reading position so the export reads top-to-bottom
 * like the book. Highlights quote their captured excerpt; notes and bookmarks
 * carry the user's own text. The result is plain Markdown so it can be pasted
 * into any notes tool, which is the point of exporting at all.
 */
export function buildNotesMarkdown(
  title: string,
  annotations: readonly Annotation[],
  generatedAt: number,
): string {
  const date = new Date(generatedAt).toISOString().slice(0, 10);
  const lines: string[] = [`# ${title.trim() === '' ? 'Untitled book' : title.trim()}`, ''];

  if (annotations.length === 0) {
    lines.push('_No bookmarks, highlights or notes yet._', '');
    return lines.join('\n');
  }

  lines.push(
    `_${annotations.length} annotation${annotations.length === 1 ? '' : 's'}, exported ${date}_`,
    '',
  );

  const sorted = [...annotations].sort(
    (left, right) => left.locator.fraction - right.locator.fraction,
  );
  for (const annotation of sorted) {
    const percent = Math.round(annotation.locator.fraction * 100);
    lines.push(heading(annotation.kind, percent));
    const excerpt = annotation.textExcerpt ? oneLine(annotation.textExcerpt) : '';
    if (excerpt !== '') lines.push('', `> ${excerpt}`);
    const note = annotation.note ? annotation.note.trim() : '';
    if (note !== '') lines.push('', note);
    lines.push('');
  }

  return lines.join('\n').replace(/\n+$/, '\n');
}

/** Filename for a book's exported notes, e.g. `notes-the-odyssey.md`. */
export function notesFilename(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `notes-${slug === '' ? 'book' : slug}.md`;
}
