import type { BookFormat } from '~/domain/enums';

export type DetectionConfidence = 'high' | 'medium' | 'low';

export interface FormatDetection {
  readonly format: BookFormat | null;
  readonly confidence: DetectionConfidence;
  readonly reason: string;
}

/**
 * How many leading bytes the caller should sample before detecting.
 *
 * MOBI stores its version inside record 0, whose offset lives at byte 78, and
 * EPUB stores its `mimetype` entry first. 128 KiB covers both comfortably
 * without reading a whole book just to identify it.
 */
export const DETECTION_SAMPLE_BYTES = 128 * 1024;

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04] as const;
const PDF_MAGIC = '%PDF-';
const PALM_MARKER_OFFSET = 60;
const PALM_MARKER = 'BOOKMOBI';
const MOBI_HEADER_VERSION_OFFSET = 20;
const PALM_DOC_HEADER_SIZE = 16;
const PALM_RECORD_OFFSET_FIELD = 78;
const KF8_VERSION = 8;

const EXTENSION_FORMATS: Readonly<Record<string, BookFormat>> = {
  epub: 'epub',
  mobi: 'mobi',
  azw: 'mobi',
  azw3: 'azw3',
  pdf: 'pdf',
  fb2: 'fb2',
  cbz: 'cbz',
};

function matchesAt(bytes: Uint8Array, offset: number, text: string): boolean {
  if (offset < 0 || offset + text.length > bytes.length) return false;
  for (let index = 0; index < text.length; index += 1) {
    if (bytes[offset + index] !== text.charCodeAt(index)) return false;
  }
  return true;
}

function findAscii(bytes: Uint8Array, text: string, limit: number): boolean {
  const haystack = Math.min(bytes.length, limit);
  const needleLength = text.length;
  if (needleLength === 0 || haystack < needleLength) return false;
  for (let offset = 0; offset <= haystack - needleLength; offset += 1) {
    if (matchesAt(bytes, offset, text)) return true;
  }
  return false;
}

function hasZipMagic(bytes: Uint8Array): boolean {
  return ZIP_MAGIC.every((byte, index) => bytes[index] === byte);
}

function readUint32BigEndian(bytes: Uint8Array, offset: number): number | null {
  if (offset < 0 || offset + 4 > bytes.length) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(offset);
}

/** Decodes a sample as Latin-1, enough for ASCII-level XML sniffing. */
function latin1Sample(bytes: Uint8Array, limit: number): string {
  const end = Math.min(bytes.length, limit);
  let text = '';
  for (let index = 0; index < end; index += 1) {
    text += String.fromCharCode(bytes[index]!);
  }
  return text;
}

export function formatFromExtension(filename: string): BookFormat | null {
  const match = /\.([a-z0-9]+)$/i.exec(filename.trim());
  if (match?.[1] === undefined) return null;
  return EXTENSION_FORMATS[match[1].toLowerCase()] ?? null;
}

function looksLikePdf(bytes: Uint8Array): FormatDetection | null {
  if (matchesAt(bytes, 0, PDF_MAGIC)) {
    return { format: 'pdf', confidence: 'high', reason: 'The file begins with a %PDF- header.' };
  }
  // Some producers prepend junk or a byte-order mark before the header.
  if (findAscii(bytes, PDF_MAGIC, 1024)) {
    return {
      format: 'pdf',
      confidence: 'medium',
      reason: 'A %PDF- header appears shortly after the start of the file.',
    };
  }
  return null;
}

function looksLikeEpub(bytes: Uint8Array): boolean {
  // A conforming EPUB stores an uncompressed `mimetype` entry first.
  return findAscii(bytes, 'mimetype', 512) && findAscii(bytes, 'application/epub+zip', 1024);
}

function looksLikeMobi(bytes: Uint8Array): FormatDetection | null {
  if (!matchesAt(bytes, PALM_MARKER_OFFSET, PALM_MARKER)) return null;

  const recordZeroOffset = readUint32BigEndian(bytes, PALM_RECORD_OFFSET_FIELD);
  if (recordZeroOffset !== null) {
    const versionOffset = recordZeroOffset + PALM_DOC_HEADER_SIZE + MOBI_HEADER_VERSION_OFFSET;
    const version = readUint32BigEndian(bytes, versionOffset);
    if (version === KF8_VERSION) {
      return {
        format: 'azw3',
        confidence: 'high',
        reason: 'Palm database with a KF8 (version 8) MOBI header.',
      };
    }
    if (version !== null) {
      return {
        format: 'mobi',
        confidence: 'high',
        reason: `Palm database with MOBI header version ${version}.`,
      };
    }
  }

  return {
    format: 'mobi',
    confidence: 'medium',
    reason:
      'Palm database with a BOOKMOBI marker; the header version was outside the sampled bytes.',
  };
}

function looksLikeFb2(bytes: Uint8Array): boolean {
  return /<FictionBook[\s>]/i.test(latin1Sample(bytes, 4096));
}

/**
 * Identifies a book by content first and filename second.
 *
 * Content wins because extensions lie: a `.pdf` that is really an EPUB must be
 * rendered as an EPUB, and a re-named archive should not be trusted. The
 * extension is only a last resort, and that is reported as low confidence so
 * the import summary can say why.
 */
export function detectFormat(bytes: Uint8Array, filename = ''): FormatDetection {
  const pdf = looksLikePdf(bytes);
  if (pdf) return pdf;

  if (hasZipMagic(bytes)) {
    if (looksLikeEpub(bytes)) {
      return {
        format: 'epub',
        confidence: 'high',
        reason: 'ZIP container whose mimetype entry declares application/epub+zip.',
      };
    }
    if (formatFromExtension(filename) === 'epub') {
      return {
        format: 'epub',
        confidence: 'medium',
        reason: 'ZIP container with an .epub filename but no readable mimetype entry.',
      };
    }
    return {
      format: 'cbz',
      confidence: 'low',
      reason: 'ZIP container that is not an EPUB; treated as a comic-book archive.',
    };
  }

  const mobi = looksLikeMobi(bytes);
  if (mobi) return mobi;

  if (looksLikeFb2(bytes)) {
    return {
      format: 'fb2',
      confidence: 'medium',
      reason: 'XML content with a FictionBook root element.',
    };
  }

  const fromExtension = formatFromExtension(filename);
  if (fromExtension !== null) {
    return {
      format: fromExtension,
      confidence: 'low',
      reason: `Only the .${filename.split('.').pop() ?? ''} extension matched; the content was not recognised.`,
    };
  }

  return {
    format: null,
    confidence: 'low',
    reason: 'The content did not match any known book format.',
  };
}
