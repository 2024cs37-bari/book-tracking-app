import { afterEach, beforeEach, expect, it } from 'vitest';
import { createHarness, type TestHarness } from '../support/harness';
import { buildEpubFixture, toBlob } from '../support/fixtures';
import { applyPullPage } from '~/sync/apply';
import { ExportService } from '~/services/export-service';

let h: TestHarness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.close();
});

it('an already open book can save notes, activity and memberships after its identity is reconciled', async () => {
  const imported = await h.imports.importFile({
    blob: toBlob(buildEpubFixture()),
    filename: 'identity.epub',
  });
  if (imported.status !== 'imported') throw new Error('Fixture import failed');
  const oldId = imported.book.id;
  const canonical = '00000000-0000-0000-0000-000000000000';
  const row = (await h.db.books.get(oldId))!;
  const incoming = { ...row, id: canonical, updatedHlc: `${Date.now()}:0:other` };
  const originalOutbox = await h.changes.listPending();
  await applyPullPage(
    h.db,
    h.syncMeta,
    h.clock,
    [
      {
        seq: 1,
        change_id: 'remote-book',
        entity: 'book',
        entity_id: canonical,
        hlc: incoming.updatedHlc,
        payload: incoming,
      },
    ],
    1,
  );

  // These are the IDs captured by the still-open reader/details view before sync.
  const note = await h.annotations.create({
    bookId: oldId,
    kind: 'note',
    note: 'Keep this note',
    locator: { kind: 'cfi', value: 'epubcfi(/6/2!/4/2)', fraction: 0.2 },
  });
  const session = await h.sessions.record({
    bookId: oldId,
    startedAt: Date.now(),
    durationS: 60,
    endFraction: 0.2,
  });
  const shelf = await h.shelves.create('Reading');
  const tag = await h.tags.ensure('Reference');
  await h.shelves.addBook(shelf.id, oldId);
  await h.tags.tagBook(tag.id, oldId);
  expect(note.bookId).toBe(canonical);
  expect(session.bookId).toBe(canonical);
  expect((await h.annotations.listByBook(oldId)).map((row) => row.id)).toEqual([note.id]);
  expect((await h.sessions.listByBook(oldId)).map((row) => row.id)).toEqual([session.id]);
  expect(await h.shelves.listShelfIdsForBook(oldId)).toEqual([shelf.id]);
  expect(await h.tags.listTagIdsForBook(oldId)).toEqual([tag.id]);

  const exported = JSON.parse(await new ExportService(h.db, h.files).buildMetadataExport());
  for (const table of ['annotations', 'sessions', 'shelfBooks', 'bookTags']) {
    expect(exported[table]).toHaveLength(1);
    expect(exported[table][0].bookId).toBe(canonical);
  }
  const after = await h.changes.listPending();
  for (const original of originalOutbox)
    expect(after.find((row) => row.id === original.id)).toEqual(original);
  await h.shelves.removeBook(shelf.id, oldId);
  await h.tags.untagBook(tag.id, oldId);
  expect(await h.shelves.listShelfIdsForBook(oldId)).toEqual([]);
  expect(await h.tags.listTagIdsForBook(oldId)).toEqual([]);
  expect(await h.db.shelfBooks.count()).toBe(1);
  expect(await h.db.bookTags.count()).toBe(1);
});
