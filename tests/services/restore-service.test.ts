import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zipSync } from 'fflate';
import { createHarness, type TestHarness } from '../support/harness';
import { buildEpubFixture, toBlob } from '../support/fixtures';
import { EXPORT_FORMAT, ExportService, captureSnapshot } from '~/services/export-service';
import { RestoreService } from '~/services/restore-service';
import { BACKUP_LIMITS, SNAPSHOT_TABLES } from '~/services/backup-validation';
import { readBackupArchive } from '~/services/backup-archive';
import { DB_SCHEMA_VERSION } from '~/data/db';
import { bookFileKey } from '~/storage/file-store';
import { sha256Blob } from '~/storage/sha256';
import { parseHlc, compareHlc } from '~/domain/hlc';
import { bookFileLeases } from '~/storage/book-file-leases';
import { SYNC_META_KEYS } from '~/data/repositories/sync-meta-repository';

let source: TestHarness;
let target: TestHarness;
beforeEach(async () => {
  source = await createHarness();
  target = await createHarness();
  target.advanceTime(1000);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await source.close();
  await target.close();
});

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
function service(): RestoreService {
  return new RestoreService(target.db, { files: target.files, clock: target.clock });
}
async function exported(): Promise<string> {
  await seedLibrary(source);
  return new ExportService(source.db).buildMetadataExport();
}
async function portable(): Promise<Blob> {
  await seedLibrary(source);
  return new ExportService(source.db, source.files).buildPortableBackup();
}
function businessFields(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (key, item: unknown) =>
      ['updatedHlc', 'addedHlc', 'removedHlc', 'metadataHlcs'].includes(key) ? undefined : item,
    ),
  );
}
function emptyExport(): Record<string, unknown> {
  return {
    format: EXPORT_FORMAT,
    schemaVersion: DB_SCHEMA_VERSION,
    ...Object.fromEntries(SNAPSHOT_TABLES.map((table) => [table, []])),
  };
}

describe('validated metadata recovery', () => {
  it('prepares without mutations and applies missing business data with atomic outbox events', async () => {
    const json = await exported();
    const restore = service();
    const preview = await restore.prepare(json);
    expect(preview).toMatchObject({
      kind: 'metadata',
      booksToAdd: 1,
      recordsToAdd: 8,
      missingOriginalFiles: 1,
    });
    expect(await target.db.books.count()).toBe(0);
    expect(await target.db.changes.count()).toBe(0);
    const result = await restore.apply(preview);
    expect(result).toMatchObject({
      books: 1,
      progress: 1,
      annotations: 1,
      shelves: 1,
      tags: 1,
      sessions: 1,
      filesRestored: 0,
    });
    for (const table of SNAPSHOT_TABLES) {
      const expected = businessFields(await source.db[table].toArray());
      const actual = businessFields(await target.db[table].toArray());
      if (table === 'progress') {
        expect(actual).toEqual(
          (expected as Record<string, unknown>[]).map((row) => ({
            ...row,
            deviceId: target.deviceId,
          })),
        );
      } else expect(actual, table).toEqual(expected);
    }
    const changes = await target.db.changes.toArray();
    expect(changes).toHaveLength(8);
    expect(changes.every((row) => row.pushedAt === 0 && row.deviceId === target.deviceId)).toBe(
      true,
    );
    expect(await target.db.deviceState.toArray()).toEqual([
      {
        bookId: (await source.db.books.toArray())[0]!.id,
        filePresent: false,
        pinnedOffline: false,
      },
    ]);
    expect(await target.db.syncMeta.get(SYNC_META_KEYS.clockState)).toBeDefined();
    await expect(restore.apply(preview)).rejects.toThrow(/no longer valid/);
  });

  it('preserves newer local edits and is idempotent including the outbox', async () => {
    const json = await exported();
    const restore = service();
    await restore.restore(json);
    const book = (await target.db.books.toArray())[0]!;
    await target.books.updateMetadata(book.id, { title: 'My newer title' });
    const before = await captureSnapshot(target.db);
    const pending = await target.db.changes.count();
    const preview = await restore.prepare(json);
    expect(preview).toMatchObject({ booksToAdd: 0, recordsToAdd: 0, recordsPreserved: 8 });
    const result = await restore.apply(preview);
    expect(result.books).toBe(0);
    expect(await captureSnapshot(target.db)).toEqual(before);
    expect(await target.db.changes.count()).toBe(pending);
  });

  it('reuses same-content local books and remaps restored relationships', async () => {
    const json = await exported();
    const duplicate = await target.imports.importFile({
      blob: toBlob(buildEpubFixture({ title: 'Restored' })),
      filename: 'copy.epub',
    });
    if (duplicate.status !== 'imported') throw new Error('fixture failed');
    await target.books.updateMetadata(duplicate.book.id, { title: 'Existing title' });
    await service().restore(json);
    expect(await target.db.books.count()).toBe(1);
    expect((await target.db.books.toArray())[0]!.title).toBe('Existing title');
    for (const table of ['annotations', 'shelfBooks', 'bookTags', 'sessions'] as const)
      expect(
        (await target.db[table].toArray()).every((row) => row.bookId === duplicate.book.id),
      ).toBe(true);
  });

  it('reuses existing normalized tags and retains a single membership', async () => {
    const json = await exported();
    const existing = await target.tags.ensure('Fiction');
    await service().restore(json);
    expect(await target.db.tags.count()).toBe(1);
    expect((await target.db.bookTags.toArray())[0]!.tagId).toBe(existing.id);
    expect((await target.db.tags.get(existing.id))!.name).toBe('Fiction');
  });

  it('refuses stale previews before storing any backup files', async () => {
    const archive = await portable();
    const restore = service();
    const preview = await restore.prepare(archive);
    await target.shelves.create('Created while preview was open');
    await expect(restore.apply(preview)).rejects.toThrow(/library changed/i);
    expect(await target.files.keys()).toEqual([]);
    expect(await target.db.books.count()).toBe(0);
  });

  it('rejects a caller-created or modified preview token', async () => {
    const restore = service();
    const preview = await restore.prepare(await exported());
    await expect(restore.apply({ ...preview, recordsToAdd: 0 })).rejects.toThrow(
      /no longer valid/i,
    );
  });

  it('restamps recovery changes on the local clock and keeps later edits ordered', async () => {
    const json = await exported();
    const payload = JSON.parse(json) as { books: { updatedHlc: string }[] };
    payload.books[0]!.updatedHlc = `${Date.now() + 60_000}:40:remote`;
    await service().restore(JSON.stringify(payload));
    const restored = (await target.db.books.toArray())[0]!;
    expect(parseHlc(restored.updatedHlc)!.deviceId).toBe(target.deviceId);
    expect(parseHlc(restored.updatedHlc)!.wallMs).toBeLessThan(Date.now());
    await target.books.updateMetadata(restored.id, { title: 'After recovery' });
    const updated = (await target.db.books.get(restored.id))!;
    expect(
      compareHlc(parseHlc(updated.updatedHlc)!, parseHlc(restored.updatedHlc)!),
    ).toBeGreaterThan(0);
  });

  it.each([
    ['invalid JSON', 'not json', /not valid JSON/i],
    ['null document', 'null', /must be an object/],
    [
      'wrong format',
      JSON.stringify({ ...emptyExport(), format: 'different' }),
      /not a book-reader export/,
    ],
    [
      'new schema',
      JSON.stringify({ ...emptyExport(), schemaVersion: DB_SCHEMA_VERSION + 1 }),
      /newer app version/,
    ],
    ['negative schema', JSON.stringify({ ...emptyExport(), schemaVersion: -1 }), /schemaVersion/],
    [
      'fractional schema',
      JSON.stringify({ ...emptyExport(), schemaVersion: 1.5 }),
      /schemaVersion/,
    ],
    [
      'missing arrays',
      JSON.stringify({ format: EXPORT_FORMAT, schemaVersion: DB_SCHEMA_VERSION }),
      /must be an array/,
    ],
  ])('rejects %s before any mutation', async (_name, json, error) => {
    await expect(service().restore(json)).rejects.toThrow(error);
    expect(await target.db.books.count()).toBe(0);
    expect(await target.db.syncMeta.count()).toBe(0);
  });

  it('supports schema 1 exports with absent schema 2 tables', async () => {
    const json = await exported();
    const payload = JSON.parse(json) as Record<string, unknown>;
    payload.schemaVersion = 1;
    for (const table of SNAPSHOT_TABLES)
      if (table !== 'books' && table !== 'progress') delete payload[table];
    expect((await service().restore(JSON.stringify(payload))).books).toBe(1);
  });

  it('accepts a structurally complete empty export', async () => {
    expect(await service().restore(JSON.stringify(emptyExport()))).toEqual({
      books: 0,
      progress: 0,
      annotations: 0,
      shelves: 0,
      tags: 0,
      sessions: 0,
      filesRestored: 0,
      preservedRows: 0,
    });
  });

  it.each([
    [
      'unsafe cover key',
      (p: Record<string, Record<string, unknown>[]>) => {
        p.books![0]!.coverKey = '../other';
      },
    ],
    [
      'bad hash',
      (p: Record<string, Record<string, unknown>[]>) => {
        p.books![0]!.sha256 = 'fake';
      },
    ],
    [
      'invalid format',
      (p: Record<string, Record<string, unknown>[]>) => {
        p.books![0]!.format = 'exe';
      },
    ],
    [
      'negative file size',
      (p: Record<string, Record<string, unknown>[]>) => {
        p.books![0]!.sizeBytes = -1;
      },
    ],
    [
      'impossible added date',
      (p: Record<string, Record<string, unknown>[]>) => {
        p.books![0]!.addedAt = Number.MAX_SAFE_INTEGER;
      },
    ],
    [
      'impossible reading session date',
      (p: Record<string, Record<string, unknown>[]>) => {
        p.sessions![0]!.startedAt = Number.MAX_SAFE_INTEGER;
      },
    ],
    [
      'invalid lifecycle',
      (p: Record<string, Record<string, unknown>[]>) => {
        p.books![0]!.lifecycle = 'deleted';
      },
    ],
    [
      'future clock',
      (p: Record<string, Record<string, unknown>[]>) => {
        p.books![0]!.updatedHlc = `${Date.now() + 172_800_000}:0:remote`;
      },
    ],
    [
      'clock counter overflow',
      (p: Record<string, Record<string, unknown>[]>) => {
        p.books![0]!.updatedHlc = '1700000000000:2147483647:remote';
      },
    ],
    [
      'orphan progress',
      (p: Record<string, Record<string, unknown>[]>) => {
        p.progress![0]!.bookId = 'missing';
      },
    ],
    [
      'orphan membership',
      (p: Record<string, Record<string, unknown>[]>) => {
        p.shelfBooks![0]!.shelfId = 'missing';
      },
    ],
    [
      'fraction outside range',
      (p: Record<string, Record<string, unknown>[]>) => {
        p.progress![0]!.fraction = 2;
      },
    ],
    [
      'duplicate identity',
      (p: Record<string, Record<string, unknown>[]>) => {
        p.annotations!.push(p.annotations![0]!);
      },
    ],
    [
      'normalized tag mismatch',
      (p: Record<string, Record<string, unknown>[]>) => {
        p.tags![0]!.normalizedName = 'not-fiction';
      },
    ],
    [
      'unknown metadata clock',
      (p: Record<string, Record<string, unknown>[]>) => {
        p.books![0]!.metadataHlcs = { __invalid: '1700000000000:0:remote' };
      },
    ],
  ])('rejects %s', async (_name, mutate) => {
    const payload = JSON.parse(await exported()) as Record<string, Record<string, unknown>[]>;
    mutate(payload);
    await expect(service().restore(JSON.stringify(payload))).rejects.toThrow(/invalid backup/i);
    expect(await target.db.books.count()).toBe(0);
    expect(await target.db.changes.count()).toBe(0);
  });

  it('retains valid PDF reading positions and highlight locators', async () => {
    const payload = JSON.parse(await exported()) as Record<string, Record<string, unknown>[]>;
    payload.progress![0]!.locatorKind = 'pdf';
    payload.progress![0]!.locatorValue = '0:20';
    payload.annotations![0]!.locatorKind = 'pdf';
    payload.annotations![0]!.locatorValue = '1:0:5:15';
    await service().restore(JSON.stringify(payload));
    expect((await target.db.progress.toArray())[0]!.locatorValue).toBe('0:20');
    expect((await target.db.annotations.toArray())[0]!.locatorValue).toBe('1:0:5:15');
  });
});

describe('portable backup integrity and recovery', () => {
  it('round-trips original bytes, verifies all manifest entries, and restores readable storage state', async () => {
    const archive = await portable();
    const restore = service();
    const preview = await restore.prepare(archive);
    expect(preview).toMatchObject({
      kind: 'portable',
      booksToAdd: 1,
      originalFiles: 1,
      missingOriginalFiles: 0,
    });
    const summary = await restore.apply(preview);
    expect(summary.filesRestored).toBe(1);
    const book = (await target.db.books.toArray())[0]!;
    expect(await sha256Blob(await target.files.get(bookFileKey(book.sha256)))).toBe(book.sha256);
    expect(await target.db.deviceState.get(book.id)).toMatchObject({
      filePresent: true,
      pinnedOffline: false,
    });
    const roundTrip = await new ExportService(target.db, target.files).buildPortableBackup();
    expect((await readBackupArchive(roundTrip)).has('metadata.json')).toBe(true);
    expect(bookFileLeases.isHeld(book.sha256)).toBe(false);
  });

  it('preserves safe cover keys from a previous canonical identity and deduplicates shared cover entries', async () => {
    await seedLibrary(source);
    const extra = await source.imports.importFile({
      blob: toBlob(buildEpubFixture({ title: 'Second original' })),
      filename: 'second.epub',
    });
    if (extra.status !== 'imported') throw new Error('Fixture import failed');
    const key = 'covers/previous-book-identity.png';
    await source.files.put(key, new Blob(['cover bytes']));
    await source.db.books.toCollection().modify({ coverKey: key });
    const archive = await new ExportService(source.db, source.files).buildPortableBackup();
    const entries = await readBackupArchive(archive);
    expect([...entries.keys()].filter((path) => path.startsWith('covers/'))).toEqual([key]);
    const restore = service();
    await restore.apply(await restore.prepare(archive));
    expect((await target.db.books.toArray()).every((book) => book.coverKey === key)).toBe(true);
  });

  it('refuses a portable export if any original is missing or corrupt', async () => {
    await seedLibrary(source);
    const book = (await source.db.books.toArray())[0]!;
    await source.files.remove(bookFileKey(book.sha256));
    await expect(new ExportService(source.db, source.files).buildPortableBackup()).rejects.toThrow(
      /no original/,
    );
    expect(await new ExportService(source.db).buildMetadataExport()).toContain(book.title);
    await source.files.put(bookFileKey(book.sha256), new Blob([new Uint8Array(book.sizeBytes)]));
    await expect(new ExportService(source.db, source.files).buildPortableBackup()).rejects.toThrow(
      /SHA-256/,
    );
    expect(bookFileLeases.isHeld(book.sha256)).toBe(false);
  });

  it('does not overwrite a damaged existing original', async () => {
    const archive = await portable();
    const book = (await source.db.books.toArray())[0]!;
    const corrupted = new Blob(['keep this evidence']);
    await target.files.put(bookFileKey(book.sha256), corrupted);
    await expect(service().prepare(archive)).rejects.toThrow(/not overwritten/);
    expect(await (await target.files.get(bookFileKey(book.sha256))).text()).toBe(
      'keep this evidence',
    );
    expect(await target.db.books.count()).toBe(0);
  });

  it('fails tampered originals even when the ZIP CRC has been recomputed', async () => {
    const archive = await portable();
    const entries = await readBackupArchive(archive);
    const path = [...entries.keys()].find((name) => name.startsWith('books/'))!;
    const bytes = entries.get(path)!.slice();
    bytes[0] = bytes[0]! ^ 0xff;
    entries.set(path, bytes);
    const tampered = new Blob([new Uint8Array(zipSync(Object.fromEntries(entries), { level: 0 }))]);
    await expect(service().prepare(tampered)).rejects.toThrow(/SHA-256/);
    expect(await target.files.keys()).toEqual([]);
  });

  it('rejects an original whose manifest and bytes no longer match the book identity', async () => {
    const archive = await portable();
    const entries = await readBackupArchive(archive);
    const metadata = JSON.parse(new TextDecoder().decode(entries.get('metadata.json')!)) as {
      books: { sizeBytes: number }[];
    };
    metadata.books[0]!.sizeBytes++;
    const bytes = new TextEncoder().encode(JSON.stringify(metadata));
    entries.set('metadata.json', bytes);
    const manifest = JSON.parse(new TextDecoder().decode(entries.get('manifest.json')!)) as {
      metadata: { sizeBytes: number; sha256: string };
    };
    manifest.metadata.sizeBytes = bytes.length;
    manifest.metadata.sha256 = await sha256Blob(new Blob([bytes]));
    entries.set('manifest.json', new TextEncoder().encode(JSON.stringify(manifest)));
    const tampered = new Blob([new Uint8Array(zipSync(Object.fromEntries(entries), { level: 0 }))]);
    await expect(service().prepare(tampered)).rejects.toThrow(/does not match book/);
  });

  it('rejects compressed ZIPs and archives with unexpected paths', async () => {
    const archive = await portable();
    const entries = Object.fromEntries(await readBackupArchive(archive));
    await expect(
      service().prepare(new Blob([new Uint8Array(zipSync(entries, { level: 6 }))])),
    ).rejects.toThrow(/unsupported archive/);
    entries['../escape'] = new Uint8Array([1]);
    await expect(
      service().prepare(new Blob([new Uint8Array(zipSync(entries, { level: 0 }))])),
    ).rejects.toThrow(/unsupported archive/);
  });

  it('rejects an oversized input before reading its contents', async () => {
    const blob = new Blob(['x']);
    Object.defineProperty(blob, 'size', { value: BACKUP_LIMITS.archiveBytes + 1 });
    const read = vi.spyOn(blob, 'arrayBuffer');
    await expect(service().prepare(blob)).rejects.toThrow(/128 MiB/);
    expect(read).not.toHaveBeenCalled();
  });

  it('rolls back all metadata and outbox when a late write fails, keeping verified staged bytes recoverable', async () => {
    const archive = await portable();
    const restore = service();
    const preview = await restore.prepare(archive);
    const stop = () => {
      throw new Error('Simulated outbox storage failure');
    };
    target.db.changes.hook('creating', stop);
    await expect(restore.apply(preview)).rejects.toThrow(/Simulated outbox/);
    target.db.changes.hook('creating').unsubscribe(stop);
    for (const table of SNAPSHOT_TABLES) expect(await target.db[table].count(), table).toBe(0);
    expect(await target.db.syncMeta.count()).toBe(0);
    expect(await target.db.deviceState.count()).toBe(0);
    const book = (await source.db.books.toArray())[0]!;
    expect(await sha256Blob(await target.files.get(bookFileKey(book.sha256)))).toBe(book.sha256);
    expect(bookFileLeases.isHeld(book.sha256)).toBe(false);
    const retry = await restore.prepare(archive);
    expect((await restore.apply(retry)).books).toBe(1);
  });

  it('does not commit metadata after a partial file write', async () => {
    const archive = await portable();
    vi.spyOn(target.files, 'put').mockImplementation(async (key) => {
      throw new Error(`Simulated quota failure for ${key}`);
    });
    const restore = service();
    await expect(restore.apply(await restore.prepare(archive))).rejects.toThrow(/quota failure/);
    expect(await target.db.books.count()).toBe(0);
    expect(await target.db.changes.count()).toBe(0);
  });

  it('does not allow cleanup to remove a staged original before its metadata commits', async () => {
    const archive = await portable();
    const originalPut = target.files.put.bind(target.files);
    let protectedDuringWrite = false;
    vi.spyOn(target.files, 'put').mockImplementation(async (key, blob) => {
      const result = await originalPut(key, blob);
      if (key.startsWith('books/'))
        protectedDuringWrite =
          (await bookFileLeases.tryExclusive(key.slice(6, -4), async () => {
            await target.files.remove(key);
            return true;
          })) === undefined;
      return result;
    });
    const restore = service();
    await restore.apply(await restore.prepare(archive));
    expect(protectedDuringWrite).toBe(true);
    const book = (await target.db.books.toArray())[0]!;
    expect(await target.files.has(bookFileKey(book.sha256))).toBe(true);
  });
});
