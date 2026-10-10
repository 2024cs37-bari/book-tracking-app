import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type TestHarness } from '../support/harness';
import { buildEpubFixture, toBlob } from '../support/fixtures';
import { EXPORT_FORMAT, ExportService } from '~/services/export-service';
import { RestoreService } from '~/services/restore-service';
import { DB_SCHEMA_VERSION, type LibraryDatabase } from '~/data/db';

let source: TestHarness;
let target: TestHarness;

beforeEach(async () => {
  source = await createHarness();
  target = await createHarness();
});

afterEach(async () => {
  await source.close();
  await target.close();
});

/** Replicated tables an export carries, in a fixed order for comparison. */
const TABLES = [
  'books',
  'progress',
  'annotations',
  'shelves',
  'shelfBooks',
  'tags',
  'bookTags',
  'sessions',
] as const;

async function rows(db: LibraryDatabase, table: (typeof TABLES)[number]): Promise<unknown[]> {
  const all = (await db[table].toArray()) as unknown[];
  // Sort by a stable serialization so source and target align regardless of
  // insertion order; `toEqual` below ignores key order and undefined fields.
  return [...all].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

async function seedLibrary(h: TestHarness): Promise<string> {
  const outcome = await h.imports.importFile({
    blob: toBlob(buildEpubFixture({ title: 'Restored' })),
    filename: 'Restored.epub',
  });
  if (outcome.status !== 'imported') throw new Error(`import failed: ${outcome.status}`);
  const bookId = outcome.book.id;

  const shelf = await h.shelves.create('Keep');
  await h.shelves.addBook(shelf.id, bookId);
  const tag = await h.tags.ensure('fiction');
  await h.tags.tagBook(tag.id, bookId);
  await h.annotations.create({
    bookId,
    kind: 'bookmark',
    locator: { kind: 'cfi', value: 'epubcfi(/6/4!/2)', fraction: 0.4 },
  });
  await h.sessions.record({ bookId, startedAt: 1000, durationS: 120 });
  return bookId;
}

describe('RestoreService', () => {
  it('restores an export into an empty library as a faithful snapshot', async () => {
    await seedLibrary(source);
    const json = await new ExportService(source.db).buildMetadataExport(1_700_000_000_000);

    const summary = await new RestoreService(target.db).restore(json);

    for (const table of TABLES) {
      const expected = await rows(source.db, table);
      expect(await rows(target.db, table), `table ${table}`).toEqual(expected);
      expect(expected.length, `seed should populate ${table}`).toBeGreaterThan(0);
    }

    expect(summary.books).toBe((await source.db.books.toArray()).length);
    expect(summary.shelves).toBe((await source.db.shelves.toArray()).length);
    expect(summary.tags).toBe((await source.db.tags.toArray()).length);
    expect(summary.annotations).toBe((await source.db.annotations.toArray()).length);
    expect(summary.sessions).toBe((await source.db.sessions.toArray()).length);
  });

  it('writes no outbox rows — a restore is a snapshot, not a replicated mutation', async () => {
    await seedLibrary(source);
    // The source accumulated outbox rows from its repository writes...
    expect(await source.changes.pendingCount()).toBeGreaterThan(0);
    const json = await new ExportService(source.db).buildMetadataExport(1_700_000_000_000);

    await new RestoreService(target.db).restore(json);

    // ...but the restored library must not, so a later sync does not re-push
    // rows that were only ever read back from a backup file.
    expect(await target.changes.pendingCount()).toBe(0);
    expect(await target.db.changes.toArray()).toHaveLength(0);
  });

  it('is idempotent: restoring the same backup twice changes nothing', async () => {
    await seedLibrary(source);
    const json = await new ExportService(source.db).buildMetadataExport(1_700_000_000_000);
    const service = new RestoreService(target.db);

    await service.restore(json);
    const afterFirst = await Promise.all(TABLES.map((t) => rows(target.db, t)));
    await service.restore(json);
    const afterSecond = await Promise.all(TABLES.map((t) => rows(target.db, t)));

    expect(afterSecond).toEqual(afterFirst);
  });

  it('rejects a file that is not valid JSON', async () => {
    await expect(new RestoreService(target.db).restore('not json')).rejects.toThrow(
      /not valid JSON/i,
    );
  });

  it('rejects a file that is not a book-reader export', async () => {
    const json = JSON.stringify({ format: 'something-else', schemaVersion: DB_SCHEMA_VERSION });
    await expect(new RestoreService(target.db).restore(json)).rejects.toThrow(
      /not a book-reader export/i,
    );
  });

  it('refuses an export from a newer schema version instead of loading it partially', async () => {
    const json = JSON.stringify({ format: EXPORT_FORMAT, schemaVersion: DB_SCHEMA_VERSION + 1 });
    await expect(new RestoreService(target.db).restore(json)).rejects.toThrow(/newer app version/i);
  });

  it('accepts a well-formed export that carries no rows', async () => {
    const json = JSON.stringify({ format: EXPORT_FORMAT, schemaVersion: DB_SCHEMA_VERSION });
    const summary = await new RestoreService(target.db).restore(json);
    expect(summary).toEqual({
      books: 0,
      progress: 0,
      annotations: 0,
      shelves: 0,
      tags: 0,
      sessions: 0,
    });
  });
});
