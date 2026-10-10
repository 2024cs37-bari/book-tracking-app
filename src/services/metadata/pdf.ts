import type { MetadataExtractor } from './types';

/**
 * How much of the file is sampled. An /Info dictionary normally sits in the
 * trailer at the end, but linearised PDFs put it at the front, so both ends are
 * sampled. Above this size the page count is not reported, because counting
 * page objects would require scanning the whole document.
 */
export const PDF_SCAN_BYTES = 1024 * 1024;

function latin1(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) {
    text += String.fromCharCode(byte);
  }
  return text;
}

function decodeHexString(hex: string): string | undefined {
  const compact = hex.replace(/\s+/g, '');
  if (compact.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(compact)) return undefined;
  const bytes = new Uint8Array(compact.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(compact.slice(index * 2, index * 2 + 2), 16);
  }
  return decodePdfString(bytes);
}

/**
 * Decodes a PDF text string.
 *
 * A leading byte-order mark means UTF-16BE; otherwise the bytes are treated as
 * PDFDocEncoding, which is close enough to Latin-1 for the metadata users
 * actually see. Full PDFDocEncoding tables are not worth carrying here.
 */
function decodePdfString(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    try {
      return new TextDecoder('utf-16be').decode(bytes.subarray(2));
    } catch {
      return '';
    }
  }
  return latin1(bytes);
}

function unescapeLiteral(value: string): string {
  return value.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_match, escape: string) => {
    switch (escape) {
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      case 'b':
        return '\b';
      case 'f':
        return '\f';
      case '(':
        return '(';
      case ')':
        return ')';
      case '\\':
        return '\\';
      default: {
        const code = Number.parseInt(escape, 8);
        return Number.isFinite(code) ? String.fromCharCode(code) : '';
      }
    }
  });
}

/** Reads `/Key (literal)` or `/Key <hex>` from a document information block. */
export function readPdfInfoValue(text: string, key: string): string | undefined {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const literal = new RegExp(`/${escapedKey}\\s*\\(((?:\\\\.|[^\\\\()])*)\\)`, 'i').exec(text);
  if (literal?.[1] !== undefined) {
    const decoded = unescapeLiteral(literal[1]).replace(/\s+/g, ' ').trim();
    if (decoded.length > 0) return decoded;
  }

  const hexadecimal = new RegExp(`/${escapedKey}\\s*<([0-9a-fA-F\\s]+)>`, 'i').exec(text);
  if (hexadecimal?.[1] !== undefined) {
    const decoded = decodeHexString(hexadecimal[1]);
    const normalized = decoded?.replace(/\0/g, '').replace(/\s+/g, ' ').trim();
    if (normalized !== undefined && normalized.length > 0) return normalized;
  }

  return undefined;
}

export function countPdfPages(text: string): number {
  // `/Type /Pages` is the page tree node and must not be counted as a page.
  const matches = text.match(/\/Type\s*\/Page(?![a-zA-Z])/g);
  return matches?.length ?? 0;
}

/**
 * Narrows the scanned text to the document information dictionary.
 *
 * The trailer references it as `/Info N G R`; this follows that reference to the
 * `N G obj … endobj` body so `/Title`/`/Author` are read from the Info dict
 * only. Without this scoping the first `/Title` in the file wins, which in a
 * PDF with a bookmark outline is a bookmark label, not the document title.
 * Returns undefined when the reference or object cannot be located as plain
 * text, so the caller can fall back to a whole-file scan.
 */
export function findInfoDictionary(text: string): string | undefined {
  const refs = [...text.matchAll(/\/Info\s+(\d+)\s+(\d+)\s+R/g)];
  const ref = refs.at(-1);
  if (ref === undefined) return undefined;
  const [, objNum, gen] = ref;

  // Require the dictionary opener `<<` right after `obj` so a bare `N G obj`
  // appearing inside a content stream or embedded bytes cannot be mistaken for
  // the real object definition. The latest such definition wins (incremental
  // updates). `\b` would not fire before `<`, so match the opener explicitly.
  const objPattern = new RegExp(`(?<![0-9])${objNum}\\s+${gen}\\s+obj\\s*<<`, 'g');
  let start = -1;
  for (let match = objPattern.exec(text); match !== null; match = objPattern.exec(text)) {
    start = match.index;
  }
  if (start === -1) return undefined;

  const end = text.indexOf('endobj', start);
  return end === -1 ? text.slice(start) : text.slice(start, end);
}

/**
 * Best-effort PDF metadata.
 *
 * PDF has no required metadata and no canonical encoding for it, so this
 * extractor reports only what it can read with confidence and leaves the rest
 * to be filled from the filename. It never fails an import: a PDF with no
 * readable title is still a perfectly good PDF.
 */
export const pdfMetadataExtractor: MetadataExtractor = {
  formats: ['pdf'],
  source: 'PDF document information dictionary (best effort)',

  async extract({ blob }) {
    const warnings: string[] = [];
    const scannedWholeFile = blob.size <= PDF_SCAN_BYTES;

    const head = new Uint8Array(await blob.slice(0, PDF_SCAN_BYTES).arrayBuffer());
    const tail =
      blob.size > PDF_SCAN_BYTES
        ? new Uint8Array(await blob.slice(blob.size - PDF_SCAN_BYTES).arrayBuffer())
        : new Uint8Array(0);
    const text = `${latin1(head)}\n${latin1(tail)}`;

    // Only Title and Author are reliably present in the information
    // dictionary. Producer/Creator name the software that wrote the file, not
    // the publisher, so they are deliberately not mapped to book metadata.
    // Scope the read to the Info dictionary so an outline's bookmark titles
    // cannot be mistaken for the document title; fall back to the full scan
    // when the Info object cannot be located as plain text.
    const infoScope = findInfoDictionary(text) ?? text;
    const title = readPdfInfoValue(infoScope, 'Title');
    const author = readPdfInfoValue(infoScope, 'Author');

    const pageCount = scannedWholeFile ? countPdfPages(text) : 0;
    if (!scannedWholeFile) {
      warnings.push(
        'The PDF is larger than 1 MB, so its page count was not determined during import.',
      );
    }

    return {
      title,
      author,
      pageCount: pageCount > 0 ? pageCount : undefined,
      warnings,
    };
  },
};
