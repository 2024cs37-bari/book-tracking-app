import { unzipSync } from 'fflate';

export const MAX_EPUB_BYTES = 256 * 1024 * 1024;
export const MAX_EPUB_ENTRY_BYTES = 64 * 1024 * 1024;
export const MAX_EPUB_ENTRIES = 10_000;

/** Preflight every central entry before any inflation, then read selected files. */
export function openEpubArchive(bytes: Uint8Array) {
  if (bytes.byteLength > MAX_EPUB_BYTES) throw new Error('EPUB exceeds the 256 MiB reader limit.');
  const entries = new Map<string, number>();
  let expanded = 0;
  unzipSync(bytes, {
    filter(entry) {
      const name = entry.name;
      if (
        !name ||
        name.length > 1024 ||
        name.includes('\\') ||
        name.includes('\0') ||
        name.startsWith('/') ||
        name.split('/').includes('..') ||
        entries.has(name) ||
        name === '__proto__'
      ) {
        throw new Error('EPUB contains duplicate or unsafe archive paths.');
      }
      if (entries.size >= MAX_EPUB_ENTRIES) throw new Error('EPUB has too many archive entries.');
      if (![0, 8].includes(entry.compression))
        throw new Error('EPUB uses an unsupported archive compression method.');
      if (
        !Number.isSafeInteger(entry.originalSize) ||
        entry.originalSize < 0 ||
        entry.originalSize > MAX_EPUB_ENTRY_BYTES
      ) {
        throw new Error('EPUB expanded entry exceeds the 64 MiB reader limit.');
      }
      expanded += entry.originalSize;
      if (expanded > MAX_EPUB_BYTES)
        throw new Error('EPUB expanded content exceeds the 256 MiB reader limit.');
      entries.set(name, entry.originalSize);
      return false;
    },
  });
  return {
    read(name: string, maxBytes: number): Uint8Array | undefined {
      const size = entries.get(name);
      if (size === undefined) return undefined;
      if (size > maxBytes)
        throw new Error(
          `EPUB resource exceeds its ${Math.round(maxBytes / 1024)} KiB extraction limit.`,
        );
      const extracted = unzipSync(bytes, { filter: (entry) => entry.name === name })[name];
      if (!extracted || extracted.byteLength !== size)
        throw new Error('EPUB resource length is inconsistent.');
      return extracted;
    },
    extractAll(): Record<string, Uint8Array> {
      // All entries and the aggregate expansion have already been checked.
      const files = unzipSync(bytes);
      for (const [name, size] of entries) {
        if (!Object.hasOwn(files, name) || files[name]!.byteLength !== size)
          throw new Error('EPUB resource length is inconsistent.');
      }
      return files;
    },
  };
}
