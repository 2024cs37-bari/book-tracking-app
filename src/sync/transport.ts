import type { PullResponse, PushRequest, PushResponse } from './protocol';

/**
 * Network boundary for sync. The real implementation POSTs/GETs the
 * Access-protected Worker endpoints; tests supply an in-memory fake. Keeping
 * this an interface is what lets the engine's logic be verified without a
 * server (docs/SYNC.md §4).
 */
export interface SyncTransport {
  push(request: PushRequest): Promise<PushResponse>;
  pull(since: number, limit: number): Promise<PullResponse>;
}
