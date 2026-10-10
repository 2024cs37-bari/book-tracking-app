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
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function errorFor(status: number): FileTransferHttpError {
  const authExpired = status === 401 || status === 403;
  const retryable = status === 429 || status >= 500;
  return new FileTransferHttpError(`File transfer failed (${status})`, {
    status,
    retryable,
    authExpired,
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
    async beginUpload(sha256: string, sizeBytes: number): Promise<UploadAuthorization> {
      const response = await doFetch(`${base}/v1/files/begin`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sha256, size: sizeBytes }),
        credentials: 'include',
      });
      if (!response.ok) throw errorFor(response.status);
      const json: unknown = await response.json();
      if (isObject(json) && json.already_available === true) return { alreadyAvailable: true };
      return { alreadyAvailable: false, ticket: { url: objectUrl(sha256) } };
    },

    async upload(ticket: TransferTicket, body: Blob): Promise<void> {
      const response = await doFetch(ticket.url, {
        method: 'PUT',
        body,
        credentials: 'include',
      });
      if (!response.ok) throw errorFor(response.status);
    },

    async finishUpload(sha256: string, sizeBytes: number): Promise<void> {
      const response = await doFetch(`${base}/v1/files/finish`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sha256, size: sizeBytes }),
        credentials: 'include',
      });
      if (!response.ok) throw errorFor(response.status);
    },

    beginDownload(sha256: string): Promise<TransferTicket> {
      // The authorized GET is the download itself; no pre-flight call needed.
      return Promise.resolve({ url: objectUrl(sha256) });
    },

    async download(ticket: TransferTicket): Promise<Blob> {
      const response = await doFetch(ticket.url, { method: 'GET', credentials: 'include' });
      if (!response.ok) throw errorFor(response.status);
      return response.blob();
    },
  };
}
