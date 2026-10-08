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
    const title = readPdfInfoValue(text, 'Title');
    const author = readPdfInfoValue(text, 'Author');

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
