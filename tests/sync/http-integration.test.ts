import { createServer, type Server, type RequestListener } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { createHttpSyncTransport } from '~/sync/http-transport';
import { createHttpFileTransport } from '~/transfer/http-transport';
import { parseRetryAfter } from '~/sync/network';
import { createHarness, type TestHarness } from '../support/harness';
import { SyncEngine } from '~/sync/engine';

let server: Server | undefined;
let h: TestHarness | undefined;
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve())),
    );
    server = undefined;
  }
  await h?.close();
  h = undefined;
});
async function listen(handler: RequestListener): Promise<string> {
  server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing port');
  return `http://127.0.0.1:${address.port}/api`;
}

describe('real HTTP boundary against a local contract stand-in', () => {
  it('preserves the outbox after a rate limit and retries identical change IDs after recovery', async () => {
    const bodies: Array<{ changes: Array<{ id: string }> }> = [];
    let failing = true;
    const baseUrl = await listen(async (req, res) => {
      if (req.url === '/api/v1/sync/push') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString()) as (typeof bodies)[number];
        bodies.push(body);
        res.setHeader('Content-Type', 'application/json');
        if (failing) {
          res.statusCode = 429;
          res.setHeader('Retry-After', '2');
          res.end(JSON.stringify({ code: 'rate_limit' }));
        } else
          res.end(
            JSON.stringify({
              outcomes: body.changes.map((c) => ({ id: c.id, status: 'accepted' })),
            }),
          );
      } else if (req.url?.startsWith('/api/v1/sync/pull?')) {
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({ changes: [], next_cursor: 0, has_more: false, schema_version: 2 }),
        );
      } else {
        res.statusCode = 501;
        res.end();
      }
    });
    h = await createHarness();
    await h.shelves.create('Offline work');
    const transport = createHttpSyncTransport({ baseUrl });
    const engine = new SyncEngine({
      db: h.db,
      changes: h.changes,
      syncMeta: h.syncMeta,
      clock: h.clock,
      deviceId: h.deviceId,
      transport,
    });
    await expect(engine.sync()).rejects.toMatchObject({
      options: { status: 429, retryable: true, retryAfterMs: 2000 },
    });
    expect(await h.changes.pendingCount()).toBe(1);
    expect((await h.shelves.list())[0]?.name).toBe('Offline work');
    failing = false;
    await engine.sync();
    expect(await h.changes.pendingCount()).toBe(0);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
  });
  it('bounds a hung HTTP request with a timeout', async () => {
    const baseUrl = await listen((_req, _res) => {});
    await expect(
      createHttpSyncTransport({ baseUrl, timeoutMs: 30 }).pull(0, 10),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
  });
  it('rejects a HTML sign-in page returned with status 200 as a permanent response error', async () => {
    const baseUrl = await listen((_req, res) => {
      res.end('<html>Sign in</html>');
    });
    await expect(createHttpSyncTransport({ baseUrl }).pull(0, 10)).rejects.toMatchObject({
      options: { retryable: false, code: 'bad_response' },
    });
  });
  it('checks HEAD content length before claiming a verified remote copy', async () => {
    const requests: string[] = [];
    const baseUrl = await listen((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      res.setHeader('content-length', '3');
      res.end();
    });
    const transport = createHttpFileTransport({ baseUrl });
    expect(await transport.hasRemoteFile!('a'.repeat(64), 3)).toBe(true);
    expect(await transport.hasRemoteFile!('a'.repeat(64), 4)).toBe(false);
    expect(requests.every((path) => path.startsWith('HEAD /api/v1/files/'))).toBe(true);
  });
  it('parses HTTP-date Retry-After and rejects invalid values', () => {
    const now = Date.UTC(2026, 0, 1);
    expect(parseRetryAfter(new Date(now + 30000).toUTCString(), now)).toBe(30000);
    expect(parseRetryAfter('nonsense', now)).toBeUndefined();
    expect(parseRetryAfter('-2', now)).toBeUndefined();
  });
});

describe('response-body deadline', () => {
  it('keeps a timeout during JSON streaming retryable', async () => {
    const { failurePolicy } = await import('~/sync/network');
    const baseUrl = await listen((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.writeHead(200);
      res.write('{');
    });
    try {
      await createHttpSyncTransport({ baseUrl, timeoutMs: 50 }).pull(0, 10);
      throw new Error('Expected a timeout');
    } catch (error) {
      expect(failurePolicy(error).retryable).toBe(true);
    }
  });
});
