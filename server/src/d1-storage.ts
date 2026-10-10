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

/**
 * D1-backed change log. Idempotency rides on the `(user_id, change_id)` unique
 * index: `INSERT OR IGNORE` makes a retried push a no-op, and the run metadata
 * (`changes`, `last_row_id`) tells accepted from duplicate without a second
 * query or relying on `RETURNING`. `since` over-fetches by one row to report
 * `has_more` cheaply.
 */
export class D1ChangeStore implements ChangeStore {
  constructor(private readonly db: D1Database) {}

  async append(user: string, changes: readonly IncomingChange[]): Promise<AppendResult[]> {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO changes
         (user_id, change_id, entity, entity_id, op, hlc, payload, device_id, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    );
    const now = Date.now();
    const results: AppendResult[] = [];
    for (const change of changes) {
      const run = await insert
        .bind(
          user,
          change.changeId,
          change.entity,
          change.entityId,
          change.op,
          change.hlc,
          change.payload,
          change.deviceId,
          now,
        )
        .run();
      if (run.meta.changes === 1) {
        results.push({ changeId: change.changeId, status: 'accepted', seq: run.meta.last_row_id });
      } else {
        results.push({ changeId: change.changeId, status: 'duplicate' });
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
