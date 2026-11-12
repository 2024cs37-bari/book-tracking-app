import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type TestHarness } from '../support/harness';
import { buildEpubFixture, toBlob } from '../support/fixtures';
import { EXPORT_FORMAT, ExportService } from '~/services/export-service';
import { applyPullPage } from '~/sync/apply';

let harness: TestHarness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness.close();
});

async function importBook(title = 'Book'): Promise<string> {
  const outcome = await harness.imports.importFile({
    blob: toBlob(buildEpubFixture({ title })),
    filename: `${title}.epub`,
  });
  if (outcome.status !== 'imported') throw new Error(`import failed: ${outcome.status}`);
  return outcome.book.id;
}

const BOOKMARK = (bookId: string) => ({
  bookId,
  kind: 'bookmark' as const,
  locator: { kind: 'cfi' as const, value: 'epubcfi(/6/4!/2)', fraction: 0.25 },
});

describe('shelves', () => {
  it('creates a shelf, records it in the outbox, and lists it', async () => {
    const before = await harness.changes.pendingCount();
    const shelf = await harness.shelves.create('  Favorites  ');
    expect(shelf.name).toBe('Favorites');
    expect((await harness.shelves.list()).map((s) => s.name)).toEqual(['Favorites']);
    const pending = await harness.changes.listPending();
    expect(pending.at(-1)).toMatchObject({ entity: 'shelf', entityId: shelf.id });
    expect(await harness.changes.pendingCount()).toBe(before + 1);
  });

  it('tracks membership with add/remove and records a shelf_book change each time', async () => {
    const bookId = await importBook('Shelved');
    const shelf = await harness.shelves.create('Reading');

    await harness.shelves.addBook(shelf.id, bookId);
    expect(await harness.shelves.listBookIds(shelf.id)).toEqual([bookId]);
    expect(await harness.shelves.listShelfIdsForBook(bookId)).toEqual([shelf.id]);

    await harness.shelves.removeBook(shelf.id, bookId);
    expect(await harness.shelves.listBookIds(shelf.id)).toEqual([]);

    const membershipChanges = (await harness.changes.listPending()).filter(
      (c) => c.entity === 'shelf_book',
    );
    expect(membershipChanges).toHaveLength(2);
    expect(membershipChanges[0]!.entityId).toBe(`${shelf.id}:${bookId}`);
  });

  it('rejects a blank shelf name and tombstones on remove', async () => {
    await expect(harness.shelves.create('   ')).rejects.toThrow(/must not be empty/i);
    const shelf = await harness.shelves.create('Temp');
    await harness.shelves.remove(shelf.id);
    expect(await harness.shelves.list()).toHaveLength(0);
  });

  it('drops a deleted shelf from a book reverse lookup', async () => {
    const bookId = await importBook('OnDeletedShelf');
    const shelf = await harness.shelves.create('Doomed');
    await harness.shelves.addBook(shelf.id, bookId);
    expect(await harness.shelves.listShelfIdsForBook(bookId)).toEqual([shelf.id]);

    await harness.shelves.remove(shelf.id);
    expect(await harness.shelves.listShelfIdsForBook(bookId)).toEqual([]);
  });
});

describe('tags', () => {
  it('renames one stable tag, retains memberships, and replicates the name without echo', async () => {
    const bookId = await importBook('Renamed tag');
    const tag = await harness.tags.ensure('Draft');
    await harness.tags.tagBook(tag.id, bookId);
    const membership = await harness.db.bookTags.get([tag.id, bookId]);
    const originalChanges = await harness.changes.listPending();
    const renamed = await harness.tags.rename(tag.id, '  Finished   Notes  ');
    expect(renamed).toMatchObject({
      id: tag.id,
      name: 'Finished Notes',
      normalizedName: 'finished notes',
    });
    expect(await harness.db.bookTags.get([tag.id, bookId])).toEqual(membership);
    expect(await harness.tags.ensure('FINISHED notes')).toEqual(renamed);
    const changes = await harness.changes.listPending();
    expect(changes).toHaveLength(originalChanges.length + 1);
    for (const original of originalChanges)
      expect(changes.find((row) => row.id === original.id)).toEqual(original);

    const other = await createHarness();
    try {
      await applyPullPage(
        other.db,
        other.syncMeta,
        other.clock,
        changes.map((change, index) => ({
          seq: index + 1,
          change_id: change.id,
          entity: change.entity,
          entity_id: change.entityId,
          hlc: change.hlc,
          payload: JSON.parse(change.payload),
        })),
        changes.length,
      );
      expect(await other.tags.list()).toEqual([renamed]);
      expect(await other.tags.listBookIds(tag.id)).toEqual([bookId]);
      expect(await other.changes.pendingCount()).toBe(0);
    } finally {
      await other.close();
    }
  });

  it('rejects occupied names and invalid/deleted targets without changing rows or outbox', async () => {
    const tag = await harness.tags.ensure('Original');
    await harness.tags.ensure('Taken name');
    const deleted = await harness.tags.ensure('Deleted');
    await harness.tags.remove(deleted.id);
    const before = await harness.changes.listPending();
    await expect(harness.tags.rename(tag.id, ' TAKEN   name ')).rejects.toThrow(/already uses/);
    await expect(harness.tags.rename(tag.id, '  ')).rejects.toThrow(/must not be empty/);
    await expect(harness.tags.rename(tag.id, 'x'.repeat(201))).rejects.toThrow(/200/);
    await expect(harness.tags.rename(deleted.id, 'Back')).rejects.toThrow(/no longer exists/);
    await expect(harness.tags.rename('missing', 'Back')).rejects.toThrow(/no longer exists/);
    expect(await harness.tags.rename(tag.id, ' Original ')).toEqual(tag);
    expect(await harness.changes.listPending()).toEqual(before);
    expect(await harness.tags.rename(tag.id, 'Deleted')).toMatchObject({
      id: tag.id,
      name: 'Deleted',
    });
  });

  it('serializes competing renames so only one tag takes an available name', async () => {
    const first = await harness.tags.ensure('First');
    const second = await harness.tags.ensure('Second');
    const results = await Promise.allSettled([
      harness.tags.rename(first.id, 'Shared'),
      harness.tags.rename(second.id, 'SHARED'),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(
      (await harness.tags.list()).filter((tag) => tag.normalizedName === 'shared'),
    ).toHaveLength(1);
  });

  it('de-duplicates by case-folded name', async () => {
    const first = await harness.tags.ensure('Sci-Fi');
    const again = await harness.tags.ensure('  sci-fi ');
    expect(again.id).toBe(first.id);
    expect(await harness.tags.list()).toHaveLength(1);
  });

  it('tags and untags a book and records book_tag changes', async () => {
    const bookId = await importBook('Tagged');
    const tag = await harness.tags.ensure('history');
    await harness.tags.tagBook(tag.id, bookId);
    expect(await harness.tags.listTagIdsForBook(bookId)).toEqual([tag.id]);
    expect(await harness.tags.listBookIds(tag.id)).toEqual([bookId]);

    await harness.tags.untagBook(tag.id, bookId);
    expect(await harness.tags.listTagIdsForBook(bookId)).toEqual([]);
    const tagChanges = (await harness.changes.listPending()).filter((c) => c.entity === 'book_tag');
    expect(tagChanges).toHaveLength(2);
  });

  it('drops a deleted tag from a book reverse lookup', async () => {
    const bookId = await importBook('OnDeletedTag');
    const tag = await harness.tags.ensure('doomed');
    await harness.tags.tagBook(tag.id, bookId);
    expect(await harness.tags.listTagIdsForBook(bookId)).toEqual([tag.id]);

    await harness.tags.remove(tag.id);
    expect(await harness.tags.listTagIdsForBook(bookId)).toEqual([]);
  });
});

describe('annotations', () => {
  it('creates, lists, updates and tombstones annotations with outbox rows', async () => {
    const bookId = await importBook('Annotated');
    const before = await harness.changes.pendingCount();
    const bookmark = await harness.annotations.create(BOOKMARK(bookId));
    expect(bookmark.kind).toBe('bookmark');
    expect((await harness.annotations.listByBook(bookId)).map((a) => a.id)).toEqual([bookmark.id]);

    const noted = await harness.annotations.update(bookmark.id, { note: 'come back here' });
    expect(noted.note).toBe('come back here');

    await harness.annotations.remove(bookmark.id);
    expect(await harness.annotations.listByBook(bookId)).toHaveLength(0);
    expect(await harness.annotations.getById(bookmark.id)).toBeUndefined();

    const annChanges = (await harness.changes.listPending()).filter(
      (c) => c.entity === 'annotation',
    );
    // create (upsert) + update (upsert) + remove (delete), order-independent.
    expect(annChanges).toHaveLength(3);
    expect(annChanges.filter((c) => c.op === 'upsert')).toHaveLength(2);
    expect(annChanges.filter((c) => c.op === 'delete')).toHaveLength(1);
    expect(await harness.changes.pendingCount()).toBe(before + 3);
  });

  it('rejects an annotation with an invalid locator', async () => {
    const bookId = await importBook('BadLoc');
    await expect(
      harness.annotations.create({
        bookId,
        kind: 'highlight',
        locator: { kind: 'cfi', value: '', fraction: 0.5 },
      }),
    ).rejects.toThrow(/invalid/i);
  });
});

describe('reading sessions', () => {
  it('records append-only sessions, caps duration, and derives stats', async () => {
    const bookId = await importBook('Timed');
    await harness.sessions.record({ bookId, startedAt: 1000, durationS: 600 });
    await harness.sessions.record({ bookId, startedAt: 2000, durationS: 10 ** 9 });

    const sessions = await harness.sessions.listByBook(bookId);
    expect(sessions).toHaveLength(2);
    expect(sessions[1]!.durationS).toBe(24 * 60 * 60); // clamped

    const stats = await harness.sessions.stats();
    expect(stats.sessionCount).toBe(2);
    expect(stats.booksRead).toBe(1);
    expect(stats.totalSeconds).toBe(600 + 24 * 60 * 60);

    const sessionChanges = (await harness.changes.listPending()).filter(
      (c) => c.entity === 'session',
    );
    expect(sessionChanges).toHaveLength(2);
  });
});

describe('export includes Phase 2 entities', () => {
  it('serializes shelves, tags, annotations and sessions', async () => {
    const bookId = await importBook('Exported');
    const shelf = await harness.shelves.create('Keep');
    await harness.shelves.addBook(shelf.id, bookId);
    const tag = await harness.tags.ensure('fiction');
    await harness.tags.tagBook(tag.id, bookId);
    await harness.annotations.create(BOOKMARK(bookId));
    await harness.sessions.record({ bookId, startedAt: 1, durationS: 30 });

    const json = await new ExportService(harness.db).buildMetadataExport(1_700_000_000_000);
    const parsed = JSON.parse(json) as Record<string, unknown[]> & { format: string };
    expect(parsed.format).toBe(EXPORT_FORMAT);
    expect(parsed.shelves).toHaveLength(1);
    expect(parsed.shelfBooks).toHaveLength(1);
    expect(parsed.tags).toHaveLength(1);
    expect(parsed.bookTags).toHaveLength(1);
    expect(parsed.annotations).toHaveLength(1);
    expect(parsed.sessions).toHaveLength(1);
  });
});
