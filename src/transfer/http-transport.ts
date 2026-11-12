import { parseRetryAfter, requestSignal } from '~/sync/network';
import type { FileTransport, TransferTicket, UploadAuthorization } from './transport';

/**
 * A file-transfer error. `retryable` tells the engine whether a later cycle
 * might succeed (network, rate-limit, server) versus a permanent problem
 * (validation, not-found); `authExpired` means network work should pause until
 * the user re-authenticates (mirrors SyncHttpError, SYNC.md §8).
 */
export class FileTransferHttpError extends Error {
  constructor(
    message: string,
    readonly options: {
      readonly status?: number;
      readonly retryable: boolean;
      readonly authExpired?: boolean;
      readonly retryAfterMs?: number;
    },
  ) {
    super(message);
    this.name = 'FileTransferHttpError';
  }
}

export interface HttpFileTransportOptions {
  /** API root, e.g. `https://host/api`; endpoints are `${baseUrl}/v1/files/...`. */
  readonly baseUrl: string;
  /** Injectable fetch for tests; defaults to the global. */
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function errorFor(response: Response): FileTransferHttpError {
  const status = response.status;
  const authExpired = status === 401 || status === 403;
  const retryable = status === 429 || status >= 500;
  return new FileTransferHttpError(`File transfer failed (${status})`, {
    status,
    retryable,
    authExpired,
    retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
  });
}

/**
 * The real file transport: Access-credentialed bytes PUT/GET through the Worker
 * (docs/BACKEND.md §6). The Worker mediates to private R2, so there is no signed
 * URL to handle here. Begin/finish authorize and confirm the upload; the
 * download GET is itself the authorized operation, so `beginDownload` only
 * builds the URL.
 */
export function createHttpFileTransport(options: HttpFileTransportOptions): FileTransport {
  const doFetch = options.fetch ?? globalThis.fetch;
  const base = options.baseUrl.replace(/\/+$/, '');
  const objectUrl = (sha256: string): string => `${base}/v1/files/${sha256}`;

  return {
    async hasRemoteFile(sha256: string, sizeBytes: number): Promise<boolean> {
      const response = await doFetch(objectUrl(sha256), {
        method: 'HEAD',
        credentials: 'include',
        signal: requestSignal(30_000),
      });
      if (response.status === 404) return false;
      if (!response.ok) throw errorFor(response);
      const length = response.headers.get('content-length');
      return length !== null && Number(length) === sizeBytes;
    },
    async beginUpload(
      sha256: string,
      sizeBytes: number,
      signal?: AbortSignal,
    ): Promise<UploadAuthorization> {
      const response = await doFetch(`${base}/v1/files/begin`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sha256, size: sizeBytes }),
        credentials: 'include',
        signal: requestSignal(options.timeoutMs ?? 120_000, signal),
      });
      if (!response.ok) throw errorFor(response);
      const json: unknown = await response.json().catch((error: unknown) => {
        if (error instanceof SyntaxError) return null;
        throw error;
      });
      if (!isObject(json) || typeof json.already_available !== 'boolean')
        throw new FileTransferHttpError('Malformed upload authorization.', { retryable: false });
      if (isObject(json) && json.already_available === true) return { alreadyAvailable: true };
      return { alreadyAvailable: false, ticket: { url: objectUrl(sha256) } };
    },

    async upload(ticket: TransferTicket, body: Blob, signal?: AbortSignal): Promise<void> {
      const response = await doFetch(ticket.url, {
        method: 'PUT',
        body,
        credentials: 'include',
        signal: requestSignal(options.timeoutMs ?? 120_000, signal),
      });
      if (!response.ok) throw errorFor(response);
    },

    async finishUpload(sha256: string, sizeBytes: number, signal?: AbortSignal): Promise<void> {
      const response = await doFetch(`${base}/v1/files/finish`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sha256, size: sizeBytes }),
        credentials: 'include',
        signal: requestSignal(options.timeoutMs ?? 120_000, signal),
      });
      if (!response.ok) throw errorFor(response);
    },

    beginDownload(sha256: string): Promise<TransferTicket> {
      // The authorized GET is the download itself; no pre-flight call needed.
      return Promise.resolve({ url: objectUrl(sha256) });
    },

    async download(ticket: TransferTicket, signal?: AbortSignal): Promise<Blob> {
      const response = await doFetch(ticket.url, {
        method: 'GET',
        credentials: 'include',
        signal: requestSignal(options.timeoutMs ?? 120_000, signal),
      });
      if (!response.ok) throw errorFor(response);
      return response.blob();
    },
  };
}
