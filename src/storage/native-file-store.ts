import type { BookFileStore, StorageEstimate, StoredFileInfo } from './file-store';
import { storageUnavailable } from './file-store';
import { Sha256 } from './sha256';

const CHUNK_BYTES = 256 * 1024;
const MAX_ORIGINAL_BYTES = 256 * 1024 * 1024;
const MAX_COVER_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 100_000;

export type NativeInvoke = (
  command: string,
  args?: Record<string, unknown> | Uint8Array,
  options?: { headers: Record<string, string> },
) => Promise<unknown>;

export function isNativeRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function keyLimit(key: string): number {
  if (/^books\/[a-f0-9]{64}\.bin$/.test(key)) return MAX_ORIGINAL_BYTES;
  if (/^covers\/[a-zA-Z0-9_-]{1,128}\.[a-z0-9]{1,12}$/.test(key)) return MAX_COVER_BYTES;
  throw storageUnavailable('Invalid native file key.');
}

function info(value: unknown, key: string): StoredFileInfo {
  const row = value as Partial<StoredFileInfo> | null;
  if (
    !row ||
    row.key !== key ||
    typeof row.sizeBytes !== 'number' ||
    !Number.isSafeInteger(row.sizeBytes) ||
    row.sizeBytes < 0 ||
    row.sizeBytes > keyLimit(key)
  )
    throw storageUnavailable('Native file information is invalid.');
  return { key, sizeBytes: row.sizeBytes };
}

/** Narrow IPC adapter: only app-owned keys, bounded binary chunks and atomic commits. */
export class NativeBookFileStore implements BookFileStore {
  readonly kind = 'native' as const;
  readonly durable = true;

  private constructor(private readonly invoke: NativeInvoke) {}

  static async connect(invoke?: NativeInvoke): Promise<NativeBookFileStore> {
    if (!invoke) {
      if (!isNativeRuntime()) throw storageUnavailable('The native runtime is unavailable.');
      const core = await import('@tauri-apps/api/core');
      if (!core.isTauri()) throw storageUnavailable('The native runtime is unavailable.');
      invoke = core.invoke;
    }
    const bridge = invoke;
    const call: NativeInvoke = async (...args) => {
      try {
        return await bridge(...args);
      } catch (error) {
        // Tauri serializes Rust Result errors as strings. Keep their useful
        // explanation when browser-facing services expect an Error instance.
        throw error instanceof Error
          ? error
          : storageUnavailable(
              typeof error === 'string' ? error : 'The desktop file service failed.',
              error,
            );
      }
    };
    const details = (await call('native_store_info')) as Record<string, unknown> | null;
    if (
      details?.version !== 1 ||
      details.chunkBytes !== CHUNK_BYTES ||
      details.maxOriginalBytes !== MAX_ORIGINAL_BYTES ||
      details.maxCoverBytes !== MAX_COVER_BYTES
    )
      throw storageUnavailable('The desktop file service has an incompatible version.');
    return new NativeBookFileStore(call);
  }

  async put(key: string, data: Blob): Promise<StoredFileInfo> {
    if (data.size > keyLimit(key)) throw storageUnavailable('File exceeds the native size limit.');
    const result = await this.invoke('native_store_begin', { key, sizeBytes: data.size });
    if (typeof result !== 'string' || !/^[a-f0-9-]{36}$/.test(result))
      throw storageUnavailable('The native write token is invalid.');
    const token = result;
    try {
      for (let offset = 0; offset < data.size; offset += CHUNK_BYTES) {
        const bytes = new Uint8Array(await data.slice(offset, offset + CHUNK_BYTES).arrayBuffer());
        if (bytes.length !== Math.min(CHUNK_BYTES, data.size - offset))
          throw storageUnavailable('The source file changed while it was being saved.');
        await this.invoke('native_store_append', bytes, {
          headers: { 'x-book-token': token, 'x-book-offset': String(offset) },
        });
      }
      const committed = info(await this.invoke('native_store_commit', { token }), key);
      if (committed.sizeBytes !== data.size)
        throw storageUnavailable('The native write returned a different file size.');
      return committed;
    } catch (error) {
      await this.invoke('native_store_abort', { token }).catch(() => {});
      throw error;
    }
  }

  async get(key: string): Promise<Blob> {
    keyLimit(key);
    const details = await this.invoke('native_store_stat', { key });
    if (details === null) throw storageUnavailable('Original is missing from native storage.');
    const { sizeBytes } = info(details, key);
    const chunks: ArrayBuffer[] = [];
    const hash = new Sha256();
    for (let offset = 0; offset < sizeBytes; offset += CHUNK_BYTES) {
      const length = Math.min(CHUNK_BYTES, sizeBytes - offset);
      const chunk = await this.invoke('native_store_read', { key, offset, length });
      if (!(chunk instanceof ArrayBuffer) || chunk.byteLength !== length)
        throw storageUnavailable('Native file read was incomplete or changed during reading.');
      chunks.push(chunk);
      if (key.startsWith('books/')) hash.update(new Uint8Array(chunk));
    }
    if (key.startsWith('books/') && hash.hexDigest() !== key.slice(6, 70))
      throw storageUnavailable(
        'Stored original failed its SHA-256 integrity check. Restore or re-import it.',
      );
    const extension = key.split('.').at(-1);
    const type =
      extension === 'jpg' || extension === 'jpeg'
        ? 'image/jpeg'
        : extension === 'png'
          ? 'image/png'
          : extension === 'webp'
            ? 'image/webp'
            : 'application/octet-stream';
    return new Blob(chunks, { type });
  }

  async has(key: string): Promise<boolean> {
    keyLimit(key);
    const details = await this.invoke('native_store_stat', { key });
    if (details === null) return false;
    info(details, key);
    return true;
  }

  async remove(key: string): Promise<void> {
    keyLimit(key);
    await this.invoke('native_store_remove', { key });
  }

  async keys(): Promise<string[]> {
    const keys = await this.invoke('native_store_keys');
    if (!Array.isArray(keys) || keys.length > MAX_FILES)
      throw storageUnavailable('Native file listing is invalid or exceeds the supported limit.');
    for (const key of keys) {
      if (typeof key !== 'string') throw storageUnavailable('Native file listing is invalid.');
      keyLimit(key);
    }
    if (new Set(keys).size !== keys.length)
      throw storageUnavailable('Native file listing contains duplicate keys.');
    return keys as string[];
  }

  async estimate(): Promise<StorageEstimate> {
    // These describe the app-owned original store. WebView metadata remains
    // separately in IndexedDB; there is no browser quota for these native files.
    return { usageBytes: null, quotaBytes: null, persisted: true };
  }
}
