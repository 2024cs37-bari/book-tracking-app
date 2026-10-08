/**
 * Content types for stored derivatives.
 *
 * File-store keys carry a deliberate extension (a cover is stored as
 * `covers/<book id>.jpg`), so the type can always be recovered from the key.
 * That matters because OPFS reports a type inferred by the browser, and an
 * in-memory round trip would otherwise lose it entirely.
 */

const CONTENT_TYPES_BY_EXTENSION: Readonly<Record<string, string>> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  bin: 'application/octet-stream',
};

export const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

export function contentTypeForExtension(extension: string): string | undefined {
  return CONTENT_TYPES_BY_EXTENSION[extension.toLowerCase()];
}

export function contentTypeForPath(path: string): string | undefined {
  const extension = /\.([a-z0-9]+)$/i.exec(path)?.[1];
  return extension === undefined ? undefined : contentTypeForExtension(extension);
}

export function contentTypeForKey(key: string): string {
  return contentTypeForPath(key) ?? DEFAULT_CONTENT_TYPE;
}
