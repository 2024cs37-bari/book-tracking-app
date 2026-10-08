import { strToU8, zipSync, zlibSync, type Zippable } from 'fflate';
import * as fontModule from 'opentype.js';

// Node uses the package's UMD entry; Vite uses its native ESM entry.
const { Font, Glyph, Path } =
  (fontModule as unknown as { default?: typeof fontModule }).default ?? fontModule;

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

export interface EpubTocFixtureItem {
  readonly label: string;
  readonly href: string;
  readonly children?: readonly EpubTocFixtureItem[];
}

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
  readonly hostileScript?: boolean;
  readonly chapters?: number;
  readonly paragraphs?: number;
  readonly epubVersion?: '2.0' | '3.0';
  readonly rtl?: boolean;
  readonly toc?: readonly EpubTocFixtureItem[];
  readonly assets?: 'valid' | 'missing' | 'malformed';
  readonly fixedLayout?: boolean;
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
<package xmlns="http://www.idpf.org/2007/opf" version="${options.epubVersion ?? '3.0'}" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${title}</dc:title>
    <dc:creator>${creator}</dc:creator>
    <dc:language>${language}</dc:language>
    <dc:identifier id="bookid">${identifier}</dc:identifier>
    <dc:publisher>${publisher}</dc:publisher>${coverDeclarations}
    ${options.fixedLayout ? '<meta property="rendition:layout">pre-paginated</meta><meta property="rendition:spread">none</meta>' : ''}
  </metadata>
  <manifest>
    ${Array.from({ length: options.chapters ?? 1 }, (_, index) => `<item id="chapter${index + 1}" href="chapter${index + 1}.xhtml" media-type="application/xhtml+xml"/>`).join('\n')}${coverManifest}
    ${options.epubVersion === '2.0' ? '' : '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'}
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    ${options.assets ? '<item id="css" href="styles/book.css" media-type="text/css"/><item id="image" href="images/test.png" media-type="image/png"/><item id="font" href="fonts/fixture.otf" media-type="font/otf"/>' : ''}
  </manifest>
  <spine toc="ncx"${options.rtl ? ' page-progression-direction="rtl"' : ''}>
    ${Array.from({ length: options.chapters ?? 1 }, (_, index) => `<itemref idref="chapter${index + 1}"/>`).join('\n')}
  </spine>
</package>`;
}

const CHAPTER_XHTML = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter 1</title></head>
<body><p>Content.</p></body></html>`;

/** A tiny RGBA PNG with real chunk checksums; no committed image bytes. */
export function buildImageFixture(): Uint8Array<ArrayBuffer> {
  const crc32 = (bytes: Uint8Array): number => {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array): Uint8Array<ArrayBuffer> => {
    const bytes = new Uint8Array(data.length + 12);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, data.length);
    bytes.set(strToU8(type), 4);
    bytes.set(data, 8);
    view.setUint32(bytes.length - 4, crc32(bytes.subarray(4, bytes.length - 4)));
    return bytes;
  };
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, 64);
  view.setUint32(4, 32);
  header[8] = 8;
  header[9] = 6;
  const pixels = new Uint8Array(32 * (64 * 4 + 1));
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 64; x++) pixels.set([35, 100, 220, 255], y * 257 + 1 + x * 4);
  const chunks = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', zlibSync(pixels)),
    chunk('IEND', new Uint8Array()),
  ];
  const result = new Uint8Array(chunks.reduce((size, bytes) => size + bytes.length, 0));
  let offset = 0;
  for (const bytes of chunks) {
    result.set(bytes, offset);
    offset += bytes.length;
  }
  return result;
}

/** Original synthetic glyph outlines, generated into an OpenType font in memory. */
export function buildFontFixture(): Uint8Array<ArrayBuffer> {
  const glyphs = [new Glyph({ name: '.notdef', advanceWidth: 600, path: new Path() })];
  for (let unicode = 32; unicode < 127; unicode++) {
    const path = new Path();
    if (unicode !== 32) {
      path.moveTo(80, 0);
      path.lineTo(300, 700);
      path.lineTo(520, 0);
      path.lineTo(420, 0);
      path.lineTo(300, 450);
      path.lineTo(180, 0);
      path.close();
    }
    glyphs.push(new Glyph({ name: `fixture-${unicode}`, unicode, advanceWidth: 600, path }));
  }
  return new Uint8Array(
    new Font({
      familyName: 'Fixture Serif',
      styleName: 'Regular',
      unitsPerEm: 1000,
      ascender: 800,
      descender: -200,
      glyphs,
    }).toArrayBuffer(),
  );
}

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
  for (let index = 1; index <= (options.chapters ?? 1); index++) {
    let chapter = CHAPTER_XHTML.replace('Chapter 1', `Chapter ${index}`);
    if (options.paragraphs)
      chapter = chapter.replace(
        '<p>Content.</p>',
        `<h1>Chapter ${index}</h1>${Array.from({ length: options.paragraphs }, (_, paragraph) => `<p id="paragraph-${paragraph + 1}">Chapter ${index} paragraph ${paragraph + 1}. Generated reader content with enough words to exercise pagination, settings and stable CFI positions.</p>`).join('')}`,
      );
    if (options.rtl) chapter = chapter.replace('<body>', '<body dir="rtl">');
    if (options.fixedLayout)
      chapter = chapter.replace(
        '</head>',
        '<meta name="viewport" content="width=600,height=800"/><style>html,body { width:600px; height:800px; margin:0; } #asset-image { position:absolute; left:40px; top:200px; } #asset-caption { position:absolute; left:40px; top:80px; }</style></head>',
      );
    if (options.assets) {
      chapter = chapter.replace(
        '</head>',
        '<link rel="stylesheet" href="styles/book.css"/></head>',
      );
      chapter = chapter.replace(
        '<body>',
        `<body><p id="asset-caption">Asset fixture chapter ${index}</p><img id="asset-image" src="images/test.png" alt="Generated blue rectangle"/>`,
      );
      if (options.rtl)
        chapter = chapter.replace(
          '<body dir="rtl">',
          `<body dir="rtl"><p id="asset-caption">Asset fixture chapter ${index}</p><img id="asset-image" src="images/test.png" alt="Generated blue rectangle"/>`,
        );
    }
    if (options.hostileScript)
      chapter = chapter.replace(
        '</head>',
        '<script>globalThis.bookScriptExecuted = true; parent.bookScriptExecuted = true;</script></head>',
      );
    files[`${opfDirectory}/chapter${index}.xhtml`] = strToU8(chapter);
  }
  const toc =
    options.toc ??
    Array.from({ length: options.chapters ?? 1 }, (_, index) => ({
      label: `Chapter ${index + 1}`,
      href: `chapter${index + 1}.xhtml`,
    }));
  const escapeXml = (value: string) =>
    value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
  const navItems = (items: readonly EpubTocFixtureItem[]): string =>
    items
      .map(
        (item) =>
          `<li><a href="${escapeXml(item.href)}">${escapeXml(item.label)}</a>${item.children ? `<ol>${navItems(item.children)}</ol>` : ''}</li>`,
      )
      .join('');
  let navPoint = 0;
  const ncxItems = (items: readonly EpubTocFixtureItem[]): string =>
    items
      .map((item) => {
        const index = ++navPoint;
        return `<navPoint id="entry${index}" playOrder="${index}"><navLabel><text>${escapeXml(item.label)}</text></navLabel><content src="${escapeXml(item.href)}"/>${item.children ? ncxItems(item.children) : ''}</navPoint>`;
      })
      .join('');
  files[`${opfDirectory}/nav.xhtml`] = strToU8(
    `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol>${navItems(toc)}</ol></nav></body></html>`,
  );
  files[`${opfDirectory}/toc.ncx`] = strToU8(
    `<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head/><docTitle><text>Contents</text></docTitle><navMap>${ncxItems(toc)}</navMap></ncx>`,
  );

  if (options.withCover === true && options.coverFileMissing !== true) {
    files[`${opfDirectory}/images/cover.jpg`] = JPEG_BYTES;
  }
  if (options.assets) {
    files[`${opfDirectory}/styles/book.css`] = strToU8(
      '@font-face { font-family: "Fixture Serif"; src: url("../fonts/fixture.otf") format("opentype"); } #asset-caption { font-family: "Fixture Serif"; color: rgb(17, 85, 34); border-top: 3px solid rgb(17, 85, 34); } #asset-image { width:64px; height:32px; }',
    );
    if (options.assets !== 'missing') {
      files[`${opfDirectory}/images/test.png`] =
        options.assets === 'malformed' ? strToU8('invalid PNG') : buildImageFixture();
      files[`${opfDirectory}/fonts/fixture.otf`] =
        options.assets === 'malformed' ? strToU8('invalid font') : buildFontFixture();
    }
  }

  return zipSync(files, { level: 6 });
}

export interface PdfFixtureOptions {
  readonly title?: string;
  readonly author?: string;
  readonly pageCount?: number;
  readonly withInfoDictionary?: boolean;
  readonly variedPages?: boolean;
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
  const fontId = pageCount + 3;
  for (const [index, id] of pageIds.entries()) {
    const size = options.variedPages && index % 2 ? '420 600' : '612 792';
    const rotation = options.variedPages && index % 2 ? ' /Rotate 90' : '';
    objects.push(
      `${id} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${size}]${rotation} /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${fontId + index + 1} 0 R >>\nendobj\n`,
    );
  }
  objects.push(`${fontId} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`);
  for (let index = 0; index < pageCount; index++) {
    const content = `BT /F1 24 Tf 50 500 Td (Generated page ${index + 1}) Tj ET\n`;
    objects.push(
      `${fontId + index + 1} 0 obj\n<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`,
    );
  }

  const infoParts: string[] = [];
  if (options.withInfoDictionary !== false) {
    if (options.title !== undefined) infoParts.push(`/Title (${options.title})`);
    if (options.author !== undefined) infoParts.push(`/Author (${options.author})`);
  }
  const infoId = objects.length + 1;
  if (infoParts.length) objects.push(`${infoId} 0 obj\n<< ${infoParts.join(' ')} >>\nendobj\n`);
  let text = '%PDF-1.4\n';
  const offsets = [0];
  for (const object of objects) {
    offsets.push(text.length);
    text += object;
  }
  const xref = text.length;
  text += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join(
      '',
    )}trailer\n<< /Size ${offsets.length} /Root 1 0 R${infoParts.length ? ` /Info ${infoId} 0 R` : ''} >>\nstartxref\n${xref}\n%%EOF\n`;
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
