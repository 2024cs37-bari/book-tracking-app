import type { Entity, ChangeOp } from './protocol';

/** A change as persisted in the authoritative log. */
export interface StoredChange {
  readonly seq: number;
  readonly changeId: string;
  readonly entity: Entity;
  readonly entityId: string;
  readonly op: ChangeOp;
  readonly hlc: string;
  /** Opaque canonical client JSON, stored verbatim. */
  readonly payload: string;
  readonly deviceId: string;
  readonly createdAt: number;
}

/** A change offered by a push, before it is sequenced. */
export interface IncomingChange {
  readonly changeId: string;
  readonly entity: Entity;
  readonly entityId: string;
  readonly op: ChangeOp;
  readonly hlc: string;
  readonly payload: string;
  readonly deviceId: string;
}

export interface AppendResult {
  readonly changeId: string;
  /** 'accepted' with a fresh seq, or 'duplicate' when the id was already stored. */
  readonly status: 'accepted' | 'duplicate';
  readonly seq?: number;
}

/**
 * The authoritative, append-only change log, scoped per user. A user's devices
 * share one log; the store never crosses users. Implementations must make
 * `append` idempotent per `(user, changeId)` and allocate strictly increasing
 * `seq` values, and `since` must return changes in ascending `seq` order.
 */
export interface ChangeStore {
  append(user: string, changes: readonly IncomingChange[]): Promise<AppendResult[]>;
  since(
    user: string,
    sinceSeq: number,
    limit: number,
  ): Promise<{ changes: StoredChange[]; hasMore: boolean }>;
}
