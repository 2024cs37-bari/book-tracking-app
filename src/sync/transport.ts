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

/**
 * True when a transport error signals the pull cursor is no longer valid and the
 * client must re-bootstrap from zero (SYNC.md §7). Duck-typed so the engine need
 * not depend on the concrete HTTP transport: any transport may raise an error
 * carrying `options.cursorExpired === true` (as {@link SyncHttpError} does).
 */
export function isCursorExpiredError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('options' in error)) return false;
  const options = (error as { options?: unknown }).options;
  return (
    typeof options === 'object' &&
    options !== null &&
    (options as { cursorExpired?: unknown }).cursorExpired === true
  );
}
