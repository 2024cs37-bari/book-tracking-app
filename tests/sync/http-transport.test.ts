import { describe, expect, it } from 'vitest';
import { createHttpSyncTransport, SyncHttpError } from '~/sync/http-transport';
import type { PushRequest } from '~/sync/protocol';

interface Call {
  url: string;
  init?: RequestInit;
}

function stubFetch(responder: (url: string, init?: RequestInit) => Response) {
  const calls: Call[] = [];
  const fn = (url: string | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init });
    return Promise.resolve(responder(String(url), init));
  };
  return Object.assign(fn as unknown as typeof fetch, { calls });
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

const PUSH: PushRequest = { device_id: 'd', schema_version: 2, changes: [] };

describe('createHttpSyncTransport', () => {
  it('posts a push to the versioned endpoint and returns the parsed response', async () => {
    const fetchImpl = stubFetch(() =>
      json({ outcomes: [{ id: 'c1', status: 'accepted', seq: 5 }] }),
    );
    const transport = createHttpSyncTransport({ baseUrl: 'https://host/api/', fetch: fetchImpl });

    const response = await transport.push(PUSH);

    expect(fetchImpl.calls[0]!.url).toBe('https://host/api/v1/sync/push');
    expect(fetchImpl.calls[0]!.init?.method).toBe('POST');
    expect(JSON.parse(String(fetchImpl.calls[0]!.init?.body))).toMatchObject({ device_id: 'd' });
    expect(response.outcomes[0]).toMatchObject({ id: 'c1', status: 'accepted', seq: 5 });
  });

  it('builds the pull query and returns the parsed page', async () => {
    const fetchImpl = stubFetch(() =>
      json({ changes: [], next_cursor: 9, has_more: false, schema_version: 2 }),
    );
    const transport = createHttpSyncTransport({ baseUrl: 'https://host/api', fetch: fetchImpl });

    const page = await transport.pull(9, 50);

    expect(fetchImpl.calls[0]!.url).toBe('https://host/api/v1/sync/pull?since=9&limit=50');
    expect(page.next_cursor).toBe(9);
  });

  it('rejects a malformed response as non-retryable', async () => {
    const transport = createHttpSyncTransport({
      baseUrl: 'https://host/api',
      fetch: stubFetch(() => json({ nope: true })),
    });
    await expect(transport.push(PUSH)).rejects.toMatchObject({ options: { retryable: false } });
  });

  it('classifies server errors and rate limits as retryable, respecting Retry-After', async () => {
    const transport = createHttpSyncTransport({
      baseUrl: 'https://host/api',
      fetch: stubFetch(() =>
        json({ code: 'busy' }, { status: 429, headers: { 'retry-after': '2' } }),
      ),
    });
    const error = await transport.push(PUSH).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SyncHttpError);
    expect((error as SyncHttpError).options).toMatchObject({ retryable: true, retryAfterMs: 2000 });
  });

  it('flags auth expiry on 401/403 and does not mark it retryable', async () => {
    const transport = createHttpSyncTransport({
      baseUrl: 'https://host/api',
      fetch: stubFetch(() => json({}, { status: 401 })),
    });
    await expect(transport.pull(0, 10)).rejects.toMatchObject({
      options: { authExpired: true, retryable: false },
    });
  });

  it('surfaces an expired cursor as a distinct, non-retryable condition', async () => {
    const transport = createHttpSyncTransport({
      baseUrl: 'https://host/api',
      fetch: stubFetch(() => json({ code: 'cursor_expired' }, { status: 409 })),
    });
    await expect(transport.pull(3, 10)).rejects.toMatchObject({
      options: { cursorExpired: true, retryable: false },
    });
  });

  it('treats an ordinary 4xx as a permanent rejection', async () => {
    const transport = createHttpSyncTransport({
      baseUrl: 'https://host/api',
      fetch: stubFetch(() => json({ code: 'bad_schema' }, { status: 400 })),
    });
    await expect(transport.push(PUSH)).rejects.toMatchObject({ options: { retryable: false } });
  });
});
