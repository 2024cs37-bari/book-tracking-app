import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type TestHarness } from '../support/harness';
import { createClock, type Clock } from '~/domain/hlc';
import { applyPullPage } from '~/sync/apply';
import type { PullChange } from '~/sync/protocol';
import { isMembershipActive } from '~/domain/collections';

let harness: TestHarness;
let clock: Clock;

beforeEach(async () => {
  harness = await createHarness();
  clock = createClock({ deviceId: 'local', now: () => 2_000 });
});
afterEach(async () => {
  await harness.close();
});

const hlc = (wall: number, counter: number, device = 'remote'): string =>
  `${wall}:${counter}:${device}`;

let seq = 0;
function change(
  entity: PullChange['entity'],
  entityId: string,
  h: string,
  payload: unknown,
): PullChange {
  seq += 1;
  return { seq, change_id: `c${seq}`, entity, entity_id: entityId, hlc: h, payload };
}

function bookRow(id: string, title: string, updatedHlc: string) {
  return {
    id,
    sha256: 'a'.repeat(64),
    title,
    format: 'epub',
    sizeBytes: 10,
    metadataIncomplete: false,
    lifecycle: 'active',
    addedAt: 1,
    updatedHlc,
  };
}

async function apply(changes: PullChange[], cursor: number): Promise<void> {
  await applyPullPage(harness.db, harness.syncMeta, clock, changes, cursor);
}

describe('applyPullPage', () => {
  it('inserts fresh remote entities and advances the cursor', async () => {
    await apply([change('book', 'b1', hlc(100, 0), bookRow('b1', 'Remote Book', hlc(100, 0)))], 7);
    expect((await harness.db.books.get('b1'))?.title).toBe('Remote Book');
    expect(await harness.syncMeta.getPullCursor()).toBe(7);
  });

  it('writes no outbox rows — a remote change never echoes as a local mutation', async () => {
    await apply([change('book', 'b1', hlc(100, 0), bookRow('b1', 'Remote', hlc(100, 0)))], 1);
    expect(await harness.changes.totalCount()).toBe(0);
  });

  it('resolves conflicts last-writer-wins by HLC', async () => {
    await apply([change('book', 'b1', hlc(100, 0), bookRow('b1', 'First', hlc(100, 0)))], 1);
    // An older write loses...
    await apply([change('book', 'b1', hlc(50, 0), bookRow('b1', 'Older', hlc(50, 0)))], 2);
    expect((await harness.db.books.get('b1'))?.title).toBe('First');
    // ...a newer write wins.
    await apply([change('book', 'b1', hlc(200, 0), bookRow('b1', 'Newer', hlc(200, 0)))], 3);
    expect((await harness.db.books.get('b1'))?.title).toBe('Newer');
  });

  it('is idempotent when a page is replayed', async () => {
    const page = [change('book', 'b1', hlc(100, 0), bookRow('b1', 'Once', hlc(100, 0)))];
    await apply(page, 5);
    await apply(page, 5);
    expect(await harness.db.books.count()).toBe(1);
    expect((await harness.db.books.get('b1'))?.title).toBe('Once');
  });

  it('tombstones replicate: a newer delete hides the entity', async () => {
    await apply(
      [
        change('annotation', 'a1', hlc(100, 0), {
          id: 'a1',
          bookId: 'b1',
          kind: 'bookmark',
          locatorKind: 'cfi',
          locatorValue: 'x',
          fraction: 0.1,
          createdHlc: hlc(100, 0),
          updatedHlc: hlc(100, 0),
          deleted: false,
        }),
      ],
      1,
    );
    expect((await harness.db.annotations.get('a1'))?.deleted).toBe(false);
    await apply(
      [
        change('annotation', 'a1', hlc(200, 0), {
          id: 'a1',
          bookId: 'b1',
          kind: 'bookmark',
          locatorKind: 'cfi',
          locatorValue: 'x',
          fraction: 0.1,
          createdHlc: hlc(100, 0),
          updatedHlc: hlc(200, 0),
          deleted: true,
        }),
      ],
      2,
    );
    expect((await harness.db.annotations.get('a1'))?.deleted).toBe(true);
  });

  it('converges membership regardless of event order (re-add after remove wins)', async () => {
    const add1 = change('shelf_book', 's1:b1', hlc(100, 0), {
      shelfId: 's1',
      bookId: 'b1',
      addedHlc: hlc(100, 0),
    });
    const remove = change('shelf_book', 's1:b1', hlc(150, 0), {
      shelfId: 's1',
      bookId: 'b1',
      addedHlc: hlc(100, 0),
      removedHlc: hlc(150, 0),
    });
    const readd = change('shelf_book', 's1:b1', hlc(200, 0), {
      shelfId: 's1',
      bookId: 'b1',
      addedHlc: hlc(200, 0),
      removedHlc: hlc(150, 0),
    });

    await apply([add1, remove, readd], 1);
    const forward = await harness.db.shelfBooks.get(['s1', 'b1']);
    expect(isMembershipActive(forward!)).toBe(true);

    // Reverse arrival order converges to the same active state.
    await harness.db.shelfBooks.clear();
    await apply([readd, remove, add1], 2);
    const reverse = await harness.db.shelfBooks.get(['s1', 'b1']);
    expect(isMembershipActive(reverse!)).toBe(true);
    expect(reverse!.addedHlc).toBe(hlc(200, 0));
  });

  it('deduplicates append-only sessions by id', async () => {
    const session = change('session', 'x1', hlc(100, 0), {
      id: 'x1',
      bookId: 'b1',
      startedAt: 1,
      durationS: 30,
      deviceId: 'remote',
    });
    await apply([session], 1);
    await apply([session], 2);
    expect(await harness.db.sessions.count()).toBe(1);
  });

  it('advances the local clock past applied remote HLCs', async () => {
    await apply([change('book', 'b1', hlc(9_999, 3), bookRow('b1', 'Future', hlc(9_999, 3)))], 1);
    const next = clock.next();
    // A subsequent local mutation sorts after the observed remote HLC.
    expect(next.wallMs).toBeGreaterThanOrEqual(9_999);
  });
});
