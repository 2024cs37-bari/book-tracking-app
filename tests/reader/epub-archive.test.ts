import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { MAX_EPUB_ENTRY_BYTES, MAX_EPUB_ENTRIES, openEpubArchive } from '~/reader/epub-archive';
import { epubMetadataExtractor } from '~/services/metadata/epub';
import { decodeXmlEntities, parseTagAttributes } from '~/services/metadata/types';

function patchExpandedSize(bytes: Uint8Array, size: number) {
  const result = new Uint8Array(bytes);
  const view = new DataView(result.buffer);
  for (let index = 0; index + 46 <= result.length; index++) {
    if (view.getUint32(index, true) === 0x02014b50) {
      view.setUint32(index + 24, size, true);
      break;
    }
  }
  return result;
}

describe('bounded EPUB archive extraction', () => {
  it('rejects declared inflation bombs before decompression', () => {
    const bytes = patchExpandedSize(
      zipSync({ 'chapter.xhtml': strToU8('small') }),
      MAX_EPUB_ENTRY_BYTES + 1,
    );
    expect(() => openEpubArchive(bytes)).toThrow(/expanded entry/);
  });

  it('rejects too many entries and unsafe paths before extracting content', () => {
    const entries: Record<string, Uint8Array> = {};
    for (let index = 0; index <= MAX_EPUB_ENTRIES; index++) entries[`e${index}`] = new Uint8Array();
    expect(() => openEpubArchive(zipSync(entries))).toThrow(/too many/);
    expect(() => openEpubArchive(zipSync({ '../outside': strToU8('x') }))).toThrow(/unsafe/);
  });

  it('does not decompress unrelated content to obtain metadata', async () => {
    // Deflate-corrupt content is deliberately not needed by the metadata path.
    const archive = zipSync({
      'META-INF/container.xml': strToU8(
        "<container><rootfile full-path='content.opf'/></container>",
      ),
      'content.opf': strToU8(
        '<package><metadata><dc:title>Safe title</dc:title></metadata></package>',
      ),
      'unread.dat': new Uint8Array(30_000).fill(41),
    });
    const view = new DataView(archive.buffer);
    for (let index = 0; index + 46 <= archive.length; index++) {
      if (view.getUint32(index, true) !== 0x02014b50) continue;
      const nameLength = view.getUint16(index + 28, true);
      const name = new TextDecoder().decode(archive.subarray(index + 46, index + 46 + nameLength));
      if (name !== 'unread.dat') continue;
      const local = view.getUint32(index + 42, true);
      const data = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      archive[data] = 7; // Reserved deflate block type would fail if inflated.
    }
    const extracted = await epubMetadataExtractor.extract({
      blob: new Blob([archive]),
      filename: 'safe.epub',
      format: 'epub',
    });
    expect(extracted.title).toBe('Safe title');
  });

  it('limits a selected resource separately from the aggregate archive', () => {
    const archive = openEpubArchive(
      zipSync({ 'small.xml': strToU8('small'), 'large.xml': new Uint8Array(1000) }),
    );
    expect(archive.read('small.xml', 10)).toEqual(strToU8('small'));
    expect(() => archive.read('large.xml', 100)).toThrow(/extraction limit/);
  });

  it('tolerates invalid Unicode references and ordinary single-quoted XML attributes', () => {
    expect(decodeXmlEntities('&#x110000; &#999999999;')).toBe('&#x110000; &#999999999;');
    expect(parseTagAttributes('id=\'book\' href="chapter.xhtml"')).toEqual({
      id: 'book',
      href: 'chapter.xhtml',
    });
  });
});
