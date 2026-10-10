import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type TestHarness } from '../support/harness';
import { buildEpubFixture, toBlob } from '../support/fixtures';
import { compareHlc, parseHlc } from '~/domain/hlc';
import type { ProgressConflictRow } from '~/data/db';

let harness: TestHarness;

beforeEach(async () => {
  harness = await createHarness();
});
afterEach(async () => {
  await harness.close();
});

async function seedBook(title: string): Promise<string> {
  const outcome = await harness.imports.importFile({
    blob: toBlob(buildEpubFixture({ title })),
    filename: `${title}.epub`,
  });
  if (outcome.status !== 'imported') throw new Error('seed import failed');
  return outcome.book.id;
}

/** A remote HLC a little newer than the seeded local position (within drift),
 *  as a genuinely diverging candidate from another device would be. */
const REMOTE_HLC = '1700000002000:0:remote-device';

/** Records a pending remote candidate directly, as the sync apply path would —
 *  including observing the remote HLC into the clock, as applyPullPage does. */
async function recordConflict(bookId: string, remoteFraction: number): Promise<void> {
  const local = await harness.db.progress.get(bookId);
  const parsed = parseHlc(REMOTE_HLC);
  if (parsed) harness.clock.observe(parsed);
  const conflict: ProgressConflictRow = {
    bookId,
    remote: {
      bookId,
      status: 'reading',
      locatorKind: 'cfi',
      locatorValue: 'remote-pos',
      fraction: remoteFraction,
      updatedHlc: REMOTE_HLC,
      deviceId: 'remote-device',
    },
    localFraction: local?.fraction ?? 0,
    localUpdatedHlc: local?.updatedHlc ?? '',
  };
  await harness.db.progressConflicts.put(conflict);
}

describe('ProgressConflictRepository', () => {
  it('resolving to the remote candidate applies it without an outbox echo', async () => {
    const bookId = await seedBook('Remote Wins');
    harness.advanceTime(1_000);
    await harness.progress.save({
      bookId,
      locator: { kind: 'cfi', value: 'local-pos', fraction: 0.1 },
    });
    const pendingBefore = await harness.changes.pendingCount();
    await recordConflict(bookId, 0.9);

    await harness.progressConflicts.resolve(bookId, 'remote');

    const progress = await harness.db.progress.get(bookId);
    expect(progress?.fraction).toBe(0.9);
    expect(progress?.locatorValue).toBe('remote-pos');
    // Accepting pulled data must not enqueue a new outbox row.
    expect(await harness.changes.pendingCount()).toBe(pendingBefore);
    expect(await harness.progressConflicts.get(bookId)).toBeUndefined();
  });

  it('resolving to local re-asserts the position as a fresh, propagating mutation', async () => {
    const bookId = await seedBook('Local Wins');
    harness.advanceTime(1_000);
    await harness.progress.save({
      bookId,
      locator: { kind: 'cfi', value: 'local-pos', fraction: 0.2 },
    });
    await recordConflict(bookId, 0.95);
    const pendingBefore = await harness.changes.pendingCount();

    await harness.progressConflicts.resolve(bookId, 'local');

    const progress = await harness.db.progress.get(bookId);
    expect(progress?.fraction).toBe(0.2);
    expect(progress?.locatorValue).toBe('local-pos');
    // A fresh outbox row carries the choice to other devices, and its HLC now
    // dominates the remote candidate.
    expect(await harness.changes.pendingCount()).toBe(pendingBefore + 1);
    const localHlc = parseHlc(progress!.updatedHlc);
    const remoteHlc = parseHlc(REMOTE_HLC);
    expect(localHlc && remoteHlc && compareHlc(localHlc, remoteHlc) > 0).toBe(true);
    expect(await harness.progressConflicts.get(bookId)).toBeUndefined();
  });

  it('a later local read dismisses a pending prompt', async () => {
    const bookId = await seedBook('Dismiss');
    await recordConflict(bookId, 0.8);
    expect(await harness.progressConflicts.count()).toBe(1);

    harness.advanceTime(1_000);
    await harness.progress.save({
      bookId,
      locator: { kind: 'cfi', value: 'moved-on', fraction: 0.3 },
    });

    expect(await harness.progressConflicts.get(bookId)).toBeUndefined();
  });

  it('lists pending conflicts', async () => {
    const a = await seedBook('A');
    const b = await seedBook('B');
    await recordConflict(a, 0.6);
    await recordConflict(b, 0.7);
    const list = await harness.progressConflicts.list();
    expect(list.map((row) => row.bookId).sort()).toEqual([a, b].sort());
  });
});
