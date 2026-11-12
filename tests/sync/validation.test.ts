import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ReplicatedEntity } from '~/data/db';
import { applyPullPage } from '~/sync/apply';
import type { PullChange } from '~/sync/protocol';
import { captureSnapshot, ExportService } from '~/services/export-service';
import { parseMetadataExport, SNAPSHOT_TABLES } from '~/services/backup-validation';
import { createHarness, type TestHarness } from '../support/harness';
import { buildEpubFixture, toBlob } from '../support/fixtures';

let h: TestHarness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.close();
});
const stamp = '1700000000000:0:remote';
const book = {
  id: 'book',
  sha256: 'a'.repeat(64),
  title: 'Valid book',
  format: 'epub',
  sizeBytes: 10,
  addedAt: 1,
  lifecycle: 'active',
  metadataIncomplete: false,
  updatedHlc: stamp,
};
const session = {
  id: 'session',
  bookId: 'book',
  startedAt: 1,
  durationS: 30,
  deviceId: 'remote',
};
const annotation = {
  id: 'annotation',
  bookId: 'book',
  kind: 'note',
  locatorKind: 'cfi',
  locatorValue: 'epubcfi(/6/2!/4/2)',
  fraction: 0.4,
  note: 'Readable note',
  createdHlc: stamp,
  updatedHlc: stamp,
  deleted: false,
};
const cases: [string, ReplicatedEntity, Record<string, unknown>][] = [
  ['oversized title', 'book', { ...book, title: 'x'.repeat(513) }],
  ['unsafe cover key', 'book', { ...book, coverKey: '../private' }],
  ['unsafe book identity', 'book', { ...book, id: 'book:other' }],
  ['lifecycle without matching timestamp', 'book', { ...book, lifecycle: 'deleted' }],
  ['impossible added date', 'book', { ...book, addedAt: Number.MAX_SAFE_INTEGER }],
  [
    'field provenance ahead of row update',
    'book',
    { ...book, metadataHlcs: { title: '1700000000001:0:remote' } },
  ],
  ['NUL in annotation text', 'annotation', { ...annotation, note: 'unsafe\u0000note' }],
  ['malformed CFI', 'annotation', { ...annotation, locatorValue: 'not-a-cfi' }],
  [
    'malformed PDF anchor',
    'annotation',
    { ...annotation, locatorKind: 'pdf', locatorValue: '2:0:5:2' },
  ],
  ['session beyond maximum duration', 'session', { ...session, durationS: 86401 }],
  ['impossible session date', 'session', { ...session, startedAt: Number.MAX_SAFE_INTEGER }],
  ['fractional session duration', 'session', { ...session, durationS: 1.5 }],
  [
    'tag normalization mismatch',
    'tag',
    { id: 'tag', name: 'Fiction', normalizedName: 'wrong', updatedHlc: stamp, deleted: false },
  ],
];
function change(entity: ReplicatedEntity, payload: Record<string, unknown>, seq = 2): PullChange {
  return {
    entity,
    entity_id: String(payload.id ?? payload.bookId),
    payload,
    seq,
    change_id: `change-${seq}`,
    hlc: stamp,
  };
}
async function apply(changes: PullChange[], cursor = 2) {
  await applyPullPage(h.db, h.syncMeta, h.clock, changes, cursor);
}

describe('replicated rows remain recoverable', () => {
  it.each([
    ['I', 'ı', 'i'],
    ['İ', 'i', 'i\u0307'],
    ['Ì', 'i\u0307\u0300', 'ì'],
    ['I\u0301', 'i\u0307\u0301', 'i\u0301'],
  ])(
    'accepts a legacy locale key for %s and canonicalizes sync and backup recovery',
    async (name, legacyKey, canonicalKey) => {
      const payload = {
        id: 'legacy-tag',
        name,
        normalizedName: legacyKey,
        updatedHlc: stamp,
        deleted: false,
      };
      await apply([change('tag', payload)]);
      expect(await h.db.tags.get(payload.id)).toEqual({ ...payload, normalizedName: canonicalKey });
      expect((await h.tags.ensure(name)).id).toBe(payload.id);
      expect(await h.db.changes.count()).toBe(0);
      const backup = JSON.parse(await new ExportService(h.db).buildMetadataExport());
      // Simulate an export written before v4; shared recovery accepts its key.
      backup.tags[0].normalizedName = legacyKey;
      expect(parseMetadataExport(JSON.stringify(backup)).tags[0]).toEqual({
        ...payload,
        normalizedName: canonicalKey,
      });
    },
  );

  it('round-trips maximum-length tag names whose deterministic lowercasing expands', async () => {
    const name = 'İ'.repeat(200);
    const tag = await h.tags.ensure(name);
    expect(tag.normalizedName).toBe('i\u0307'.repeat(200));
    const exported = parseMetadataExport(await new ExportService(h.db).buildMetadataExport());
    expect(exported.tags).toEqual([tag]);
  });

  it.each([
    ['same UUID, changed size', 'book', { sizeBytes: 11 }],
    ['same UUID, changed format', 'book', { format: 'pdf' }],
    ['duplicate UUID, changed size', 'other', { sizeBytes: 11 }],
    ['duplicate UUID, changed format', 'other', { format: 'pdf' }],
  ])('preserves known content identity for %s', async (_label, id, patch) => {
    await apply([change('book', book, 1)], 1);
    const before = await captureSnapshot(h.db);
    await expect(apply([change('book', { ...book, ...patch, id })])).rejects.toMatchObject({
      options: { code: 'identity_conflict', retryable: false },
    });
    expect(await captureSnapshot(h.db)).toEqual(before);
    expect(await h.syncMeta.getPullCursor()).toBe(1);
    expect(await h.db.syncMeta.get('book_alias:other')).toBeUndefined();
  });

  it.each(['metadata', 'annotation', 'locator', 'shelf', 'tag'])(
    'rolls back invalid local %s input before it can poison sync or recovery',
    async (kind) => {
      const outcome = await h.imports.importFile({
        blob: toBlob(buildEpubFixture()),
        filename: 'local.epub',
      });
      if (outcome.status !== 'imported') throw new Error('Fixture import failed');
      const bookId = outcome.book.id;
      const before = await captureSnapshot(h.db);
      const pending = await h.changes.pendingCount();
      const mutations: Record<string, () => Promise<unknown>> = {
        metadata: () => h.books.updateMetadata(bookId, { title: 'Invalid\u0000title' }),
        annotation: () =>
          h.annotations.create({
            bookId,
            kind: 'note',
            locator: { kind: 'cfi', value: 'epubcfi(/6/2!/4/2)', fraction: 0.4 },
            note: 'Invalid\u0000note',
          }),
        locator: () =>
          h.progress.save({
            bookId,
            locator: { kind: 'cfi', value: 'not-a-cfi', fraction: 0.4 },
          }),
        shelf: () => h.shelves.create('Invalid\u0000shelf'),
        tag: () => h.tags.ensure('Invalid\u0000tag'),
      };
      await expect(mutations[kind]!()).rejects.toThrow(/Invalid library record/);
      expect(await captureSnapshot(h.db)).toEqual(before);
      expect(await h.changes.pendingCount()).toBe(pending);
      expect(
        parseMetadataExport(await new ExportService(h.db).buildMetadataExport()).books,
      ).toHaveLength(1);
    },
  );

  it.each(cases)(
    'refuses %s without writing a partial page or advancing its cursor',
    async (_label, entity, payload) => {
      await expect(
        apply([
          change('book', { ...book, id: 'good', sha256: 'b'.repeat(64) }, 1),
          change(entity, payload),
        ]),
      ).rejects.toMatchObject({ options: { code: 'invalid_payload', retryable: false } });
      expect(await h.syncMeta.getPullCursor()).toBe(0);
      for (const table of SNAPSHOT_TABLES) expect(await h.db[table].count()).toBe(0);
      expect(await h.db.changes.count()).toBe(0);
    },
  );

  it('refuses event clock poisoning before observing it', async () => {
    const before = h.clock.last();
    await expect(
      apply([{ ...change('book', book), hlc: `${Date.now() + 2 * 86400000}:0:remote` }]),
    ).rejects.toMatchObject({ options: { code: 'invalid_payload' } });
    expect(h.clock.last()).toEqual(before);
    expect(await h.syncMeta.getPullCursor()).toBe(0);
  });

  it('refuses membership provenance that exceeds its event clock', async () => {
    const membership = {
      shelfId: 'shelf',
      bookId: 'book',
      addedHlc: stamp,
      removedHlc: '1700000000001:0:remote',
    };
    await expect(
      apply([{ ...change('shelf_book', membership), entity_id: 'shelf:book' }]),
    ).rejects.toMatchObject({ options: { code: 'invalid_payload' } });
    expect(await h.db.shelfBooks.count()).toBe(0);
  });

  it('projects unknown fields while accepting legacy rows without optional field clocks', async () => {
    await apply([change('book', { ...book, extraFutureField: { arbitrary: true } })]);
    expect(await h.db.books.get('book')).not.toHaveProperty('extraFutureField');
    expect(
      parseMetadataExport(await new ExportService(h.db).buildMetadataExport()).books,
    ).toHaveLength(1);
  });

  it('accepts all current repository rows with children arriving before parents and exports the completed graph', async () => {
    const source = await createHarness();
    try {
      const outcome = await source.imports.importFile({
        blob: toBlob(buildEpubFixture()),
        filename: 'source.epub',
      });
      if (outcome.status !== 'imported') throw new Error('Fixture import failed');
      const bookId = outcome.book.id;
      const shelf = await source.shelves.create('Shelf');
      await source.shelves.addBook(shelf.id, bookId);
      const tag = await source.tags.ensure('Fiction');
      await source.tags.tagBook(tag.id, bookId);
      await source.annotations.create({
        bookId,
        kind: 'note',
        locator: { kind: 'cfi', value: 'epubcfi(/6/2!/4/2)', fraction: 0.4 },
        note: 'Keep this note',
      });
      await source.sessions.record({ bookId, startedAt: 1, durationS: 30 });
      const pending = await source.changes.listPending();
      const ordered = [
        ...pending.filter((row) => row.entity !== 'book'),
        ...pending.filter((row) => row.entity === 'book'),
      ];
      const changes = ordered.map((row, index): PullChange => ({
        entity: row.entity,
        entity_id: row.entityId,
        payload: JSON.parse(row.payload) as unknown,
        hlc: row.hlc,
        seq: index + 1,
        change_id: row.id,
      }));
      await apply(changes.slice(0, -1), changes.length - 1);
      expect(await h.db.books.count()).toBe(0);
      expect(await h.db.annotations.count()).toBe(1);
      await apply(changes.slice(-1), changes.length);
      const snapshot = parseMetadataExport(await new ExportService(h.db).buildMetadataExport());
      for (const table of SNAPSHOT_TABLES) expect(snapshot[table]).toHaveLength(1);
      expect(await h.db.changes.count()).toBe(0);
    } finally {
      await source.close();
    }
  });
});
