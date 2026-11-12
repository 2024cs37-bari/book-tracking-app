import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type TestHarness } from '../support/harness';
import { applyPullPage, mergeBook } from '~/sync/apply';
import { recoverClock } from '~/sync/clock-recovery';
import { createClock, compareHlc, parseHlc } from '~/domain/hlc';
import type { BookRow } from '~/data/db';
import type { PullChange } from '~/sync/protocol';
import { SyncEngine } from '~/sync/engine';
import type { SyncTransport } from '~/sync/transport';
import { buildEpubFixture, toBlob } from '../support/fixtures';

let h: TestHarness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.close();
});
const book = (id: string, wall: number, extra: Partial<BookRow> = {}): BookRow => ({
  id,
  sha256: 'a'.repeat(64),
  title: 'Book',
  format: 'epub',
  sizeBytes: 10,
  addedAt: 1,
  lifecycle: 'active',
  metadataIncomplete: false,
  updatedHlc: `${wall}:0:device`,
  ...extra,
});
const change = (row: BookRow, seq = 1): PullChange => ({
  entity: 'book',
  entity_id: row.id,
  change_id: `c${seq}`,
  seq,
  payload: row,
  hlc: row.updatedHlc,
});
const apply = (rows: PullChange[], cursor = 1) =>
  applyPullPage(h.db, h.syncMeta, h.clock, rows, cursor);

describe('sync data integrity', () => {
  it('merges three out-of-order snapshots associatively using field provenance', () => {
    const a = book('b', 10, { author: 'Early' });
    const b = book('b', 30);
    const c = book('b', 20, { author: 'Middle' });
    const left = mergeBook(mergeBook(a, b), c);
    const right = mergeBook(a, mergeBook(b, c));
    expect(left).toEqual(right);
    expect(left.author).toBe('Middle');
  });
  it('preserves explicit metadata clears across stale snapshots', () => {
    const old = book('b', 10, { author: 'Old' });
    const cleared = book('b', 20, { metadataHlcs: { author: '20:0:device' } });
    expect(mergeBook(old, cleared).author).toBeUndefined();
    expect(mergeBook(cleared, old).author).toBeUndefined();
  });
  it('keeps independent edits to different fields from actual repository snapshots', async () => {
    const initial = book('b', 10, { author: 'Initial' });
    await h.db.books.put(initial);
    await h.books.updateMetadata('b', { title: 'Changed title' });
    const titleEdit = (await h.db.books.get('b'))!;
    const authorEdit = {
      ...initial,
      author: 'Changed author',
      updatedHlc: '2000000000000:0:other',
      metadataHlcs: { title: initial.updatedHlc, author: '2000000000000:0:other' },
    };
    const merged = mergeBook(titleEdit, authorEdit);
    expect(merged.title).toBe('Changed title');
    expect(merged.author).toBe('Changed author');
  });
  it('rejects malformed page atomically without advancing cursor or losing earlier rows', async () => {
    await expect(
      apply(
        [
          change(book('good', 10)),
          { ...change(book('bad', 20), 2), payload: { id: 'bad', title: 'Invalid' } },
        ],
        2,
      ),
    ).rejects.toThrow(/Invalid book/);
    expect(await h.db.books.count()).toBe(0);
    expect(await h.syncMeta.getPullCursor()).toBe(0);
  });
  it('reconciles independent same-hash IDs, all references, and pending outbox without rewriting wire IDs', async () => {
    await h.db.books.put(book('z-local', 10));
    await h.db.progress.put({
      bookId: 'z-local',
      status: 'reading',
      fraction: 0.2,
      updatedHlc: '10:0:local',
      deviceId: 'local',
    });
    await h.db.annotations.put({
      id: 'note',
      bookId: 'z-local',
      kind: 'note',
      locatorKind: 'cfi',
      locatorValue: 'x',
      fraction: 0.2,
      note: 'Keep me',
      createdHlc: '10:0:local',
      updatedHlc: '10:0:local',
      deleted: false,
    });
    await h.db.shelfBooks.put({ shelfId: 's', bookId: 'z-local', addedHlc: '10:0:local' });
    await h.db.bookTags.put({ tagId: 't', bookId: 'z-local', addedHlc: '10:0:local' });
    await h.db.sessions.put({
      id: 'session',
      bookId: 'z-local',
      startedAt: 1,
      durationS: 20,
      deviceId: 'local',
    });
    await h.db.deviceState.put({ bookId: 'z-local', filePresent: true, pinnedOffline: true });
    await h.books.updateMetadata('z-local', { author: 'Local edit' });
    const outbox = await h.db.changes.toArray();
    await apply([change(book('a-remote', 20))]);
    expect(await h.db.books.count()).toBe(1);
    expect((await h.books.getById('z-local'))?.id).toBe('a-remote');
    expect((await h.db.progress.get('a-remote'))?.fraction).toBe(0.2);
    expect((await h.db.annotations.get('note'))?.bookId).toBe('a-remote');
    expect(await h.db.shelfBooks.get(['s', 'a-remote'])).toBeDefined();
    expect(await h.db.bookTags.get(['t', 'a-remote'])).toBeDefined();
    expect((await h.db.sessions.get('session'))?.bookId).toBe('a-remote');
    expect((await h.db.deviceState.get('a-remote'))?.pinnedOffline).toBe(true);
    expect(await h.db.changes.toArray()).toEqual(outbox);
    await apply([change(book('z-local', 30, { publisher: 'Follow-up' }), 2)], 2);
    expect((await h.db.books.get('a-remote'))?.publisher).toBe('Follow-up');
  });
  it('does not replace a newer unresolved progress candidate with an older replay', async () => {
    await h.db.progress.put({
      bookId: 'b',
      status: 'reading',
      fraction: 0.1,
      updatedHlc: '10:0:local',
      deviceId: 'local',
    });
    const progress = (wall: number, fraction: number): PullChange => ({
      entity: 'progress',
      entity_id: 'b',
      change_id: `p${wall}`,
      seq: wall,
      hlc: `${wall}:0:remote`,
      payload: {
        bookId: 'b',
        status: 'reading',
        fraction,
        updatedHlc: `${wall}:0:remote`,
        deviceId: 'remote',
      },
    });
    await apply([progress(30, 0.9)]);
    await apply([progress(20, 0.5)]);
    expect((await h.db.progressConflicts.get('b'))?.remote.fraction).toBe(0.9);
  });
  it('recovers local logical time from committed changes even without a checkpoint', async () => {
    await h.books.insert({
      id: 'b',
      sha256: 'a'.repeat(64),
      title: 'T',
      format: 'epub',
      sizeBytes: 10,
      metadataIncomplete: false,
    });
    const committed = (await h.db.changes.toArray())[0]!;
    const restarted = createClock({ deviceId: h.deviceId, now: () => 0 });
    await recoverClock(h.db, restarted);
    expect(compareHlc(restarted.next(), parseHlc(committed.hlc)!)).toBeGreaterThan(0);
  });
});

function engine(transport: SyncTransport) {
  return new SyncEngine({
    db: h.db,
    changes: h.changes,
    syncMeta: h.syncMeta,
    clock: h.clock,
    deviceId: h.deviceId,
    transport,
    maxPushBatches: 1,
    pushBatchSize: 1,
    maxPages: 2,
  });
}
const emptyPull = async (since: number) => ({
  changes: [],
  next_cursor: since,
  has_more: false,
  schema_version: 2,
});
describe('bounded protocol handling', () => {
  it('never acknowledges an unrequested outbox row', async () => {
    await h.imports.importFile({ blob: toBlob(buildEpubFixture()), filename: 'book.epub' });
    const rows = await h.changes.listPending();
    await expect(
      engine({
        push: async (request) => ({
          outcomes: [
            { id: rows.find((row) => row.id !== request.changes[0]!.id)!.id, status: 'accepted' },
          ],
        }),
        pull: emptyPull,
      }).sync(),
    ).rejects.toThrow(/mismatched/);
    expect(await h.changes.pendingCount()).toBe(rows.length);
  });
  it('caps push work per cycle and retains remaining changes', async () => {
    await h.imports.importFile({ blob: toBlob(buildEpubFixture()), filename: 'book.epub' });
    const before = await h.changes.pendingCount();
    const result = await engine({
      push: async (request) => ({
        outcomes: request.changes.map((row) => ({ id: row.id, status: 'accepted' })),
      }),
      pull: emptyPull,
    }).sync();
    expect(result.pushed).toBe(1);
    expect(await h.changes.pendingCount()).toBe(before - 1);
  });
  it('stops a nonadvancing has_more page instead of looping', async () => {
    await expect(
      engine({
        push: async () => ({ outcomes: [] }),
        pull: async () => ({ changes: [], next_cursor: 0, has_more: true, schema_version: 2 }),
      }).sync(),
    ).rejects.toThrow(/did not advance/);
  });
});

describe('canonical identity remains writable', () => {
  it('saves an already-open reader through its old ID after reconciliation', async () => {
    await h.db.books.put(book('z', 10));
    await h.progress.ensureDefault('z');
    await apply([change(book('a', 20))]);
    await h.progress.save({
      bookId: 'z',
      locator: { kind: 'cfi', value: 'epubcfi(/6/2!/4/2)', fraction: 0.25 },
    });
    expect((await h.progress.get('z'))?.bookId).toBe('a');
    expect(await h.db.progress.get('z')).toBeUndefined();
    expect((await h.db.progress.get('a'))?.fraction).toBe(0.25);
  });
  it('reasserts a local not-started choice even without a locator', async () => {
    await h.progress.ensureDefault('b');
    const before = (await h.db.progress.get('b'))!;
    const candidate = {
      ...before,
      deviceId: 'other',
      fraction: 0.8,
      updatedHlc: '1700000001000:0:other',
    };
    h.clock.observe(parseHlc(candidate.updatedHlc)!);
    await h.db.progressConflicts.put({
      bookId: 'b',
      remote: candidate,
      localFraction: 0,
      localUpdatedHlc: before.updatedHlc,
    });
    await h.progressConflicts.resolve('b', 'local');
    expect(
      compareHlc(
        parseHlc((await h.db.progress.get('b'))!.updatedHlc)!,
        parseHlc(candidate.updatedHlc)!,
      ),
    ).toBeGreaterThan(0);
    expect(await h.db.progressConflicts.get('b')).toBeUndefined();
  });
});

describe('metadata form snapshots', () => {
  it('does not refresh clocks on submitted fields the user did not change', async () => {
    const original = book('b', 10, { author: 'Original author' });
    await h.db.books.put(original);
    await h.books.updateMetadata('b', { title: original.title, author: 'Edited author' });
    const edited = (await h.db.books.get('b'))!;
    expect(edited.metadataHlcs?.title).toBe(original.updatedHlc);
    expect(edited.metadataHlcs?.author).toBe(edited.updatedHlc);
    const concurrentTitle = {
      ...original,
      title: 'Edited title',
      updatedHlc: '20:0:peer',
      metadataHlcs: { title: '20:0:peer', author: original.updatedHlc },
    };
    const combined = mergeBook(edited, concurrentTitle);
    expect(combined.title).toBe('Edited title');
    expect(combined.author).toBe('Edited author');
  });
});
