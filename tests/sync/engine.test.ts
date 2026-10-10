import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type TestHarness } from '../support/harness';
import { buildEpubFixture, toBlob } from '../support/fixtures';
import { SyncEngine } from '~/sync/engine';
import type { SyncTransport } from '~/sync/transport';
import type { PullResponse, PushRequest, PushResponse } from '~/sync/protocol';

interface LoggedChange {
  seq: number;
  id: string;
  entity: string;
  entity_id: string;
  hlc: string;
  payload: unknown;
}

/** In-memory stand-in for the sync server: a sequenced, idempotent change log. */
class FakeServer {
  readonly log: LoggedChange[] = [];
  private seq = 0;
  readonly retryable = new Set<string>();
  failPull = false;
  pushCount = 0;

  push(request: PushRequest): PushResponse {
    this.pushCount += 1;
    const outcomes = request.changes.map((change) => {
      if (this.retryable.has(change.id)) return { id: change.id, status: 'retryable' as const };
      if (this.log.some((entry) => entry.id === change.id)) {
        return { id: change.id, status: 'duplicate' as const };
      }
      this.seq += 1;
      this.log.push({
        seq: this.seq,
        id: change.id,
        entity: change.entity,
        entity_id: change.entity_id,
        hlc: change.hlc,
        payload: change.payload,
      });
      return { id: change.id, status: 'accepted' as const, seq: this.seq };
    });
    return { outcomes };
  }

  pull(since: number, limit: number): PullResponse {
    if (this.failPull) throw new Error('pull failed');
    const page = this.log.filter((entry) => entry.seq > since).slice(0, limit);
    const nextCursor = page.length > 0 ? page[page.length - 1]!.seq : since;
    return {
      changes: page.map((entry) => ({
        seq: entry.seq,
        change_id: entry.id,
        entity: entry.entity as PullResponse['changes'][number]['entity'],
        entity_id: entry.entity_id,
        hlc: entry.hlc,
        payload: entry.payload,
      })),
      next_cursor: nextCursor,
      has_more: this.log.some((entry) => entry.seq > nextCursor),
      schema_version: 1,
    };
  }
}

function transportFor(server: FakeServer): SyncTransport {
  return {
    push: (request) => Promise.resolve(server.push(request)),
    pull: (since, limit) => Promise.resolve(server.pull(since, limit)),
  };
}

function engineFor(harness: TestHarness, transport: SyncTransport): SyncEngine {
  return new SyncEngine({
    db: harness.db,
    changes: harness.changes,
    syncMeta: harness.syncMeta,
    clock: harness.clock,
    transport,
    deviceId: harness.deviceId,
    pullLimit: 2,
    pushBatchSize: 2,
  });
}

async function seedBook(harness: TestHarness, title: string): Promise<string> {
  const outcome = await harness.imports.importFile({
    blob: toBlob(buildEpubFixture({ title })),
    filename: `${title}.epub`,
  });
  if (outcome.status !== 'imported') throw new Error('seed import failed');
  return outcome.book.id;
}

let server: FakeServer;
let a: TestHarness;

beforeEach(async () => {
  server = new FakeServer();
  a = await createHarness();
});
afterEach(async () => {
  await a.close();
});

describe('SyncEngine', () => {
  it('pushes the outbox and drains it, across batches', async () => {
    await seedBook(a, 'Pushed');
    await a.shelves.create('Favourites');
    const pendingBefore = await a.changes.pendingCount();
    expect(pendingBefore).toBeGreaterThan(2);

    const result = await engineFor(a, transportFor(server)).sync();

    expect(result.pushed).toBe(pendingBefore);
    expect(await a.changes.pendingCount()).toBe(0);
    expect(server.log.length).toBe(pendingBefore);
  });

  it('is idempotent: a repeated push creates no second server mutation', async () => {
    await seedBook(a, 'Once');
    const engine = engineFor(a, transportFor(server));
    await engine.sync();
    const afterFirst = server.log.length;
    await engine.sync();
    expect(server.log.length).toBe(afterFirst);
    expect(await a.changes.pendingCount()).toBe(0);
  });

  it('acknowledges only confirmed ids on a partial batch', async () => {
    await seedBook(a, 'Partial');
    const [first] = await a.changes.listPending(100);
    server.retryable.add(first!.id);

    await engineFor(a, transportFor(server)).sync();

    const stillPending = await a.changes.listPending(100);
    expect(stillPending.map((row) => row.id)).toContain(first!.id);
    expect(stillPending.every((row) => row.id === first!.id)).toBe(true);
  });

  it('a failed pull page does not advance the cursor', async () => {
    await seedBook(a, 'NoCursor');
    server.failPull = true;
    await expect(engineFor(a, transportFor(server)).sync()).rejects.toThrow(/pull failed/);
    expect(await a.syncMeta.getPullCursor()).toBe(0);
  });

  it('runs single-flight: concurrent calls join one cycle', async () => {
    await seedBook(a, 'Single');
    const engine = engineFor(a, transportFor(server));
    const [one, two] = await Promise.all([engine.sync(), engine.sync()]);
    expect(one).toBe(two);
    // One cycle pushed the outbox; the duplicate call did not start a second.
    expect(await a.changes.pendingCount()).toBe(0);
  });

  it('round-trips changes between two devices and converges', async () => {
    const b = await createHarness();
    try {
      const bookId = await seedBook(a, 'Shared');
      const shelf = await a.shelves.create('Reading');
      await a.shelves.addBook(shelf.id, bookId);
      await engineFor(a, transportFor(server)).sync();

      // B pulls A's work.
      await engineFor(b, transportFor(server)).sync();
      expect((await b.db.books.get(bookId))?.title).toBe('Shared');
      expect((await b.shelves.list()).map((s) => s.name)).toEqual(['Reading']);
      expect(await b.shelves.listBookIds(shelf.id)).toEqual([bookId]);

      // B renames the shelf (a strictly newer HLC) and syncs back.
      b.advanceTime(1_000);
      await b.shelves.rename(shelf.id, 'Finished');
      await engineFor(b, transportFor(server)).sync();

      // A pulls and converges on B's newer name.
      await engineFor(a, transportFor(server)).sync();
      expect((await a.shelves.list()).map((s) => s.name)).toEqual(['Finished']);
    } finally {
      await b.close();
    }
  });

  it('does not re-enqueue applied remote changes as local outbox rows', async () => {
    const b = await createHarness();
    try {
      await seedBook(a, 'Echo');
      await engineFor(a, transportFor(server)).sync();
      await engineFor(b, transportFor(server)).sync();
      // B applied A's changes but must not have queued its own echoes.
      expect(await b.changes.pendingCount()).toBe(0);
    } finally {
      await b.close();
    }
  });
});
