import { afterEach, expect, it, vi } from 'vitest';
import { IndexedDbBookFileStore } from '~/storage/indexeddb-file-store';
import { requestPersistentStorage, selectBookFileStore } from '~/storage/create-file-store';

const stores: IndexedDbBookFileStore[] = [];
const names: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const store of stores.splice(0)) await store.close();
  for (const name of names.splice(0))
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
});

it('commits binary originals, survives reopening, preserves MIME and removes only requested keys', async () => {
  const name = `files-${crypto.randomUUID()}`;
  names.push(name);
  const first = new IndexedDbBookFileStore(name);
  stores.push(first);
  await first.put('books/one.bin', new Blob(['original'], { type: 'application/epub+zip' }));
  await first.put('covers/two.png', new Blob(['cover']));
  await first.close();
  const reopened = new IndexedDbBookFileStore(name);
  stores.push(reopened);
  expect(reopened.durable).toBe(true);
  expect(await reopened.keys()).toEqual(['books/one.bin', 'covers/two.png']);
  const book = await reopened.get('books/one.bin');
  expect(await book.text()).toBe('original');
  expect(book.type).toBe('application/epub+zip');
  expect((await reopened.get('covers/two.png')).type).toBe('image/png');
  await reopened.remove('covers/two.png');
  expect(await reopened.has('covers/two.png')).toBe(false);
  expect(await reopened.has('books/one.bin')).toBe(true);
  await expect(reopened.get('absent')).rejects.toThrow('No stored file');
});

it('chooses probed durable IndexedDB when OPFS is unavailable', async () => {
  vi.stubGlobal('navigator', {});
  const selection = await selectBookFileStore();
  const store = selection.store as IndexedDbBookFileStore;
  stores.push(store);
  names.push('book-reader-files');
  expect(store.kind).toBe('indexeddb');
  expect(store.durable).toBe(true);
  expect(await store.keys()).toEqual([]);
  expect(selection.fallbackReason).toContain('durable IndexedDB');
});

it('an unanswered persistence permission request has a bounded wait', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('navigator', {
    storage: { persisted: async () => false, persist: () => new Promise<boolean>(() => {}) },
  });
  const request = requestPersistentStorage();
  await vi.advanceTimersByTimeAsync(1500);
  expect(await request).toBeNull();
});
