import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type TestHarness } from '../support/harness';
import { buildEpubFixture, toBlob } from '../support/fixtures';

let harness: TestHarness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness.close();
});

async function importFixture(bytes: Uint8Array<ArrayBuffer>, filename: string): Promise<string> {
  const outcome = await harness.imports.importFile({ blob: toBlob(bytes), filename });
  if (outcome.status !== 'imported') {
    throw new Error(`Expected an import, received "${outcome.status}".`);
  }
  return outcome.book.id;
}

describe('library persistence', () => {
  it('refuses to accept a database write without an outbox entry', async () => {
    await importFixture(buildEpubFixture(), 'outbox.epub');
    const pending = await harness.changes.listPending();
    // book + its initial progress row
    expect(pending.map((change) => change.entity).sort()).toEqual(['book', 'progress']);
    expect(pending.every((change) => change.pushedAt === 0)).toBe(true);
  });

  it('creates reading state alongside the book so no book lacks a status', async () => {
    const bookId = await importFixture(buildEpubFixture(), 'status.epub');
    const progress = await harness.progress.get(bookId);
    expect(progress).toMatchObject({ bookId, status: 'to_read', locator: null });
  });

  it('records progress as a locator plus a normalized fraction', async () => {
    const bookId = await importFixture(buildEpubFixture(), 'progress.epub');
    const saved = await harness.progress.save({
      bookId,
      locator: { kind: 'cfi', value: 'epubcfi(/6/4!/4/2)', fraction: 0.42 },
    });

    expect(saved.status).toBe('reading');
    expect(saved.locator).toEqual({ kind: 'cfi', value: 'epubcfi(/6/4!/4/2)', fraction: 0.42 });
    expect(saved.deviceId).toBe(harness.deviceId);
  });

  it('marks a book finished when the position reaches the end', async () => {
    const bookId = await importFixture(buildEpubFixture(), 'finish.epub');
    const saved = await harness.progress.save({
      bookId,
      locator: { kind: 'cfi', value: 'epubcfi(/6/4!/2)', fraction: 1 },
    });
    expect(saved.status).toBe('finished');
  });

  it('returns the stored locator unchanged on reload', async () => {
    const bookId = await importFixture(buildEpubFixture(), 'reload.epub');
    await harness.progress.save({
      bookId,
      locator: { kind: 'pdf', value: '12:340', fraction: 0.3 },
    });

    const reloaded = await harness.progress.get(bookId);
    expect(reloaded?.locator).toEqual({ kind: 'pdf', value: '12:340', fraction: 0.3 });
  });

  it('rejects a malformed locator instead of storing it', async () => {
    const bookId = await importFixture(buildEpubFixture(), 'bad-locator.epub');
    await expect(
      harness.progress.save({
        bookId,
        locator: { kind: 'cfi', value: '', fraction: 0.5 },
      }),
    ).rejects.toThrow(/invalid/i);
  });

  it('rejects progress for a book that does not exist', async () => {
    await expect(
      harness.progress.save({
        bookId: 'missing-book',
        locator: { kind: 'cfi', value: 'x', fraction: 0.1 },
      }),
    ).rejects.toThrow(/no reading state/i);
  });

  it('requires an explicit status when the user overrides the derived one', async () => {
    const bookId = await importFixture(buildEpubFixture(), 'abandon.epub');
    await harness.progress.save({
      bookId,
      locator: { kind: 'cfi', value: 'epubcfi(/6/4!/2)', fraction: 0.2 },
      status: 'abandoned',
    });
    const progress = await harness.progress.save({
      bookId,
      locator: { kind: 'cfi', value: 'epubcfi(/6/4!/4)', fraction: 0.25 },
    });
    expect(progress.status).toBe('abandoned');
  });
});

describe('book lifecycle', () => {
  it('hides archived books from the default listing but keeps them recoverable', async () => {
    const bookId = await importFixture(buildEpubFixture({ title: 'Archived' }), 'archive.epub');
    await harness.books.setLifecycle(bookId, 'archived');

    expect(await harness.books.list()).toHaveLength(0);
    expect(await harness.books.list({ lifecycle: 'archived' })).toHaveLength(1);
    expect(await harness.books.list({ lifecycle: 'all' })).toHaveLength(1);

    await harness.books.setLifecycle(bookId, 'active');
    expect(await harness.books.list()).toHaveLength(1);
  });

  it('keeps soft-deleted books out of every browseable shelf', async () => {
    const activeId = await importFixture(buildEpubFixture({ title: 'Active' }), 'active.epub');
    const deletedId = await importFixture(buildEpubFixture({ title: 'Trash' }), 'trash.epub');
    await harness.books.setLifecycle(deletedId, 'deleted');

    expect((await harness.books.list({ lifecycle: 'active' })).map((b) => b.id)).toEqual([
      activeId,
    ]);
    expect((await harness.books.list({ lifecycle: 'all' })).map((b) => b.id)).toEqual([activeId]);
    // A deleted book is still reachable when explicitly requested.
    expect((await harness.books.list({ lifecycle: 'deleted' })).map((b) => b.id)).toEqual([
      deletedId,
    ]);
  });

  it('clears lifecycle timestamps when a book returns to active', async () => {
    const bookId = await importFixture(buildEpubFixture(), 'timestamps.epub');
    const archived = await harness.books.setLifecycle(bookId, 'archived');
    expect(archived.archivedAt).toBeTypeOf('number');

    const restored = await harness.books.setLifecycle(bookId, 'active');
    expect(restored.archivedAt).toBeUndefined();
    expect(restored.deletedAt).toBeUndefined();
  });

  it('records every lifecycle change in the outbox', async () => {
    const bookId = await importFixture(buildEpubFixture(), 'audit.epub');
    const before = await harness.changes.pendingCount();
    await harness.books.setLifecycle(bookId, 'deleted');
    expect(await harness.changes.pendingCount()).toBe(before + 1);
  });

  it('reports books by lifecycle for diagnostics', async () => {
    await importFixture(buildEpubFixture({ title: 'One' }), 'one.epub');
    const secondId = await importFixture(buildEpubFixture({ title: 'Two' }), 'two.epub');
    await harness.books.setLifecycle(secondId, 'archived');

    expect(await harness.books.countByLifecycle()).toEqual({
      active: 1,
      archived: 1,
      deleted: 0,
      total: 2,
    });
  });

  it('rejects lifecycle changes for unknown books', async () => {
    await expect(harness.books.setLifecycle('nope', 'archived')).rejects.toThrow(
      /not in the library/i,
    );
  });
});

describe('book metadata editing', () => {
  it('updates editable fields and records the change in the outbox', async () => {
    const bookId = await importFixture(buildEpubFixture({ title: 'Original' }), 'edit.epub');
    const before = await harness.changes.pendingCount();

    const updated = await harness.books.updateMetadata(bookId, {
      title: 'Corrected Title',
      author: 'New Author',
      publisher: 'New House',
      pageCount: 321,
      metadataIncomplete: false,
    });

    expect(updated).toMatchObject({
      title: 'Corrected Title',
      author: 'New Author',
      publisher: 'New House',
      pageCount: 321,
      metadataIncomplete: false,
    });
    expect(await harness.changes.pendingCount()).toBe(before + 1);

    const reloaded = await harness.books.getById(bookId);
    expect(reloaded?.title).toBe('Corrected Title');
  });

  it('clears an optional field when the patch sets it to undefined', async () => {
    const bookId = await importFixture(
      buildEpubFixture({ title: 'Has Author', creator: 'Someone' }),
      'clear.epub',
    );
    expect((await harness.books.getById(bookId))?.author).toBe('Someone');

    const updated = await harness.books.updateMetadata(bookId, { author: undefined });
    expect(updated.author).toBeUndefined();
    expect((await harness.books.getById(bookId))?.author).toBeUndefined();
  });

  it('refuses to blank out the title', async () => {
    const bookId = await importFixture(buildEpubFixture(), 'blank-title.epub');
    await expect(harness.books.updateMetadata(bookId, { title: '   ' })).rejects.toThrow(
      /title must not be empty/i,
    );
  });

  it('rejects a page count that is not a non-negative whole number', async () => {
    const bookId = await importFixture(buildEpubFixture(), 'bad-pages.epub');
    await expect(harness.books.updateMetadata(bookId, { pageCount: -5 })).rejects.toThrow(
      /whole number/i,
    );
    await expect(harness.books.updateMetadata(bookId, { pageCount: 1.5 })).rejects.toThrow(
      /whole number/i,
    );
  });

  it('rejects metadata edits for unknown books', async () => {
    await expect(harness.books.updateMetadata('nope', { title: 'x' })).rejects.toThrow(
      /not in the library/i,
    );
  });
});

describe('library queries', () => {
  beforeEach(async () => {
    await importFixture(
      buildEpubFixture({ title: 'Zebra Nights', creator: 'Alice Author' }),
      'zebra.epub',
    );
    harness.advanceTime(1000);
    await importFixture(
      buildEpubFixture({ title: 'apple days', creator: 'Bob Writer' }),
      'apple.epub',
    );
    harness.advanceTime(1000);
    await importFixture(
      buildEpubFixture({ title: 'Middle Ground', creator: 'Carol Poet' }),
      'middle.epub',
    );
  });

  it('sorts by title case-insensitively', async () => {
    const titles = (await harness.books.list({ sort: 'title' })).map((book) => book.title);
    expect(titles).toEqual(['apple days', 'Middle Ground', 'Zebra Nights']);
  });

  it('sorts by author with unknown authors last', async () => {
    const authors = (await harness.books.list({ sort: 'author' })).map((book) => book.author);
    expect(authors).toEqual(['Alice Author', 'Bob Writer', 'Carol Poet']);
  });

  it('sorts by import order', async () => {
    const newestFirst = (await harness.books.list({ sort: 'added_desc' })).map((b) => b.title);
    expect(newestFirst[0]).toBe('Middle Ground');
    const oldestFirst = (await harness.books.list({ sort: 'added_asc' })).map((b) => b.title);
    expect(oldestFirst[0]).toBe('Zebra Nights');
  });

  it('searches title, author, publisher and ISBN', async () => {
    expect((await harness.books.list({ search: 'zebra' })).map((b) => b.title)).toEqual([
      'Zebra Nights',
    ]);
    expect((await harness.books.list({ search: 'bob writer' })).map((b) => b.title)).toEqual([
      'apple days',
    ]);
    expect(await harness.books.list({ search: 'Test House' })).toHaveLength(3);
    expect(await harness.books.list({ search: '9780306406157' })).toHaveLength(3);
  });

  it('returns nothing for a search that matches nothing', async () => {
    expect(await harness.books.list({ search: 'nonexistent-query' })).toHaveLength(0);
  });

  it('sums referenced file bytes for storage reporting', async () => {
    const total = await harness.books.referencedBytes();
    expect(total).toBeGreaterThan(0);
  });
});

describe('outbox', () => {
  it('acknowledges only the change ids the server confirmed', async () => {
    await importFixture(buildEpubFixture(), 'batch.epub');
    const pending = await harness.changes.listPending();
    expect(pending.length).toBeGreaterThan(1);

    const acknowledged = pending[0]!.id;
    const marked = await harness.changes.markPushed([acknowledged]);

    expect(marked).toBe(1);
    expect(await harness.changes.pendingCount()).toBe(pending.length - 1);
    const remaining = await harness.changes.listPending();
    expect(remaining.map((change) => change.id)).not.toContain(acknowledged);
  });

  it('leaves everything pending when nothing is acknowledged', async () => {
    await importFixture(buildEpubFixture(), 'no-ack.epub');
    const before = await harness.changes.pendingCount();
    expect(await harness.changes.markPushed([])).toBe(0);
    expect(await harness.changes.pendingCount()).toBe(before);
  });

  it('orders pending changes oldest first', async () => {
    await importFixture(buildEpubFixture({ title: 'First' }), 'first.epub');
    harness.advanceTime(5000);
    await importFixture(buildEpubFixture({ title: 'Second' }), 'second.epub');

    const oldest = await harness.changes.oldestPendingCreatedAt();
    const all = await harness.changes.listPending();
    const newest = Math.max(...all.map((change) => change.createdAt));
    expect(oldest).toBeLessThan(newest);
  });

  it('retains acknowledged changes until retention explicitly clears them', async () => {
    await importFixture(buildEpubFixture(), 'retain.epub');
    const pending = await harness.changes.listPending();
    const acknowledgedAt = 1_700_000_500_000;
    await harness.changes.markPushed(
      pending.map((change) => change.id),
      acknowledgedAt,
    );

    expect(await harness.changes.pendingCount()).toBe(0);
    expect(await harness.changes.totalCount()).toBe(pending.length);

    expect(await harness.changes.clearPushedBefore(acknowledgedAt - 1)).toBe(0);
    expect(await harness.changes.clearPushedBefore(acknowledgedAt)).toBe(pending.length);
  });

  it('stamps each change with a unique id and a device id', async () => {
    await importFixture(buildEpubFixture(), 'ids.epub');
    const pending = await harness.changes.listPending();
    const ids = new Set(pending.map((change) => change.id));
    expect(ids.size).toBe(pending.length);
    expect(pending.every((change) => change.deviceId === harness.deviceId)).toBe(true);
    expect(pending.every((change) => /^\d+:\d+:.+$/.test(change.hlc))).toBe(true);
  });
});

describe('device identity and sync metadata', () => {
  it('creates a device id once and reuses it', async () => {
    const first = await harness.syncMeta.getOrCreateDeviceId();
    const second = await harness.syncMeta.getOrCreateDeviceId();
    expect(second).toBe(first);
  });

  it('starts the pull cursor at zero and persists advances', async () => {
    expect(await harness.syncMeta.getPullCursor()).toBe(0);
    await harness.syncMeta.setPullCursor(42);
    expect(await harness.syncMeta.getPullCursor()).toBe(42);
  });

  it('rejects a cursor that is not a non-negative integer', async () => {
    await expect(harness.syncMeta.setPullCursor(-1)).rejects.toThrow(/non-negative/i);
    await expect(harness.syncMeta.setPullCursor(1.5)).rejects.toThrow(/non-negative/i);
  });

  it('restores persisted clock state', async () => {
    await harness.syncMeta.setClockState({ wallMs: 999, counter: 3, deviceId: harness.deviceId });
    expect(await harness.syncMeta.getClockState()).toMatchObject({ wallMs: 999, counter: 3 });
  });

  it('keeps device state out of the replicated outbox', async () => {
    const bookId = await importFixture(buildEpubFixture(), 'pin.epub');
    const before = await harness.changes.pendingCount();

    await harness.deviceState.setPinned(bookId, true);
    await harness.deviceState.markOpened(bookId);
    await harness.deviceState.setFilePresent(bookId, true);

    expect(await harness.changes.pendingCount()).toBe(before);
    expect(await harness.deviceState.listPinned()).toHaveLength(1);
    expect((await harness.deviceState.get(bookId))?.filePresent).toBe(true);
  });
});
