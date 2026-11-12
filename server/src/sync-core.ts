import {
  validatePushChange,
  type PullResponse,
  type PushOutcome,
  type PushRequest,
  type PushResponse,
} from './protocol';
import type { ChangeStore, IncomingChange } from './storage';

/**
 * Server-side sync logic, free of any Cloudflare binding so it can be tested
 * against an in-memory store. The server is a durable, ordered, idempotent
 * change log (docs/SYNC.md §4–5): it sequences and de-duplicates pushes and
 * paginates pulls, but never interprets a payload — conflict resolution is the
 * client's job (ADR 0006).
 */

/** Applies a validated push body for one user, sequencing and de-duplicating. */
export async function handlePush(
  store: ChangeStore,
  user: string,
  request: PushRequest,
): Promise<PushResponse> {
  const toAppend: IncomingChange[] = [];
  for (const change of request.changes) {
    if (!validatePushChange(change)) continue;
    toAppend.push({
      changeId: change.id,
      entity: change.entity,
      entityId: change.entity_id,
      op: change.op,
      hlc: change.hlc,
      payload: JSON.stringify(change.payload),
      deviceId: request.device_id,
    });
  }

  const appended = toAppend.length > 0 ? await store.append(user, toAppend) : [];
  let index = 0;
  const outcomes: PushOutcome[] = request.changes.map((change) => {
    if (!validatePushChange(change)) {
      const raw = change as unknown;
      const id =
        typeof raw === 'object' && raw !== null && 'id' in raw && typeof raw.id === 'string'
          ? raw.id
          : '';
      return { id, status: 'rejected', code: 'invalid_change' };
    }
    // Keep results positional: repeated IDs in the same batch can have different outcomes.
    const result = appended[index++]!;
    return {
      id: result.changeId,
      status: result.status,
      ...(result.seq === undefined ? {} : { seq: result.seq }),
      ...(result.code === undefined ? {} : { code: result.code }),
    };
  });

  return { outcomes };
}

/** Returns a page of a user's changes strictly after `since`, in seq order. */
export async function handlePull(
  store: ChangeStore,
  user: string,
  since: number,
  limit: number,
  schemaVersion: number,
): Promise<PullResponse> {
  const { changes, hasMore } = await store.since(user, since, limit);
  const nextCursor = changes.length > 0 ? changes[changes.length - 1]!.seq : since;
  return {
    changes: changes.map((change) => ({
      seq: change.seq,
      change_id: change.changeId,
      entity: change.entity,
      entity_id: change.entityId,
      hlc: change.hlc,
      payload: JSON.parse(change.payload) as unknown,
    })),
    next_cursor: nextCursor,
    has_more: hasMore,
    schema_version: schemaVersion,
  };
}
