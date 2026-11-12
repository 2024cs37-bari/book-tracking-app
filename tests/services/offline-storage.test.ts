import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OfflineStorageService } from '~/services/offline-storage-service';
import { BookFileLeases } from '~/storage/book-file-leases';
import { bookFileKey, type BookFileStore } from '~/storage/file-store';
import { createHarness, type TestHarness } from '../support/harness';
import { buildEpubFixture, toBlob } from '../support/fixtures';

let h: TestHarness;
let leases: BookFileLeases;
let files: BookFileStore;
beforeEach(async () => {
  h = await createHarness();
  leases = new BookFileLeases();
  files = Object.create(h.files) as BookFileStore;
  Object.defineProperty(files, 'durable', { value: true });
});
afterEach(async () => {
  await h.close();
});

async function add(title: string) {
  const result = await h.imports.importFile({
    blob: toBlob(buildEpubFixture({ title })),
    filename: `${title}.epub`,
  });
  if (result.status !== 'imported') throw new Error('Import failed');
  return result.book;
}

it('evicts oldest remote-backed originals while preserving pins, open books and metadata', async () => {
  const oldest = await add('Oldest');
  const pinned = await add('Pinned');
  const open = await add('Open');
  const unbacked = await add('Local only');
  await h.deviceState.markOpened(oldest.id, 1);
  const verifyRemote = vi.fn(async (hash: string) => hash !== unbacked.sha256);
  const service = new OfflineStorageService({ ...h, files, leases, verifyRemote });
  await service.setPinned(pinned.id, true);
  const release = await leases.acquire(open.sha256);
  try {
    const result = await service.trimToBudget(0);
    expect(result.removedBooks).toBe(1);
    expect(result.targetMet).toBe(false);
    expect(await files.has(bookFileKey(oldest.sha256))).toBe(false);
    for (const book of [pinned, open, unbacked])
      expect(await files.has(bookFileKey(book.sha256))).toBe(true);
    expect(await h.db.books.count()).toBe(4);
    expect((await h.deviceState.get(oldest.id))?.filePresent).toBe(false);
    expect(verifyRemote).not.toHaveBeenCalledWith(open.sha256, open.sizeBytes);
  } finally {
    release();
  }
});

it('does not remove anything when remote verification fails', async () => {
  const book = await add('Network failure');
  const service = new OfflineStorageService({
    ...h,
    files,
    leases,
    verifyRemote: async () => {
      throw new Error('Offline');
    },
  });
  await expect(service.trimToBudget(0)).rejects.toThrow('Offline');
  expect(await files.has(bookFileKey(book.sha256))).toBe(true);
});

it('preserves a pin moved to a canonical identity during remote verification', async () => {
  const book = await add('Canonical pin');
  const canonicalId = 'canonical-book';
  const service = new OfflineStorageService({
    ...h,
    files,
    leases,
    verifyRemote: async () => {
      await h.db.transaction('rw', h.db.books, h.db.deviceState, async () => {
        await h.db.books.delete(book.id);
        await h.db.books.add({ ...book, id: canonicalId });
        await h.db.deviceState.delete(book.id);
        await h.db.deviceState.put({
          bookId: canonicalId,
          filePresent: true,
          pinnedOffline: true,
        });
      });
      return true;
    },
  });
  expect((await service.trimToBudget(0)).removedBooks).toBe(0);
  expect(await files.has(bookFileKey(book.sha256))).toBe(true);
  expect((await h.deviceState.get(canonicalId))?.pinnedOffline).toBe(true);
  expect(await h.deviceState.get(book.id)).toBeUndefined();
});

it('preserves originals tombstoned while remote verification is pending', async () => {
  const book = await add('Deleted during HEAD');
  const service = new OfflineStorageService({
    ...h,
    files,
    leases,
    verifyRemote: async () => {
      await h.db.books.update(book.id, { lifecycle: 'deleted', deletedAt: Date.now() });
      return true;
    },
  });
  expect((await service.trimToBudget(0)).removedBooks).toBe(0);
  expect(await files.has(bookFileKey(book.sha256))).toBe(true);
});

it('pins the canonical book if sync replaces its UUID during original verification', async () => {
  const book = await add('Canonical during pin');
  const canonicalId = 'canonical-pinned-book';
  const get = files.get.bind(files);
  files.get = async (key) => {
    const blob = await get(key);
    await h.db.transaction('rw', h.db.books, h.db.deviceState, async () => {
      await h.db.books.delete(book.id);
      await h.db.books.add({ ...book, id: canonicalId });
      const state = await h.db.deviceState.get(book.id);
      await h.db.deviceState.delete(book.id);
      if (state) await h.db.deviceState.put({ ...state, bookId: canonicalId });
    });
    return blob;
  };
  const service = new OfflineStorageService({ ...h, files, leases });
  await service.setPinned(book.id, true);
  expect((await h.deviceState.get(canonicalId))?.pinnedOffline).toBe(true);
  expect(await h.deviceState.get(book.id)).toBeUndefined();
});

it('refuses to pin missing, damaged or non-durable files', async () => {
  const book = await add('Pin integrity');
  const service = new OfflineStorageService({ ...h, files, leases });
  await files.remove(bookFileKey(book.sha256));
  await expect(service.setPinned(book.id, true)).rejects.toThrow('Download');
  await files.put(bookFileKey(book.sha256), new Blob(['damaged']));
  await expect(service.setPinned(book.id, true)).rejects.toThrow('integrity');
  expect((await h.deviceState.get(book.id))?.pinnedOffline).toBe(false);
  await expect(
    new OfflineStorageService({ ...h, leases }).setPinned(book.id, true),
  ).rejects.toThrow('durable');
});

it('device-local concurrent updates preserve pin, presence and recency together', async () => {
  const book = await add('Concurrency');
  await Promise.all([
    h.deviceState.setPinned(book.id, true),
    h.deviceState.markOpened(book.id, 123),
    h.deviceState.setFilePresent(book.id, true),
  ]);
  expect(await h.deviceState.get(book.id)).toEqual({
    bookId: book.id,
    pinnedOffline: true,
    lastOpenedAt: 123,
    filePresent: true,
  });
});

it('re-import repairs an evicted or corrupted original without overwriting metadata', async () => {
  const book = await add('Original');
  await h.books.updateMetadata(book.id, { title: 'My title' });
  const key = bookFileKey(book.sha256);
  for (const damaged of [false, true]) {
    await files.remove(key);
    if (damaged) await files.put(key, new Blob(['corrupt']));
    const result = await h.imports.importFile({
      blob: toBlob(buildEpubFixture({ title: 'Original' })),
      filename: 'recovery.epub',
    });
    expect(result.status).toBe('duplicate');
    expect(await files.has(key)).toBe(true);
    expect((await h.books.getById(book.id))?.title).toBe('My title');
    expect((await h.deviceState.get(book.id))?.filePresent).toBe(true);
  }
});
