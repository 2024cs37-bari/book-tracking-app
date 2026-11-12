import type { Entity, ChangeOp } from './protocol';
import type { AppendResult, ChangeStore, IncomingChange, StoredChange } from './storage';

interface ChangeRow {
  readonly seq: number;
  readonly change_id: string;
  readonly entity: string;
  readonly entity_id: string;
  readonly op: string;
  readonly hlc: string;
  readonly payload: string;
  readonly device_id: string;
  readonly created_at: number;
}

function toStored(row: ChangeRow): StoredChange {
  return {
    seq: row.seq,
    changeId: row.change_id,
    entity: row.entity as Entity,
    entityId: row.entity_id,
    op: row.op as ChangeOp,
    hlc: row.hlc,
    payload: row.payload,
    deviceId: row.device_id,
    createdAt: row.created_at,
  };
}

/** D1-backed idempotent log; batches use two SQL queries, not two per change. */
export class D1ChangeStore implements ChangeStore {
  constructor(private readonly db: D1Database) {}

  async append(user: string, changes: readonly IncomingChange[]): Promise<AppendResult[]> {
    const now = Date.now();
    const results: AppendResult[] = [];
    // A JSON table avoids D1's 100 SQL-parameter cap and per-invocation query
    // limits. Keep each bound JSON value below the 2 MB D1 string limit, even
    // when escaping the canonical payload doubles its encoded byte count.
    const encoder = new TextEncoder();
    let offset = 0;
    while (offset < changes.length) {
      const chunk: IncomingChange[] = [];
      const encoded: string[] = [];
      let bytes = 2;
      while (offset < changes.length) {
        const change = changes[offset]!;
        const value = JSON.stringify(change);
        const size = encoder.encode(value).byteLength + 1;
        if (chunk.length && bytes + size > 1_500_000) break;
        chunk.push(change);
        encoded.push(value);
        bytes += size;
        offset += 1;
      }
      const json = `[${encoded.join(',')}]`;
      const batch = await this.db.batch<ChangeRow>([
        this.db
          .prepare(
            `INSERT OR IGNORE INTO changes
          (user_id, change_id, entity, entity_id, op, hlc, payload, device_id, created_at)
          SELECT ?1, json_extract(value, '$.changeId'), json_extract(value, '$.entity'),
            json_extract(value, '$.entityId'), json_extract(value, '$.op'),
            json_extract(value, '$.hlc'), json_extract(value, '$.payload'),
            json_extract(value, '$.deviceId'), ?3 FROM json_each(?2)
          RETURNING seq, change_id`,
          )
          .bind(user, json, now),
        this.db
          .prepare(
            `SELECT seq, change_id, entity, entity_id, op, hlc, payload, device_id, created_at
          FROM changes WHERE user_id = ?1 AND change_id IN
          (SELECT json_extract(value, '$.changeId') FROM json_each(?2))`,
          )
          .bind(user, json),
      ]);
      if (batch.some((result) => !result.success)) throw new Error('Change persistence failed');
      const inserted = new Set(batch[0]!.results.map((row) => row.change_id));
      const storedById = new Map(batch[1]!.results.map((row) => [row.change_id, row]));
      for (const change of chunk) {
        const stored = storedById.get(change.changeId);
        if (!stored) throw new Error('Change persistence failed');
        if (
          stored.entity !== change.entity ||
          stored.entity_id !== change.entityId ||
          stored.op !== change.op ||
          stored.hlc !== change.hlc ||
          stored.payload !== change.payload ||
          stored.device_id !== change.deviceId
        ) {
          results.push({ changeId: change.changeId, status: 'rejected', code: 'id_conflict' });
        } else {
          const accepted = inserted.delete(change.changeId);
          results.push({
            changeId: change.changeId,
            status: accepted ? 'accepted' : 'duplicate',
            seq: stored.seq,
          });
        }
      }
    }
    return results;
  }

  async since(
    user: string,
    sinceSeq: number,
    limit: number,
  ): Promise<{ changes: StoredChange[]; hasMore: boolean }> {
    const query = await this.db
      .prepare(
        `SELECT seq, change_id, entity, entity_id, op, hlc, payload, device_id, created_at
           FROM changes
          WHERE user_id = ?1 AND seq > ?2
          ORDER BY seq ASC
          LIMIT ?3`,
      )
      .bind(user, sinceSeq, limit + 1)
      .all<ChangeRow>();
    const rows = query.results.map(toStored);
    const hasMore = rows.length > limit;
    return { changes: hasMore ? rows.slice(0, limit) : rows, hasMore };
  }
}
