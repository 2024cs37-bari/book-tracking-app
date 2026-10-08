import { strFromU8, unzipSync } from 'fflate';
import {
  allElementTexts,
  directoryOf,
  elementBlock,
  findTags,
  firstElementText,
  resolveArchivePath,
  type ExtractedCover,
  type MetadataExtractor,
} from './types';
import { contentTypeForPath } from '~/storage/mime';

/**
 * Guards against loading a huge archive into memory just to read metadata.
 * Above this the extractor reports a warning and the book is still imported.
 */
export const MAX_EPUB_EXTRACTION_BYTES = 256 * 1024 * 1024;

const CONTAINER_PATH = 'META-INF/container.xml';
const COVER_META_NAMES = ['calibre:cover', 'cover'] as const;

interface ManifestItem {
  readonly id: string;
  readonly href: string;
  readonly mediaType?: string;
  readonly properties?: string;
}

function parseManifest(opfXml: string): ManifestItem[] {
  return findTags(opfXml, 'item').flatMap((tag) => {
    const id = tag.attributes.id;
    const href = tag.attributes.href;
    if (id === undefined || href === undefined) return [];
    return [
      {
        id,
        href,
        mediaType: tag.attributes['media-type'],
        properties: tag.attributes.properties,
      },
    ];
  });
}

function findRootfilePath(containerXml: string): string | undefined {
  const rootfile = findTags(containerXml, 'rootfile').find(
    (tag) => tag.attributes['full-path'] !== undefined,
  );
  return rootfile?.attributes['full-path'];
}

/**
 * Picks an ISBN-shaped identifier.
 *
 * Digits are compared against ISBN-10 and ISBN-13 shapes rather than any digit
 * run, because EPUB identifier elements routinely hold UUIDs and internal ids
 * whose digit sequences would otherwise look like an ISBN.
 */
function pickIsbn(identifiers: readonly string[]): string | undefined {
  for (const identifier of identifiers) {
    const compact = identifier.replace(/[-\s]/g, '');
    const digits = compact.replace(/[^0-9Xx]/g, '');
    if (!/^(?:97[89])?\d{9}[\dXx]$/.test(digits)) continue;
    if (/isbn/i.test(compact) || digits.length === 10 || digits.length === 13) {
      return digits.toUpperCase();
    }
  }
  return undefined;
}

function findCoverHref(
  metadataBlock: string,
  manifest: readonly ManifestItem[],
): string | undefined {
  for (const name of COVER_META_NAMES) {
    const pattern = new RegExp(`<meta[^>]*name=["']${name}["'][^>]*content=["']([^"']+)["']`, 'i');
    const coverId = pattern.exec(metadataBlock)?.[1];
    if (coverId !== undefined) {
      const item = manifest.find((candidate) => candidate.id === coverId);
      if (item !== undefined) return item.href;
    }
  }

  const declared = manifest.find((item) => item.properties?.includes('cover-image') === true);
  if (declared !== undefined) return declared.href;

  // Last resort: an image id that looks like a cover.
  return manifest.find(
    (item) => /cover/i.test(item.id) && item.mediaType?.startsWith('image/') === true,
  )?.href;
}

function readCover(
  archive: Record<string, Uint8Array>,
  opfDirectory: string,
  coverHref: string,
): ExtractedCover | undefined {
  const coverPath = resolveArchivePath(opfDirectory, coverHref);
  const bytes = archive[coverPath];
  if (bytes === undefined) return undefined;
  const contentType = contentTypeForPath(coverPath) ?? 'application/octet-stream';
  const extension = /\.([a-z0-9]+)$/i.exec(coverPath)?.[1]?.toLowerCase() ?? 'bin';
  // Copy into a standalone buffer so the cover outlives the archive map.
  return { bytes: new Uint8Array(bytes), contentType, extension };
}

/**
 * Reads EPUB metadata from the OPF package document.
 *
 * Only the container, package document and cover are read; the spine and
 * content documents are the renderer's concern.
 */
export const epubMetadataExtractor: MetadataExtractor = {
  formats: ['epub'],
  source: 'EPUB package document (OPF)',

  async extract({ blob }) {
    const warnings: string[] = [];
    if (blob.size > MAX_EPUB_EXTRACTION_BYTES) {
      return {
        warnings: [
          `EPUB is larger than ${Math.round(MAX_EPUB_EXTRACTION_BYTES / (1024 * 1024))} MB, so embedded metadata was not read.`,
        ],
      };
    }

    let archive: Record<string, Uint8Array>;
    try {
      archive = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    } catch (error) {
      return {
        warnings: [
          `The EPUB container could not be opened: ${error instanceof Error ? error.message : 'unknown error'}.`,
        ],
      };
    }

    const containerBytes = archive[CONTAINER_PATH];
    if (containerBytes === undefined) {
      return { warnings: ['The EPUB is missing META-INF/container.xml.'] };
    }

    const rootfilePath = findRootfilePath(strFromU8(containerBytes));
    if (rootfilePath === undefined) {
      return { warnings: ['The EPUB container does not name a package document.'] };
    }

    const opfBytes = archive[rootfilePath];
    if (opfBytes === undefined) {
      return { warnings: [`The EPUB package document "${rootfilePath}" is missing.`] };
    }

    const opfXml = strFromU8(opfBytes);
    const metadataBlock = elementBlock(opfXml, 'metadata') ?? opfXml;
    const opfDirectory = directoryOf(rootfilePath);

    const manifest = parseManifest(opfXml);
    const isbn = pickIsbn(allElementTexts(metadataBlock, ['dc:identifier', 'identifier']));

    const coverHref = findCoverHref(metadataBlock, manifest);
    const cover = coverHref === undefined ? undefined : readCover(archive, opfDirectory, coverHref);
    if (coverHref !== undefined && cover === undefined) {
      warnings.push(`The declared cover image "${coverHref}" is not present in the archive.`);
    }

    const title = firstElementText(metadataBlock, ['dc:title', 'title']);
    const author = firstElementText(metadataBlock, ['dc:creator', 'creator']);
    const language = firstElementText(metadataBlock, ['dc:language', 'language']);
    const publisher = firstElementText(metadataBlock, ['dc:publisher', 'publisher']);

    if (title === undefined) {
      warnings.push('The EPUB package document contains no title element.');
    }

    return { title, author, language, publisher, isbn, cover, warnings };
  },
};
