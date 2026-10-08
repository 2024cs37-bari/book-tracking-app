import {
  storageUnavailable,
  type BookFileStore,
  type StorageEstimate,
  type StoredFileInfo,
} from './file-store';
import { contentTypeForKey } from './mime';

// Separate binary database: the released Dexie metadata schema is untouched.
export const FILE_DB_SCHEMA_VERSION = 2;
export const DEFAULT_FILE_DB_NAME = 'book-reader-files';

export class IndexedDbBookFileStore implements BookFileStore {
  readonly kind = 'indexeddb' as const;
  readonly durable = true;
  private connection?: Promise<IDBDatabase>;
  constructor(private readonly name = DEFAULT_FILE_DB_NAME) {}

  private database(): Promise<IDBDatabase> {
    this.connection ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.name, FILE_DB_SCHEMA_VERSION);
      request.onupgradeneeded = (event) => {
        // v1 stored Blobs. v2 retains the store/keys and reads those rows lazily;
        // asynchronous Blob decoding cannot run inside a schema transaction.
        if (event.oldVersion === 0) request.result.createObjectStore('files', { keyPath: 'key' });
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          this.connection = undefined;
        };
        resolve(db);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () =>
        reject(new Error('Binary database upgrade is blocked by another tab.'));
    });
    return this.connection;
  }

  private async transaction<T>(
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    try {
      const db = await this.database();
      return await new Promise<T>((resolve, reject) => {
        const transaction = db.transaction('files', mode);
        const request = operation(transaction.objectStore('files'));
        // Resolve writes only after commit, not merely after request success.
        transaction.oncomplete = () => resolve(request.result);
        transaction.onabort = () =>
          reject(transaction.error ?? request.error ?? new Error('Binary transaction aborted.'));
        transaction.onerror = () => reject(transaction.error ?? request.error);
      });
    } catch (error) {
      throw storageUnavailable('IndexedDB file storage failed.', error);
    }
  }
  async put(key: string, data: Blob): Promise<StoredFileInfo> {
    const bytes = await data.arrayBuffer();
    const contentType = data.type || contentTypeForKey(key);
    // WebKit IDB-backed Blobs may use an origin-bound internal URL which cannot
    // be decoded after an offline navigation. ArrayBuffers are plain cloned data.
    await this.transaction('readwrite', (store) => store.put({ key, bytes, contentType }));
    return { key, sizeBytes: bytes.byteLength };
  }
  async get(key: string): Promise<Blob> {
    const row = await this.transaction<
      | { key: string; bytes: ArrayBuffer; contentType: string }
      | { key: string; blob: Blob }
      | undefined
    >('readonly', (store) => store.get(key));
    if (!row) throw new Error(`No stored file for key "${key}".`);
    if ('bytes' in row) return new Blob([row.bytes], { type: row.contentType });
    // Preserve v1 originals until they can be read successfully. Conversion is
    // committed separately, keeping bytes/MIME/key identical and never deleting.
    await this.put(key, row.blob);
    const converted = await this.transaction<{ bytes: ArrayBuffer; contentType: string }>(
      'readonly',
      (store) => store.get(key),
    );
    return new Blob([converted.bytes], { type: converted.contentType });
  }
  async has(key: string): Promise<boolean> {
    return (await this.transaction('readonly', (store) => store.count(key))) > 0;
  }
  async remove(key: string): Promise<void> {
    await this.transaction('readwrite', (store) => store.delete(key));
  }
  async keys(): Promise<string[]> {
    const keys = await this.transaction('readonly', (store) => store.getAllKeys());
    return keys.map(String).sort();
  }
  async estimate(): Promise<StorageEstimate | null> {
    if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null;
    try {
      const estimate = await navigator.storage.estimate();
      return {
        usageBytes: estimate.usage ?? null,
        quotaBytes: estimate.quota ?? null,
        persisted: await navigator.storage.persisted(),
      };
    } catch {
      return null;
    }
  }
  async close(): Promise<void> {
    (await this.connection)?.close();
    this.connection = undefined;
  }
}
