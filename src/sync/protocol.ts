import { DB_SCHEMA_VERSION, type ChangeOp, type ChangeRow, type ReplicatedEntity } from '~/data/db';

/**
 * Sync wire protocol (docs/SYNC.md §4).
 *
 * These are the shapes exchanged with the sync server. Requests are built from
 * the local outbox; responses arrive from the network and are therefore treated
 * as untrusted and validated before use. Field names use the JSON (snake_case)
 * spelling the server speaks; the rest of the app stays camelCase.
 */

export const SYNC_API_VERSION = 'v1';

const REPLICATED_ENTITIES: readonly ReplicatedEntity[] = [
  'book',
  'progress',
  'annotation',
  'shelf',
  'shelf_book',
  'tag',
  'book_tag',
  'session',
];

export interface PushChange {
  readonly id: string;
  readonly entity: ReplicatedEntity;
  readonly entity_id: string;
  readonly op: ChangeOp;
  readonly hlc: string;
  readonly payload: unknown;
}

export interface PushRequest {
  readonly device_id: string;
  readonly schema_version: number;
  readonly changes: readonly PushChange[];
}

export type PushStatus = 'accepted' | 'duplicate' | 'retryable' | 'rejected';

export interface PushOutcome {
  readonly id: string;
  readonly status: PushStatus;
  /** Server sequence, present when accepted. */
  readonly seq?: number;
  /** Machine-readable error code for retryable/rejected outcomes. */
  readonly code?: string;
}

export interface PushResponse {
  readonly outcomes: readonly PushOutcome[];
}

export interface PullChange {
  readonly seq: number;
  readonly change_id: string;
  readonly entity: ReplicatedEntity;
  readonly entity_id: string;
  readonly hlc: string;
  readonly payload: unknown;
}

export interface PullResponse {
  readonly changes: readonly PullChange[];
  readonly next_cursor: number;
  readonly has_more: boolean;
  readonly schema_version: number;
}

/** A permanent server response signalling the client must re-bootstrap (§7). */
export const CURSOR_EXPIRED_CODE = 'cursor_expired';

/** Builds the wire form of a queued outbox row. Payload is parsed from JSON. */
export function toPushChange(row: ChangeRow): PushChange {
  return {
    id: row.id,
    entity: row.entity,
    entity_id: row.entityId,
    op: row.op,
    hlc: row.hlc,
    payload: JSON.parse(row.payload),
  };
}

export function buildPushRequest(deviceId: string, rows: readonly ChangeRow[]): PushRequest {
  return {
    device_id: deviceId,
    schema_version: DB_SCHEMA_VERSION,
    changes: rows.map(toPushChange),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isEntity(value: unknown): value is ReplicatedEntity {
  return typeof value === 'string' && (REPLICATED_ENTITIES as readonly string[]).includes(value);
}

export function isPushResponse(value: unknown): value is PushResponse {
  if (!isObject(value) || !Array.isArray(value.outcomes)) return false;
  const statuses = new Set<PushStatus>(['accepted', 'duplicate', 'retryable', 'rejected']);
  return value.outcomes.every((outcome) => {
    if (!isObject(outcome)) return false;
    if (typeof outcome.id !== 'string') return false;
    if (!statuses.has(outcome.status as PushStatus)) return false;
    if (outcome.seq !== undefined && !Number.isSafeInteger(outcome.seq)) return false;
    return true;
  });
}

export function isPullResponse(value: unknown): value is PullResponse {
  if (!isObject(value)) return false;
  if (!Array.isArray(value.changes)) return false;
  if (!Number.isSafeInteger(value.next_cursor) || (value.next_cursor as number) < 0) return false;
  if (typeof value.has_more !== 'boolean') return false;
  if (!Number.isSafeInteger(value.schema_version)) return false;
  // The per-entity payload shape is entity-specific and is validated when the
  // change is applied; here we only check the envelope the client routes on.
  return value.changes.every(
    (change) =>
      isObject(change) &&
      Number.isSafeInteger(change.seq) &&
      typeof change.change_id === 'string' &&
      isEntity(change.entity) &&
      typeof change.entity_id === 'string' &&
      typeof change.hlc === 'string' &&
      'payload' in change,
  );
}
