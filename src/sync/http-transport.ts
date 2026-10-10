import {
  CURSOR_EXPIRED_CODE,
  isPullResponse,
  isPushResponse,
  SYNC_API_VERSION,
  type PullResponse,
  type PushRequest,
  type PushResponse,
} from './protocol';
import type { SyncTransport } from './transport';

/**
 * A sync transport error. `retryable` tells the engine whether a later cycle
 * with backoff might succeed (network, rate-limit, server) versus a permanent
 * problem (validation, schema) that must be surfaced, not spun on. `authExpired`
 * means network work should pause until the user re-authenticates (SYNC.md §8).
 */
export class SyncHttpError extends Error {
  constructor(
    message: string,
    readonly options: {
      readonly status?: number;
      readonly retryable: boolean;
      readonly authExpired?: boolean;
      readonly cursorExpired?: boolean;
      readonly code?: string;
      readonly retryAfterMs?: number;
    },
  ) {
    super(message);
    this.name = 'SyncHttpError';
  }
}

export interface HttpSyncTransportOptions {
  /** API root; endpoints are `${baseUrl}/v1/sync/{push,pull}`, e.g. `https://host/api`. */
  readonly baseUrl: string;
  /** Injectable fetch for tests; defaults to the global. */
  readonly fetch?: typeof fetch;
}

function retryAfterMs(headers: Headers): number | undefined {
  const value = headers.get('retry-after');
  if (value === null) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

async function errorFor(response: Response): Promise<SyncHttpError> {
  let code: string | undefined;
  try {
    const body: unknown = await response.clone().json();
    if (
      body !== null &&
      typeof body === 'object' &&
      typeof (body as { code?: unknown }).code === 'string'
    ) {
      code = (body as { code: string }).code;
    }
  } catch {
    // A non-JSON error body is fine; the status still classifies the failure.
  }
  const status = response.status;
  const authExpired = status === 401 || status === 403;
  const cursorExpired = status === 409 && code === CURSOR_EXPIRED_CODE;
  // Rate limits and server errors are worth retrying; other 4xx are permanent.
  const retryable = status === 429 || status >= 500;
  return new SyncHttpError(`Sync request failed (${status}${code ? ` ${code}` : ''})`, {
    status,
    retryable,
    authExpired,
    cursorExpired,
    code,
    retryAfterMs: retryAfterMs(response.headers),
  });
}

/**
 * The real network transport: Access-protected JSON over HTTPS (SYNC.md §4).
 * Access identity rides on the credentialed request, so no token is handled
 * here. Responses are validated before use because they cross the network.
 */
export function createHttpSyncTransport(options: HttpSyncTransportOptions): SyncTransport {
  const doFetch = options.fetch ?? globalThis.fetch;
  const base = options.baseUrl.replace(/\/+$/, '');

  return {
    async push(request: PushRequest): Promise<PushResponse> {
      const response = await doFetch(`${base}/${SYNC_API_VERSION}/sync/push`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
        credentials: 'include',
      });
      if (!response.ok) throw await errorFor(response);
      const json: unknown = await response.json();
      if (!isPushResponse(json)) {
        throw new SyncHttpError('Malformed push response', {
          retryable: false,
          code: 'bad_response',
        });
      }
      return json;
    },

    async pull(since: number, limit: number): Promise<PullResponse> {
      const url = `${base}/${SYNC_API_VERSION}/sync/pull?since=${since}&limit=${limit}`;
      const response = await doFetch(url, { method: 'GET', credentials: 'include' });
      if (!response.ok) throw await errorFor(response);
      const json: unknown = await response.json();
      if (!isPullResponse(json)) {
        throw new SyncHttpError('Malformed pull response', {
          retryable: false,
          code: 'bad_response',
        });
      }
      return json;
    },
  };
}
