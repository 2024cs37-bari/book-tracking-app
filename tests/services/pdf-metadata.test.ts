import { describe, expect, it } from 'vitest';
import { findInfoDictionary, pdfMetadataExtractor } from '~/services/metadata/pdf';

const OUTLINED_PDF = [
  '%PDF-1.5',
  '1 0 obj << /Type /Outlines /First 2 0 R >> endobj',
  '2 0 obj << /Title (Cover) /Parent 1 0 R >> endobj',
  '3 0 obj << /Title (Chapter One) /Parent 1 0 R >> endobj',
  '4 0 obj << /Title (Real Document Title) /Author (Jane Author) >> endobj',
  'trailer << /Root 5 0 R /Info 4 0 R >>',
  '%%EOF',
].join('\n');

function pdfBlob(text: string): Blob {
  return new Blob([text], { type: 'application/pdf' });
}

describe('findInfoDictionary', () => {
  it('follows the trailer /Info reference to the right object', () => {
    const dict = findInfoDictionary(OUTLINED_PDF);
    expect(dict).toContain('Real Document Title');
    expect(dict).not.toContain('Cover');
    expect(dict).not.toContain('Chapter One');
  });

  it('returns undefined when there is no /Info reference', () => {
    expect(findInfoDictionary('%PDF-1.4\n1 0 obj << /Title (x) >> endobj')).toBeUndefined();
  });

  it('prefers the latest object definition (incremental update)', () => {
    const updated = `${OUTLINED_PDF}\n4 0 obj << /Title (Updated Title) >> endobj`;
    expect(findInfoDictionary(updated)).toContain('Updated Title');
  });

  it('ignores a bare "N G obj" token in stream bytes that is not a dictionary', () => {
    // A later `4 0 obj` with no `<<` (as could appear inside stream bytes) must
    // not be mistaken for the real Info object definition.
    const withStray = `${OUTLINED_PDF}\n5 0 obj << /Length 20 >> stream\n4 0 obj noise\nendstream endobj`;
    const dict = findInfoDictionary(withStray);
    expect(dict).toContain('Real Document Title');
    expect(dict).not.toContain('noise');
  });
});

describe('pdfMetadataExtractor title scoping', () => {
  it('reads the Info-dictionary title, not a bookmark label, for an outlined PDF', async () => {
    const result = await pdfMetadataExtractor.extract({
      blob: pdfBlob(OUTLINED_PDF),
      filename: 'outlined.pdf',
      format: 'pdf',
    });
    expect(result.title).toBe('Real Document Title');
    expect(result.author).toBe('Jane Author');
  });

  it('falls back to a whole-file scan when no /Info reference exists', async () => {
    const text = '%PDF-1.4\n9 0 obj << /Title (Only Title) >> endobj\n%%EOF';
    const result = await pdfMetadataExtractor.extract({
      blob: pdfBlob(text),
      filename: 'plain.pdf',
      format: 'pdf',
    });
    expect(result.title).toBe('Only Title');
  });
});
