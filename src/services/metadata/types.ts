import type { BookFormat } from '~/domain/enums';
import type { BookMetadataPatch } from '~/data/book-mapping';

export interface ExtractedCover {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly contentType: string;
  /** File extension without the dot, used to build a stable cover key. */
  readonly extension: string;
}

export interface ExtractedMetadata {
  readonly title?: string;
  readonly author?: string;
  readonly language?: string;
  readonly isbn?: string;
  readonly publisher?: string;
  readonly pageCount?: number;
  readonly cover?: ExtractedCover;
  /** Non-fatal problems worth showing to the user. */
  readonly warnings: readonly string[];
}

export interface MetadataExtractionInput {
  readonly blob: Blob;
  readonly filename: string;
  readonly format: BookFormat;
}

export interface MetadataExtractor {
  readonly formats: readonly BookFormat[];
  /** Human-readable source, surfaced in diagnostics. */
  readonly source: string;
  extract(input: MetadataExtractionInput): Promise<ExtractedMetadata>;
}

/** Fields written to a book row after import. */
export function metadataToPatch(metadata: ExtractedMetadata): BookMetadataPatch {
  return {
    title: metadata.title,
    author: metadata.author,
    language: metadata.language,
    isbn: metadata.isbn,
    publisher: metadata.publisher,
    pageCount: metadata.pageCount,
  };
}

export const XML_ENTITY_PATTERN = /&(?:#x?[0-9a-f]+|[a-z]+);/gi;

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
};

export function decodeXmlEntities(value: string): string {
  return value.replace(XML_ENTITY_PATTERN, (entity) => {
    if (entity.startsWith('&#x') || entity.startsWith('&#X')) {
      const codePoint = Number.parseInt(entity.slice(3, -1), 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : entity;
    }
    if (entity.startsWith('&#')) {
      const codePoint = Number.parseInt(entity.slice(2, -1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : entity;
    }
    return NAMED_ENTITIES[entity.slice(1, -1).toLowerCase()] ?? entity;
  });
}

export function stripMarkup(value: string): string {
  return value.replace(/<[^>]*>/g, '');
}

export function normalizeMetadataText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const cleaned = decodeXmlEntities(stripMarkup(value)).replace(/\s+/g, ' ').trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Returns the text of the first matching element.
 *
 * Element names are tried in priority order, which lets callers prefer
 * namespaced metadata (`dc:title`) and fall back to a bare element. A
 * regex-based reader is deliberate here: embedded metadata blocks are small,
 * and this keeps the extractors dependency-free and testable in Node, where
 * DOMParser does not exist.
 */
export function firstElementText(xml: string, names: readonly string[]): string | undefined {
  for (const name of names) {
    const pattern = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}\\s*>`, 'i');
    const match = pattern.exec(xml);
    if (match?.[1] !== undefined) {
      const normalized = normalizeMetadataText(match[1]);
      if (normalized !== undefined) return normalized;
    }
  }
  return undefined;
}

/** Extracts the inner text of a container element such as `<metadata>`. */
export function elementBlock(xml: string, name: string): string | undefined {
  const pattern = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}\\s*>`, 'i');
  return pattern.exec(xml)?.[1];
}

/** Returns the text of every matching element, for repeated elements. */
export function allElementTexts(xml: string, names: readonly string[]): string[] {
  for (const name of names) {
    const pattern = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}\\s*>`, 'gi');
    const found: string[] = [];
    let match = pattern.exec(xml);
    while (match !== null) {
      const normalized = normalizeMetadataText(match[1] ?? '');
      if (normalized !== undefined) found.push(normalized);
      match = pattern.exec(xml);
    }
    if (found.length > 0) return found;
  }
  return [];
}

export interface XmlTagAttributes {
  readonly [name: string]: string;
}

export function parseTagAttributes(attributes: string): XmlTagAttributes {
  const parsed: Record<string, string> = {};
  const pattern = /([A-Za-z_][\w.:-]*)\s*=\s*"([^"]*)"/g;
  let match = pattern.exec(attributes);
  while (match !== null) {
    const name = match[1];
    const value = match[2];
    if (name !== undefined && value !== undefined) {
      parsed[name.toLowerCase()] = decodeXmlEntities(value);
    }
    match = pattern.exec(attributes);
  }
  return parsed;
}

export interface XmlTag {
  readonly name: string;
  readonly attributes: XmlTagAttributes;
}

/** Finds all self-closing or paired open tags with the given name. */
export function findTags(xml: string, name: string): XmlTag[] {
  const pattern = new RegExp(`<${name}\\b([^>]*?)\\/?>`, 'gi');
  const tags: XmlTag[] = [];
  let match = pattern.exec(xml);
  while (match !== null) {
    tags.push({ name, attributes: parseTagAttributes(match[1] ?? '') });
    match = pattern.exec(xml);
  }
  return tags;
}

/** Resolves an archive-relative href against the directory holding the OPF. */
export function resolveArchivePath(baseDirectory: string, href: string): string {
  const withoutFragment = href.split('#')[0] ?? '';
  let decoded = withoutFragment;
  try {
    decoded = decodeURIComponent(withoutFragment);
  } catch {
    // Malformed percent-escapes: fall back to the raw href.
  }
  const segments = [
    ...(baseDirectory.length > 0 ? baseDirectory.split('/') : []),
    ...decoded.split('/'),
  ];
  const resolved: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }
  return resolved.join('/');
}

export function directoryOf(path: string): string {
  const separator = path.lastIndexOf('/');
  return separator === -1 ? '' : path.slice(0, separator);
}
