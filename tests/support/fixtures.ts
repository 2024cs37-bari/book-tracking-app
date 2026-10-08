import { strToU8, zipSync, type Zippable } from 'fflate';

/**
 * Synthetic book fixtures.
 *
 * These are generated rather than checked in: committing real books would be a
 * licensing problem, and generated files let each test state exactly which
 * structural detail it depends on. They exercise this codebase's parsing, not
 * conformance of real-world files — validating against a real corpus is a
 * separate milestone requirement (docs/IMPORT-AND-READER.md §7).
 */

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

export interface EpubFixtureOptions {
  readonly title?: string;
  readonly creator?: string;
  readonly language?: string;
  readonly identifier?: string;
  readonly publisher?: string;
  /** Package document path inside the archive. */
  readonly opfPath?: string;
  /** Adds a cover image plus the manifest/metadata declarations for it. */
  readonly withCover?: boolean;
  /** Writes the cover image only to the manifest, without the file itself. */
  readonly coverFileMissing?: boolean;
  /** Omits the uncompressed `mimetype` entry, producing a malformed EPUB. */
  readonly omitMimetype?: boolean;
  /** Omits META-INF/container.xml entirely. */
  readonly omitContainer?: boolean;
}

function containerXml(opfPath: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="${opfPath}" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;
}

function packageXml(options: EpubFixtureOptions): string {
  const title = options.title ?? 'A Synthetic Book';
  const creator = options.creator ?? 'Test Author';
  const language = options.language ?? 'en';
  const identifier = options.identifier ?? 'urn:isbn:9780306406157';
  const publisher = options.publisher ?? 'Test House';
  const coverDeclarations = options.withCover
    ? `
    <meta name="cover" content="cover-image"/>`
    : '';
  const coverManifest = options.withCover
    ? `
    <item id="cover-image" href="images/cover.jpg" media-type="image/jpeg" properties="cover-image"/>`
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${title}</dc:title>
    <dc:creator>${creator}</dc:creator>
    <dc:language>${language}</dc:language>
    <dc:identifier id="bookid">${identifier}</dc:identifier>
    <dc:publisher>${publisher}</dc:publisher>${coverDeclarations}
  </metadata>
  <manifest>
    <item id="chapter1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>${coverManifest}
  </manifest>
  <spine>
    <itemref idref="chapter1"/>
  </spine>
</package>`;
}

const CHAPTER_XHTML = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter 1</title></head>
<body><p>Content.</p></body></html>`;

export function buildEpubFixture(options: EpubFixtureOptions = {}): Uint8Array<ArrayBuffer> {
  const opfPath = options.opfPath ?? 'OEBPS/content.opf';
  const opfDirectory = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '';

  const files: Zippable = {};

  // A conforming EPUB stores `mimetype` first, uncompressed.
  if (options.omitMimetype !== true) {
    files['mimetype'] = [strToU8('application/epub+zip'), { level: 0 }];
  }
  if (options.omitContainer !== true) {
    files['META-INF/container.xml'] = strToU8(containerXml(opfPath));
  }
  files[opfPath] = strToU8(packageXml(options));
  files[`${opfDirectory}/chapter1.xhtml`] = strToU8(CHAPTER_XHTML);

  if (options.withCover === true && options.coverFileMissing !== true) {
    files[`${opfDirectory}/images/cover.jpg`] = JPEG_BYTES;
  }

  return zipSync(files, { level: 6 });
}

export interface PdfFixtureOptions {
  readonly title?: string;
  readonly author?: string;
  readonly pageCount?: number;
  readonly withInfoDictionary?: boolean;
}

/**
 * Builds a minimal but structurally ordered PDF.
 *
 * Page count is expressed with real `/Type /Page` objects so the extractor's
 * counting logic is exercised rather than mocked.
 */
export function buildPdfFixture(options: PdfFixtureOptions = {}): Uint8Array<ArrayBuffer> {
  const pageCount = options.pageCount ?? 1;
  const objects: string[] = [];
  const pageIds: number[] = [];

  // 1 = catalog, 2 = page tree, then one object per page.
  for (let index = 0; index < pageCount; index += 1) {
    pageIds.push(index + 3);
  }

  objects.push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  objects.push(
    `2 0 obj\n<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageCount} >>\nendobj\n`,
  );
  for (const id of pageIds) {
    objects.push(`${id} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n`);
  }

  const infoParts: string[] = [];
  if (options.withInfoDictionary !== false) {
    if (options.title !== undefined) infoParts.push(`/Title (${options.title})`);
    if (options.author !== undefined) infoParts.push(`/Author (${options.author})`);
  }
  const infoDictionary = infoParts.length > 0 ? `\n<< /Info << ${infoParts.join(' ')} >> >>` : '';

  const body = objects.join('');
  const text = `%PDF-1.4\n${body}trailer${infoDictionary}\n%%EOF\n`;
  return strToU8(text);
}

/** Builds a Palm database container with a MOBI header of the given version. */
export function buildMobiFixture(options: { fileVersion?: number } = {}): Uint8Array<ArrayBuffer> {
  const fileVersion = options.fileVersion ?? 6;
  const recordZeroOffset = 200;
  const bytes = new Uint8Array(recordZeroOffset + 64);

  // Record 0 is described by the first record-info entry at byte 78.
  const view = new DataView(bytes.buffer);
  view.setUint32(78, recordZeroOffset);

  // Palm database type/creator: "BOOKMOBI" spans bytes 60..67.
  for (let index = 0; index < 'BOOKMOBI'.length; index += 1) {
    bytes[60 + index] = 'BOOKMOBI'.charCodeAt(index);
  }

  // PalmDOC header (16 bytes) followed by the MOBI header.
  const mobiStart = recordZeroOffset + 16;
  for (let index = 0; index < 'MOBI'.length; index += 1) {
    bytes[mobiStart + index] = 'MOBI'.charCodeAt(index);
  }
  view.setUint32(mobiStart + 4, 232); // header length
  view.setUint32(mobiStart + 20, fileVersion);

  return bytes;
}

export function buildFb2Fixture(): Uint8Array<ArrayBuffer> {
  return strToU8(
    `<?xml version="1.0" encoding="UTF-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0">
  <description><title-info><book-title>Synthetic FB2</book-title></title-info></description>
  <body><section><p>Text.</p></section></body>
</FictionBook>`,
  );
}

/** Builds a ZIP that is not an EPUB, which the detector treats as a CBZ. */
export function buildCbzFixture(): Uint8Array<ArrayBuffer> {
  return zipSync({ 'page-001.jpg': JPEG_BYTES, 'page-002.jpg': JPEG_BYTES }, { level: 6 });
}

export function buildPlainTextFixture(text = 'not a book'): Uint8Array<ArrayBuffer> {
  return strToU8(text);
}

export function toBlob(bytes: Uint8Array<ArrayBuffer>): Blob {
  return new Blob([bytes]);
}
