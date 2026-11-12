import { expect, test } from '@playwright/test';

test('opening a released v3 library upgrades locale-derived tag keys without changing identities, memberships or outbox bytes', async ({
  page,
}) => {
  // Create the released IndexedDB layout before loading any application code.
  await page.route('**/legacy-v3-seed', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Legacy seed</title>' }),
  );
  await page.goto('/legacy-v3-seed');
  const seed = await page.evaluate(async () => {
    const schemas: Record<string, string> = {
      books: 'id, &sha256, title, format, lifecycle, addedAt',
      progress: 'bookId, status, updatedHlc',
      changes: 'id, entity, entityId, pushedAt, createdAt',
      syncMeta: 'key',
      deviceState: 'bookId, lastOpenedAt, pinnedOffline',
      fileTransfers: 'id, sha256, direction, state, updatedAt',
      annotations: 'id, bookId, createdHlc, updatedHlc',
      shelves: 'id, name, updatedHlc',
      shelfBooks: '[shelfId+bookId], shelfId, bookId, addedHlc',
      tags: 'id, normalizedName, updatedHlc',
      bookTags: '[tagId+bookId], tagId, bookId, addedHlc',
      sessions: 'id, bookId, startedAt',
      progressConflicts: 'bookId',
    };
    const keyPath = (key: string) => (key.startsWith('[') ? key.slice(1, -1).split('+') : key);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      // Dexie maps logical version 3 to native IndexedDB version 30.
      const request = indexedDB.open('book-reader', 30);
      request.onupgradeneeded = () => {
        for (const [name, definition] of Object.entries(schemas)) {
          const [primary, ...indexes] = definition.split(',').map((part) => part.trim());
          const store = request.result.createObjectStore(name, { keyPath: keyPath(primary!) });
          for (const declaration of indexes) {
            const unique = declaration.startsWith('&');
            const index = unique ? declaration.slice(1) : declaration;
            store.createIndex(index, keyPath(index), { unique });
          }
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const at = Date.now() - 60_000;
    const hlc = `${at}:0:legacy-device`;
    const book = {
      id: '10000000-0000-4000-8000-000000000001',
      sha256: 'a'.repeat(64),
      title: 'Legacy library book',
      format: 'pdf',
      sizeBytes: 123,
      metadataIncomplete: false,
      lifecycle: 'active',
      addedAt: at,
      updatedHlc: hlc,
    };
    const tags = [
      { name: 'I', normalizedName: 'ı' },
      { name: 'İ', normalizedName: 'i' },
      { name: 'Ì', normalizedName: 'i\u0307\u0300' },
      { name: 'I', normalizedName: 'i' },
      { name: 'I', normalizedName: 'ı', deleted: true },
    ].map((tag, index) => ({
      id: `20000000-0000-4000-8000-00000000000${index + 1}`,
      updatedHlc: hlc,
      deleted: false,
      ...tag,
    }));
    const memberships = tags.map((tag) => ({
      tagId: tag.id,
      bookId: book.id,
      addedHlc: hlc,
      ...(tag.deleted ? { removedHlc: hlc } : {}),
    }));
    const changes = tags.map((tag, index) => ({
      id: `30000000-0000-4000-8000-00000000000${index + 1}`,
      entity: 'tag',
      entityId: tag.id,
      op: tag.deleted ? 'delete' : 'upsert',
      payload: JSON.stringify(tag),
      hlc,
      deviceId: 'legacy-device',
      createdAt: at,
      pushedAt: index === 0 ? at + 1 : 0,
    }));
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(['books', 'tags', 'bookTags', 'changes'], 'readwrite');
        tx.objectStore('books').put(book);
        for (const tag of tags) tx.objectStore('tags').put(tag);
        for (const membership of memberships) tx.objectStore('bookTags').put(membership);
        for (const change of changes) tx.objectStore('changes').put(change);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
      return { book, tags, memberships, changes };
    } finally {
      db.close();
    }
  });

  await page.goto('/');
  await expect(page.getByRole('link', { name: /^Legacy library book/ })).toBeVisible();
  const upgraded = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('book-reader');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const read = (name: string) =>
        new Promise<unknown[]>((resolve, reject) => {
          const request = db.transaction(name).objectStore(name).getAll();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      return {
        version: db.version,
        books: await read('books'),
        tags: await read('tags'),
        memberships: await read('bookTags'),
        changes: await read('changes'),
      };
    } finally {
      db.close();
    }
  });
  expect(upgraded.version).toBe(40);
  expect(upgraded.books).toEqual([seed.book]);
  const expectedKeys = ['i', 'i\u0307', 'ì', 'i', 'i'];
  expect(upgraded.tags).toEqual(
    seed.tags.map((tag, index) => ({ ...tag, normalizedName: expectedKeys[index] })),
  );
  expect(upgraded.memberships).toEqual(seed.memberships);
  expect(upgraded.changes).toEqual(seed.changes);
  await page.reload();
  await expect(page.getByRole('link', { name: /^Legacy library book/ })).toBeVisible();
});
