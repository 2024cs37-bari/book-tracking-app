/**
 * Sync wire protocol — server copy (docs/SYNC.md §4).
 *
 * The client has its own copy of these shapes; they are the independently
 * versioned contract between two deployables, so they are duplicated rather
 * than imported across the boundary. The server validates every push body
 * because it is untrusted client input, but it never interprets `payload`: that
 * is opaque, canonical client JSON resolved by HLC rules on the client.
 */

export const REPLICATED_ENTITIES = [
  'book',
  'progress',
  'annotation',
  'shelf',
  'shelf_book',
  'tag',
  'book_tag',
  'session',
] as const;
export type Entity = (typeof REPLICATED_ENTITIES)[number];

export const CHANGE_OPS = ['upsert', 'delete'] as const;
export type ChangeOp = (typeof CHANGE_OPS)[number];

export interface PushChange {
  readonly id: string;
  readonly entity: Entity;
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
  readonly seq?: number;
  readonly code?: string;
}

export interface PushResponse {
  readonly outcomes: readonly PushOutcome[];
}

export interface PullChange {
  readonly seq: number;
  readonly change_id: string;
  readonly entity: Entity;
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

/** Max bytes of a serialized payload the server will accept (defence in depth). */
export const MAX_PAYLOAD_BYTES = 64 * 1024;
/** Max changes accepted in a single push body. */
export const MAX_PUSH_BATCH = 500;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Validates one change's envelope (not its opaque payload semantics). */
export function validatePushChange(value: unknown): value is PushChange {
  if (!isObject(value)) return false;
  if (typeof value.id !== 'string' || value.id.length === 0 || value.id.length > 128) return false;
  if (!(REPLICATED_ENTITIES as readonly string[]).includes(value.entity as string)) return false;
  if (typeof value.entity_id !== 'string' || value.entity_id.length === 0) return false;
  if (!(CHANGE_OPS as readonly string[]).includes(value.op as string)) return false;
  if (typeof value.hlc !== 'string' || !/^\d+:\d+:.+$/.test(value.hlc)) return false;
  if (!('payload' in value)) return false;
  if (JSON.stringify(value.payload).length > MAX_PAYLOAD_BYTES) return false;
  return true;
}

export type PushRequestError =
  'not_object' | 'bad_device' | 'bad_schema' | 'bad_changes' | 'too_many';

/** Validates the push envelope, returning an error code or null when valid. */
export function validatePushRequest(value: unknown): PushRequestError | null {
  if (!isObject(value)) return 'not_object';
  if (typeof value.device_id !== 'string' || value.device_id.length === 0) return 'bad_device';
  if (!Number.isSafeInteger(value.schema_version)) return 'bad_schema';
  if (!Array.isArray(value.changes)) return 'bad_changes';
  if (value.changes.length > MAX_PUSH_BATCH) return 'too_many';
  return null;
}
