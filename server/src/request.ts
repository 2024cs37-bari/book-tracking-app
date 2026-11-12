/** Limits apply while reading, including chunked bodies without Content-Length. */
export class RequestError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 411 | 413 | 415,
  ) {
    super(code);
  }
}

export function contentLength(request: Request): number | undefined {
  const raw = request.headers.get('content-length');
  if (raw === null) return undefined;
  if (!/^\d+$/.test(raw)) throw new RequestError('bad_content_length', 400);
  const size = Number(raw);
  if (!Number.isSafeInteger(size)) throw new RequestError('bad_content_length', 400);
  return size;
}

export async function readJson(request: Request, maxBytes: number): Promise<unknown> {
  const length = contentLength(request);
  if (length !== undefined && length > maxBytes) throw new RequestError('too_large', 413);
  const type = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/json') throw new RequestError('unsupported_media_type', 415);
  if (request.body === null) throw new RequestError('bad_json', 400);
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  let size = 0;
  let text = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new RequestError('too_large', 413);
      text += decoder.decode(value, { stream: true });
    }
    if (length !== undefined && size !== length) throw new RequestError('bad_content_length', 400);
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof RequestError) throw error;
    throw new RequestError('bad_json', 400);
  } finally {
    reader.releaseLock();
  }
}
