import { describe, expect, it } from 'vitest';
import { handlePull, handlePush } from '../src/sync-core';
import type { AppendResult, ChangeStore, IncomingChange, StoredChange } from '../src/storage';
import type { PushRequest } from '../src/protocol';

interface Row extends StoredChange {
  readonly user: string;
}

/** In-memory authoritative log mirroring the D1 contract. */
class MemoryStore implements ChangeStore {
  private rows: Row[] = [];
  private seq = 0;

  append(user: string, changes: readonly IncomingChange[]): Promise<AppendResult[]> {
    const results = changes.map((change): AppendResult => {
      const existing = this.rows.find((r) => r.user === user && r.changeId === change.changeId);
      if (existing) return { changeId: change.changeId, status: 'duplicate' };
      this.seq += 1;
      this.rows.push({ ...change, user, seq: this.seq, createdAt: 0 });
      return { changeId: change.changeId, status: 'accepted', seq: this.seq };
    });
    return Promise.resolve(results);
  }

  since(
    user: string,
    sinceSeq: number,
    limit: number,
  ): Promise<{ changes: StoredChange[]; hasMore: boolean }> {
    const all = this.rows
      .filter((r) => r.user === user && r.seq > sinceSeq)
      .sort((a, b) => a.seq - b.seq);
    const page = all.slice(0, limit);
    return Promise.resolve({ changes: page, hasMore: all.length > page.length });
  }
}

function pushBody(ids: string[], device = 'd1'): PushRequest {
  return {
    device_id: device,
    schema_version: 2,
    changes: ids.map((id) => ({
      id,
      entity: 'progress',
      entity_id: `b-${id}`,
      op: 'upsert',
      hlc: `100:${id.length}:${device}`,
      payload: { bookId: `b-${id}`, fraction: 0.5 },
    })),
  };
}

describe('handlePush', () => {
  it('accepts new changes with strictly increasing sequences', async () => {
    const store = new MemoryStore();
    const response = await handlePush(store, 'user@a', pushBody(['c1', 'c2']));
    expect(response.outcomes.map((o) => o.status)).toEqual(['accepted', 'accepted']);
    const seqs = response.outcomes.map((o) => o.seq!);
    expect(seqs[1]!).toBeGreaterThan(seqs[0]!);
  });

  it('is idempotent: a repeated change id returns duplicate, not a new row', async () => {
    const store = new MemoryStore();
    await handlePush(store, 'user@a', pushBody(['c1']));
    const again = await handlePush(store, 'user@a', pushBody(['c1', 'c2']));
    expect(again.outcomes.find((o) => o.id === 'c1')?.status).toBe('duplicate');
    expect(again.outcomes.find((o) => o.id === 'c2')?.status).toBe('accepted');
  });

  it('rejects a structurally invalid change without affecting the others', async () => {
    const store = new MemoryStore();
    const body: PushRequest = {
      device_id: 'd1',
      schema_version: 2,
      changes: [
        {
          id: 'good',
          entity: 'progress',
          entity_id: 'b1',
          op: 'upsert',
          hlc: '1:0:d',
          payload: {},
        },
        {
          id: 'bad',
          entity: 'nonsense',
          entity_id: 'b1',
          op: 'upsert',
          hlc: 'x',
          payload: {},
        } as never,
      ],
    };
    const response = await handlePush(store, 'user@a', body);
    expect(response.outcomes.find((o) => o.id === 'good')?.status).toBe('accepted');
    expect(response.outcomes.find((o) => o.id === 'bad')?.status).toBe('rejected');
  });
});

describe('handlePull', () => {
  it('returns changes after the cursor in order with has_more and next_cursor', async () => {
    const store = new MemoryStore();
    await handlePush(store, 'user@a', pushBody(['c1', 'c2', 'c3']));

    const first = await handlePull(store, 'user@a', 0, 2, 2);
    expect(first.changes.map((c) => c.change_id)).toEqual(['c1', 'c2']);
    expect(first.has_more).toBe(true);
    expect(first.next_cursor).toBe(2);

    const second = await handlePull(store, 'user@a', first.next_cursor, 2, 2);
    expect(second.changes.map((c) => c.change_id)).toEqual(['c3']);
    expect(second.has_more).toBe(false);
    expect(second.changes[0]!.payload).toMatchObject({ fraction: 0.5 });
  });

  it('scopes a log per user so one user never sees another user changes', async () => {
    const store = new MemoryStore();
    await handlePush(store, 'user@a', pushBody(['a1']));
    await handlePush(store, 'user@b', pushBody(['b1']));
    const forA = await handlePull(store, 'user@a', 0, 100, 2);
    expect(forA.changes.map((c) => c.change_id)).toEqual(['a1']);
  });
});
