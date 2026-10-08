import type { BookFileStore, StorageEstimate, StoredFileInfo } from './file-store';
import { contentTypeForKey } from './mime';

interface StoredEntry {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly contentType: string;
}

/**
 * In-memory file store.
 *
 * Used by tests and as an explicit fallback when the browser has no usable
 * OPFS. It is not durable: bytes are lost on reload, which is why `durable` is
 * false and the UI surfaces a warning instead of silently pretending books are
 * available offline.
 */
export class MemoryBookFileStore implements BookFileStore {
  readonly kind = 'memory' as const;
  readonly durable = false;

  private readonly files = new Map<string, StoredEntry>();

  async put(key: string, data: Blob): Promise<StoredFileInfo> {
    const bytes = new Uint8Array(await data.arrayBuffer());
    // Preserve the declared type, falling back to the type implied by the key.
    this.files.set(key, {
      bytes,
      contentType: data.type.length > 0 ? data.type : contentTypeForKey(key),
    });
    return { key, sizeBytes: bytes.byteLength };
  }

  async get(key: string): Promise<Blob> {
    const entry = this.files.get(key);
    if (entry === undefined) {
      throw new Error(`No stored file for key "${key}".`);
    }
    // Copy so callers cannot mutate the stored buffer.
    return new Blob([new Uint8Array(entry.bytes)], { type: entry.contentType });
  }

  async has(key: string): Promise<boolean> {
    return this.files.has(key);
  }

  async remove(key: string): Promise<void> {
    this.files.delete(key);
  }

  async keys(): Promise<string[]> {
    return [...this.files.keys()];
  }

  async estimate(): Promise<StorageEstimate | null> {
    let usageBytes = 0;
    for (const entry of this.files.values()) {
      usageBytes += entry.bytes.byteLength;
    }
    return { usageBytes, quotaBytes: null, persisted: false };
  }
}
