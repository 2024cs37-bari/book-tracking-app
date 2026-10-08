import { MemoryBookFileStore } from './memory-file-store';
import { OpfsBookFileStore, isOpfsSupported } from './opfs-file-store';
import { IndexedDbBookFileStore } from './indexeddb-file-store';
import type { BookFileStore } from './file-store';

export type FileStorePreference = 'auto' | 'opfs' | 'memory';

export interface FileStoreSelection {
  readonly store: BookFileStore;
  /** Reason a non-preferred adapter was chosen; null when the preferred one worked. */
  readonly fallbackReason: string | null;
}

const PROBE_KEY = 'books/probe.bin';
const PROBE_BYTES = new Uint8Array([0x62, 0x6f, 0x6f, 0x6b]);

/**
 * Proves the OPFS adapter can complete a write/read/remove cycle.
 *
 * Capability detection alone is not enough: private browsing modes and
 * restricted contexts can expose the API and still fail on write, and a store
 * that fails at import time is much worse than an honest fallback.
 */
async function probeOpfs(store: OpfsBookFileStore): Promise<string | null> {
  try {
    await store.put(PROBE_KEY, new Blob([PROBE_BYTES]));
    const roundTripped = new Uint8Array(await (await store.get(PROBE_KEY)).arrayBuffer());
    if (roundTripped.length !== PROBE_BYTES.length) {
      return 'OPFS probe returned a different byte count than was written.';
    }
    await store.remove(PROBE_KEY);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : 'OPFS probe failed.';
  }
}

export async function selectBookFileStore(
  preference: FileStorePreference = 'auto',
): Promise<FileStoreSelection> {
  if (preference === 'memory') {
    return { store: new MemoryBookFileStore(), fallbackReason: 'Memory storage was requested.' };
  }

  if (!isOpfsSupported()) {
    // Requesting 'opfs' explicitly cannot be honoured either; probe the durable
    // binary fallback before resorting to memory.
    return durableFallback('This browser does not expose the Origin Private File System.');
  }

  const opfs = new OpfsBookFileStore();
  const failure = await probeOpfs(opfs);
  if (failure === null) {
    return { store: opfs, fallbackReason: null };
  }
  return durableFallback(`Origin Private File System was unusable: ${failure}`);
}

async function durableFallback(reason: string): Promise<FileStoreSelection> {
  const store = new IndexedDbBookFileStore();
  try {
    await store.put(PROBE_KEY, new Blob([PROBE_BYTES]));
    const bytes = new Uint8Array(await (await store.get(PROBE_KEY)).arrayBuffer());
    if (
      bytes.length !== PROBE_BYTES.length ||
      !bytes.every((byte, index) => byte === PROBE_BYTES[index])
    )
      throw new Error('IndexedDB probe bytes differed.');
    await store.remove(PROBE_KEY);
    return { store, fallbackReason: `${reason} Files use durable IndexedDB storage instead.` };
  } catch (error) {
    await store.close().catch(() => {});
    return {
      store: new MemoryBookFileStore(),
      fallbackReason: `${reason} IndexedDB file storage was unusable: ${String(error)}. Files are kept in memory only.`,
    };
  }
}

/**
 * Asks the browser to keep this origin's data.
 *
 * A denial is not an error: local storage is treated as a cache, and the server
 * copy becomes the durable one. Callers should surface the result, not fail.
 */
export async function requestPersistentStorage(): Promise<boolean | null> {
  if (typeof navigator === 'undefined' || typeof navigator.storage?.persist !== 'function') {
    return null;
  }
  try {
    if (
      typeof navigator.storage.persisted === 'function' &&
      (await navigator.storage.persisted())
    ) {
      return true;
    }
    // Firefox may keep a permission prompt pending. Optional persistence must
    // never prevent the library from booting; null means no answer yet.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        navigator.storage.persist(),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), 1500);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}
