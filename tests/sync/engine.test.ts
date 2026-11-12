import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type TestHarness } from '../support/harness';
import { buildEpubFixture, toBlob } from '../support/fixtures';
import { SyncEngine } from '~/sync/engine';
import { SyncHttpError } from '~/sync/http-transport';
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
      schema_version: 2,
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

async function seedBook(harness: TestHarness, title: string, original?: Blob): Promise<string> {
  const outcome = await harness.imports.importFile({
    blob: original ?? toBlob(buildEpubFixture({ title })),
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

    await expect(engineFor(a, transportFor(server)).sync()).rejects.toMatchObject({
      options: { retryable: true },
    });

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

  it('re-bootstraps from zero when the server reports the cursor expired (§7)', async () => {
    const b = await createHarness();
    try {
      const bookId = await seedBook(a, 'Compacted');
      await engineFor(a, transportFor(server)).sync();

      // B catches up once, so it holds a non-zero cursor.
      await engineFor(b, transportFor(server)).sync();
      expect(await b.syncMeta.getPullCursor()).toBeGreaterThan(0);
      expect((await b.db.books.get(bookId))?.title).toBe('Compacted');

      // The server compacts past B's cursor: the next pull with since>0 reports
      // the cursor expired exactly once; after B resets to zero it serves the
      // whole history again.
      const base = transportFor(server);
      let expired = false;
      const flaky: SyncTransport = {
        push: base.push,
        pull: (since, limit) => {
          if (!expired && since > 0) {
            expired = true;
            return Promise.reject(
              new SyncHttpError('cursor expired', { retryable: false, cursorExpired: true }),
            );
          }
          return base.pull(since, limit);
        },
      };

      const result = await engineFor(b, flaky).sync();
      expect(result.bootstrapped).toBe(true);
      expect(result.caughtUp).toBe(true);
      // Replay from zero is idempotent: B still has exactly the server's data
      // and its cursor is caught up again.
      expect((await b.db.books.get(bookId))?.title).toBe('Compacted');
      expect(await b.syncMeta.getPullCursor()).toBe(server.log.length);
    } finally {
      await b.close();
    }
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

describe('independent imports across devices', () => {
  it('converges identical content and preserves both devices collections through replay', async () => {
    const b = await createHarness();
    const c = await createHarness();
    try {
      // Share the exact original: rebuilding a ZIP can change its timestamps
      // across a DOS-time boundary and create two different content hashes.
      const original = toBlob(buildEpubFixture({ title: 'Same file' }));
      const aid = await seedBook(a, 'Same file', original);
      const bid = await seedBook(b, 'Same file', original);
      expect(aid).not.toBe(bid);
      const ashelf = await a.shelves.create('A shelf');
      const bshelf = await b.shelves.create('B shelf');
      await a.shelves.addBook(ashelf.id, aid);
      await b.shelves.addBook(bshelf.id, bid);
      const aengine = engineFor(a, transportFor(server));
      const bengine = engineFor(b, transportFor(server));
      await aengine.sync();
      await bengine.sync();
      await aengine.sync();
      await engineFor(c, transportFor(server)).sync();
      const canonical = [aid, bid].sort()[0]!;
      for (const harness of [a, b, c]) {
        expect(await harness.db.books.count()).toBe(1);
        expect((await harness.db.books.toArray())[0]?.id).toBe(canonical);
        expect(await harness.shelves.listBookIds(ashelf.id)).toEqual([canonical]);
        expect(await harness.shelves.listBookIds(bshelf.id)).toEqual([canonical]);
      }
      await a.books.updateMetadata(canonical, { title: 'Renamed after convergence' });
      await aengine.sync();
      await bengine.sync();
      expect((await b.books.getById(canonical))?.title).toBe('Renamed after convergence');
    } finally {
      await b.close();
      await c.close();
    }
  });
});
