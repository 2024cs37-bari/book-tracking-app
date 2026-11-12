import Dexie from 'dexie';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { newId } from '~/domain/ids';
import {
  createDatabase,
  DB_LOCAL_VERSION,
  type BookRow,
  type TagRow,
  type ChangeRow,
} from '~/data/db';

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

it('upgrades a v1 database to the current version without losing existing rows', async () => {
  const seeded = await seedV1();

  const db = createDatabase(name);
  await db.open();
  try {
    expect(db.verno).toBe(DB_LOCAL_VERSION);
    const book = await db.books.get(seeded.id);
    expect(book?.title).toBe('Pre-existing Book');

    // The v2 and v3 tables exist and are writable on the upgraded database.
    for (const table of [
      'annotations',
      'shelves',
      'shelfBooks',
      'tags',
      'bookTags',
      'sessions',
      'progressConflicts',
    ]) {
      expect(db.tables.map((t) => t.name)).toContain(table);
    }
    await db.shelves.add({ id: newId(), name: 'New Shelf', updatedHlc: '1:0:d', deleted: false });
    expect(await db.shelves.count()).toBe(1);
  } finally {
    db.close();
  }
});

it('creates a fresh database directly at the current version', async () => {
  const db = createDatabase(name);
  await db.open();
  try {
    expect(db.verno).toBe(DB_LOCAL_VERSION);
    expect(await db.sessions.count()).toBe(0);
    expect(await db.annotations.count()).toBe(0);
    expect(await db.progressConflicts.count()).toBe(0);
  } finally {
    db.close();
  }
});

it('upgrades v3 tag lookup keys without changing identities, memberships, clocks or outbox bytes', async () => {
  const book = await seedV1();
  const legacy = new Dexie(name);
  legacy.version(3).stores({
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
  });
  await legacy.open();
  const stamp = '1700000000000:0:device';
  const tags: TagRow[] = [
    { id: 'turkish', name: 'I', normalizedName: 'ı', updatedHlc: stamp, deleted: false },
    { id: 'default', name: 'I', normalizedName: 'i', updatedHlc: stamp, deleted: false },
    {
      id: 'lithuanian',
      name: 'Ì',
      normalizedName: 'i\u0307\u0300',
      updatedHlc: stamp,
      deleted: true,
    },
  ];
  const memberships = tags.map((tag) => ({ tagId: tag.id, bookId: book.id, addedHlc: stamp }));
  const changes: ChangeRow[] = tags.map((tag, index) => ({
    id: `change-${index}`,
    entity: 'tag',
    entityId: tag.id,
    op: tag.deleted ? 'delete' : 'upsert',
    payload: JSON.stringify(tag),
    hlc: stamp,
    deviceId: 'device',
    createdAt: 1700000000000,
    pushedAt: index === 0 ? 0 : 1700000000001,
  }));
  await legacy.table('tags').bulkAdd(tags);
  await legacy.table('bookTags').bulkAdd(memberships);
  await legacy.table('changes').bulkAdd(changes);
  legacy.close();

  const db = createDatabase(name);
  await db.open();
  try {
    expect(db.verno).toBe(4);
    for (const tag of tags) {
      expect(await db.tags.get(tag.id)).toEqual({ ...tag, normalizedName: tag.name.toLowerCase() });
    }
    expect(await db.tags.where('normalizedName').equals('i').count()).toBe(2);
    expect(await db.tags.count()).toBe(3);
    expect(await db.bookTags.toArray()).toEqual(
      [...memberships].sort((a, b) => a.tagId.localeCompare(b.tagId)),
    );
    expect(await db.changes.toArray()).toEqual(changes);
    expect(await db.books.get(book.id)).toEqual(book);
    db.close();
    await db.open();
    expect(await db.tags.count()).toBe(3);
    expect(await db.changes.toArray()).toEqual(changes);
  } finally {
    db.close();
  }
});
