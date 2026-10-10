import {
  splitKey,
  storageUnavailable,
  type BookFileStore,
  type StorageEstimate,
  type StoredFileInfo,
} from './file-store';
import { contentTypeForKey } from './mime';

const ROOT_DIRECTORY = 'book-reader';

/** Feature-detects OPFS without performing a write. */
export function isOpfsSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.storage?.getDirectory === 'function' &&
    typeof FileSystemFileHandle !== 'undefined'
  );
}

/**
 * Origin Private File System adapter.
 *
 * OPFS is the preferred browser store because it keeps book bytes out of
 * IndexedDB, where large binary values inflate the metadata database. Bytes
 * stream straight to the content-addressed key; `createWritable` commits
 * atomically on `close()`, so an interrupted write leaves any previous file
 * under that key untouched rather than truncating it.
 */
export class OpfsBookFileStore implements BookFileStore {
  readonly kind = 'opfs' as const;
  readonly durable = true;

  private rootPromise: Promise<FileSystemDirectoryHandle> | null = null;

  private root(): Promise<FileSystemDirectoryHandle> {
    this.rootPromise ??= navigator.storage
      .getDirectory()
      .then((originRoot) => originRoot.getDirectoryHandle(ROOT_DIRECTORY, { create: true }));
    return this.rootPromise;
  }

  private async resolveDirectory(
    key: string,
    options: { create: boolean },
  ): Promise<{ directory: FileSystemDirectoryHandle; name: string }> {
    const { directories, name } = splitKey(key);
    let directory = await this.root();
    for (const segment of directories) {
      directory = await directory.getDirectoryHandle(segment, { create: options.create });
    }
    return { directory, name };
  }

  async put(key: string, data: Blob): Promise<StoredFileInfo> {
    try {
      const { directory, name } = await this.resolveDirectory(key, { create: true });
      const handle = await directory.getFileHandle(name, { create: true });

      // createWritable commits atomically when close() resolves: an interrupted
      // write leaves any previous file untouched. That lets bytes stream
      // straight to the content-addressed key without a staging copy.
      const stream = await handle.createWritable();
      const reader = data.stream().getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          await stream.write(value);
        }
        await stream.close();
      } catch (error) {
        await stream.abort().catch(() => undefined);
        throw error;
      } finally {
        reader.releaseLock();
      }

      const stored = await handle.getFile();
      return { key, sizeBytes: stored.size };
    } catch (error) {
      throw storageUnavailable(`Could not write "${key}" to the local file store.`, error);
    }
  }

  async get(key: string): Promise<Blob> {
    try {
      const { directory, name } = await this.resolveDirectory(key, { create: false });
      const handle = await directory.getFileHandle(name);
      const file = await handle.getFile();
      // The browser infers a type from the extension; fall back to the type
      // implied by the key when it cannot.
      const type = file.type.length > 0 ? file.type : contentTypeForKey(key);
      return new Blob([await file.arrayBuffer()], { type });
    } catch (error) {
      throw storageUnavailable(`Could not read "${key}" from the local file store.`, error);
    }
  }

  async has(key: string): Promise<boolean> {
    try {
      const { directory, name } = await this.resolveDirectory(key, { create: false });
      await directory.getFileHandle(name);
      return true;
    } catch {
      return false;
    }
  }

  async remove(key: string): Promise<void> {
    try {
      const { directory, name } = await this.resolveDirectory(key, { create: false });
      await directory.removeEntry(name);
    } catch (error) {
      // Removing something that is already gone is a no-op, not a failure.
      const isMissing = error instanceof DOMException && error.name === 'NotFoundError';
      if (isMissing) return;
      throw storageUnavailable(`Could not remove "${key}" from the local file store.`, error);
    }
  }

  async keys(): Promise<string[]> {
    const collected: string[] = [];
    const walk = async (directory: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
      for await (const [name, handle] of directory.entries()) {
        const key = prefix.length > 0 ? `${prefix}/${name}` : name;
        if (handle.kind === 'file') {
          collected.push(key);
        } else {
          await walk(handle, key);
        }
      }
    };
    try {
      await walk(await this.root(), '');
      return collected.sort();
    } catch (error) {
      throw storageUnavailable('Could not enumerate the local file store.', error);
    }
  }

  async estimate(): Promise<StorageEstimate | null> {
    if (typeof navigator === 'undefined' || typeof navigator.storage?.estimate !== 'function') {
      return null;
    }
    try {
      const estimate = await navigator.storage.estimate();
      let persisted: boolean | null = null;
      if (typeof navigator.storage.persisted === 'function') {
        persisted = await navigator.storage.persisted();
      }
      return {
        usageBytes: estimate.usage ?? null,
        quotaBytes: estimate.quota ?? null,
        persisted,
      };
    } catch {
      return null;
    }
  }
}
