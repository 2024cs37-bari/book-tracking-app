import Dexie from 'dexie';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { newId } from '~/domain/ids';
import { createDatabase, DB_SCHEMA_VERSION, type BookRow } from '~/data/db';

let name: string;

beforeEach(() => {
  name = `migrate-${newId()}`;
});

afterEach(async () => {
  await Dexie.delete(name);
});

/** Opens a database at the released v1 schema only, as a pre-upgrade client had it. */
async function seedV1(): Promise<BookRow> {
  const legacy = new Dexie(name);
  legacy.version(1).stores({
    books: 'id, &sha256, title, format, lifecycle, addedAt',
    progress: 'bookId, status, updatedHlc',
    changes: 'id, entity, entityId, pushedAt, createdAt',
    syncMeta: 'key',
    deviceState: 'bookId, lastOpenedAt, pinnedOffline',
    fileTransfers: 'id, sha256, direction, state, updatedAt',
  });
  await legacy.open();
  const book: BookRow = {
    id: newId(),
    sha256: 'a'.repeat(64),
    title: 'Pre-existing Book',
    format: 'epub',
    sizeBytes: 123,
    metadataIncomplete: false,
    lifecycle: 'active',
    addedAt: 1_700_000_000_000,
    updatedHlc: '1700000000000:0:device',
  };
  await legacy.table<BookRow, string>('books').add(book);
  legacy.close();
  return book;
}

it('upgrades a v1 database to v2 without losing existing rows', async () => {
  const seeded = await seedV1();

  const db = createDatabase(name);
  await db.open();
  try {
    expect(db.verno).toBe(DB_SCHEMA_VERSION);
    const book = await db.books.get(seeded.id);
    expect(book?.title).toBe('Pre-existing Book');

    // The v2 tables exist and are writable on the upgraded database.
    for (const table of ['annotations', 'shelves', 'shelfBooks', 'tags', 'bookTags', 'sessions']) {
      expect(db.tables.map((t) => t.name)).toContain(table);
    }
    await db.shelves.add({ id: newId(), name: 'New Shelf', updatedHlc: '1:0:d', deleted: false });
    expect(await db.shelves.count()).toBe(1);
  } finally {
    db.close();
  }
});

it('creates a fresh database directly at v2', async () => {
  const db = createDatabase(name);
  await db.open();
  try {
    expect(db.verno).toBe(DB_SCHEMA_VERSION);
    expect(await db.sessions.count()).toBe(0);
    expect(await db.annotations.count()).toBe(0);
  } finally {
    db.close();
  }
});
