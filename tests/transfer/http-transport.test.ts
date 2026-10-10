import { beforeEach, describe, expect, it } from 'vitest';
import { createHttpFileTransport, FileTransferHttpError } from '~/transfer/http-transport';

const BASE = 'https://host/api';
const SHA = 'a'.repeat(64);

/** A fake Worker + R2: routes the transport's requests against an in-memory map. */
function fakeServer() {
  const objects = new Map<string, Blob>();
  let forcedStatus: number | null = null;
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (forcedStatus !== null) return new Response('err', { status: forcedStatus });
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    const path = url.slice(BASE.length);

    if (path === '/v1/files/begin' && method === 'POST') {
      const { sha256 } = JSON.parse(String(init?.body)) as { sha256: string };
      return Response.json({ already_available: objects.has(sha256) });
    }
    if (path === '/v1/files/finish' && method === 'POST') {
      const { sha256 } = JSON.parse(String(init?.body)) as { sha256: string };
      return objects.has(sha256)
        ? Response.json({ ok: true })
        : Response.json({ code: 'object_missing' }, { status: 409 });
    }
    const match = /^\/v1\/files\/([0-9a-f]{64})$/.exec(path);
    if (match) {
      const sha = match[1]!;
      if (method === 'PUT') {
        objects.set(sha, new Blob([init!.body as BlobPart]));
        return Response.json({ ok: true });
      }
      if (method === 'GET') {
        const object = objects.get(sha);
        return object === undefined
          ? Response.json({ code: 'not_found' }, { status: 404 })
          : new Response(object);
      }
    }
    return new Response('not found', { status: 404 });
  }) as typeof globalThis.fetch;

  return { objects, fetch: fakeFetch, fail: (status: number) => (forcedStatus = status) };
}

let server: ReturnType<typeof fakeServer>;
let transport: ReturnType<typeof createHttpFileTransport>;

beforeEach(() => {
  server = fakeServer();
  transport = createHttpFileTransport({ baseUrl: BASE, fetch: server.fetch });
});

describe('createHttpFileTransport', () => {
  it('uploads bytes and then reports the object as already available', async () => {
    const auth = await transport.beginUpload(SHA, 3);
    expect(auth.alreadyAvailable).toBe(false);
    expect(auth.ticket?.url).toBe(`${BASE}/v1/files/${SHA}`);

    await transport.upload(auth.ticket!, new Blob([new Uint8Array([1, 2, 3])]));
    await transport.finishUpload(SHA, 3);
    expect(server.objects.has(SHA)).toBe(true);

    const again = await transport.beginUpload(SHA, 3);
    expect(again.alreadyAvailable).toBe(true);
  });

  it('downloads an existing object', async () => {
    await transport.upload({ url: `${BASE}/v1/files/${SHA}` }, new Blob([new Uint8Array([7, 8])]));
    const ticket = await transport.beginDownload(SHA);
    const blob = await transport.download(ticket);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([7, 8]));
  });

  it('throws a not-found (non-retryable) error for a missing download', async () => {
    const ticket = await transport.beginDownload(SHA);
    await expect(transport.download(ticket)).rejects.toMatchObject({
      options: { status: 404, retryable: false },
    });
  });

  it('classifies a 5xx as retryable and a 403 as auth-expired', async () => {
    server.fail(503);
    await expect(transport.beginUpload(SHA, 1)).rejects.toMatchObject({
      options: { retryable: true },
    });

    server.fail(403);
    const err = await transport.beginUpload(SHA, 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FileTransferHttpError);
    expect((err as FileTransferHttpError).options.authExpired).toBe(true);
  });
});
