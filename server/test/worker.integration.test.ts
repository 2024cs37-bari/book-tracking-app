import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_PUSH_BYTES } from '../src/protocol';

let runtime: Miniflare;
const origin = 'http://localhost';

beforeAll(async () => {
  const bundled = await build({
    entryPoints: ['src/worker.ts'],
    bundle: true,
    write: false,
    format: 'esm',
    target: 'es2022',
  });
  runtime = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: bundled.outputFiles[0]!.text,
      compatibilityDate: '2026-10-01',
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: ['DB'],
      r2Buckets: ['FILES'],
      bindings: {
        DEV_USER: 'test-owner',
        ACCESS_AUD: '',
        ACCESS_TEAM_DOMAIN: '',
        CLIENT_ORIGIN: 'http://localhost:5173',
      },
    }),
  );
  const db = await runtime.getD1Database('DB');
  const migration = await readFile('migrations/0001_init.sql', 'utf8');
  await db.exec(migration.replace(/--[^\n]*/g, '').replace(/\n/g, ' '));
}, 30000);
afterAll(async () => {
  await runtime?.dispose();
});

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const push = (ids: string[]) => ({
  device_id: 'd1',
  schema_version: 2,
  changes: ids.map((id) => ({
    id,
    entity: 'book',
    entity_id: id,
    op: 'upsert',
    hlc: '100:0:d1',
    payload: { id, title: 'Example' },
  })),
});
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const put = (hash: string, bytes: Uint8Array) =>
  runtime.dispatchFetch(`${origin}/api/v1/files/${hash}`, {
    method: 'PUT',
    body: bytes,
    headers: {
      'content-length': String(bytes.byteLength),
      'content-type': 'application/octet-stream',
    },
  });

describe('Worker + local D1/R2 integration', () => {
  it('round trips, validates, and deduplicates streamed files with a real R2 checksum', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const hash = sha(bytes);
    const begin = () =>
      runtime.dispatchFetch(
        `${origin}/api/v1/files/begin`,
        json({ sha256: hash, size: bytes.length }),
      );
    expect(await (await begin()).json()).toEqual({ already_available: false });
    const uploaded = await put(hash, bytes);
    expect([uploaded.status, await uploaded.json()]).toEqual([200, { ok: true }]);
    expect(await (await begin()).json()).toEqual({ already_available: true });
    const finished = await runtime.dispatchFetch(
      `${origin}/api/v1/files/finish`,
      json({ sha256: hash, size: bytes.length }),
    );
    expect(finished.status).toBe(200);
    const head = await runtime.dispatchFetch(`${origin}/api/v1/files/${hash}`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe('5');
    expect(await head.text()).toBe('');
    const downloaded = await runtime.dispatchFetch(`${origin}/api/v1/files/${hash}`);
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(bytes);
    expect(downloaded.headers.get('cache-control')).toBe('private, no-store');
  });

  it('rejects corrupt uploads before publication and preserves existing correct bytes', async () => {
    const correct = new Uint8Array([8, 9, 10]);
    const hash = sha(correct);
    expect((await put(hash, correct)).status).toBe(200);
    const bad = await put(hash, new Uint8Array([10, 9, 8]));
    expect([bad.status, await bad.json()]).toEqual([422, { code: 'hash_mismatch' }]);
    const downloaded = await runtime.dispatchFetch(`${origin}/api/v1/files/${hash}`);
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(correct);
    const absentHash = 'f'.repeat(64);
    expect((await put(absentHash, correct)).status).toBe(422);
    expect((await runtime.dispatchFetch(`${origin}/api/v1/files/${absentHash}`)).status).toBe(404);
  });

  it('allows legacy file recovery but never confirms an unverified original safe for eviction', async () => {
    const bucket = await runtime.getR2Bucket('FILES');
    const bytes = new Uint8Array([66, 77]);
    const hash = sha(bytes);
    await bucket.put(`files/test-owner/${hash}`, bytes);
    expect((await runtime.dispatchFetch(`${origin}/api/v1/files/${hash}`)).status).toBe(200);
    expect(
      (await runtime.dispatchFetch(`${origin}/api/v1/files/${hash}`, { method: 'HEAD' })).status,
    ).toBe(404);
  });

  it('keeps another user’s private object inaccessible', async () => {
    const bucket = await runtime.getR2Bucket('FILES');
    const bytes = new Uint8Array([54]);
    const hash = sha(bytes);
    await bucket.put(`files/other-user/${hash}`, bytes, { sha256: hash });
    expect((await runtime.dispatchFetch(`${origin}/api/v1/files/${hash}`)).status).toBe(404);
  });

  it('rejects size limits before reading file or JSON bodies', async () => {
    const metadata = await runtime.dispatchFetch(
      `${origin}/api/v1/files/begin`,
      json({ padding: 'a'.repeat(4096) }),
    );
    expect(metadata.status).toBe(413);
    const sync = await runtime.dispatchFetch(`${origin}/api/v1/sync/push`, {
      ...json({ padding: 'x'.repeat(MAX_PUSH_BYTES) }),
    });
    expect(sync.status).toBe(413);
  });

  it('uses exact credentialed CORS including HEAD and rejects hostile origins', async () => {
    const good = await runtime.dispatchFetch(`${origin}/api/v1/files/begin`, {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'HEAD' },
    });
    expect(good.status).toBe(204);
    expect(good.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(good.headers.get('access-control-allow-credentials')).toBe('true');
    expect(good.headers.get('access-control-allow-methods')).toContain('HEAD');
    const bad = await runtime.dispatchFetch(`${origin}/api/v1/files/begin`, {
      ...json({}),
      headers: { 'content-type': 'application/json', origin: 'https://evil.test' },
    });
    expect(bad.status).toBe(403);
    expect(bad.headers.has('access-control-allow-origin')).toBe(false);
  });

  it('never applies the development auth bypass on a public request hostname', async () => {
    // CLIENT_ORIGIN must be HTTPS on public hosts; even a bad deployment fails closed.
    const response = await runtime.dispatchFetch('https://reader.example.test/api/v1/sync/pull');
    expect([401, 503]).toContain(response.status);
  });

  it('persists ordered changes and rejects reused IDs with different content', async () => {
    const request = push(['c1', 'c2']);
    const first = await runtime.dispatchFetch(`${origin}/api/v1/sync/push`, json(request));
    expect(first.status).toBe(200);
    const response = (await first.json()) as { outcomes: { status: string; seq: number }[] };
    expect(response.outcomes.map((row) => row.status)).toEqual(['accepted', 'accepted']);
    expect(response.outcomes[1]!.seq).toBeGreaterThan(response.outcomes[0]!.seq);
    const repeated = await runtime.dispatchFetch(`${origin}/api/v1/sync/push`, json(request));
    expect(
      ((await repeated.json()) as { outcomes: { status: string }[] }).outcomes.map(
        (row) => row.status,
      ),
    ).toEqual(['duplicate', 'duplicate']);
    request.changes[0]!.payload.title = 'Collision';
    const conflict = await runtime.dispatchFetch(`${origin}/api/v1/sync/push`, json(request));
    expect(((await conflict.json()) as { outcomes: unknown[] }).outcomes[0]).toEqual({
      id: 'c1',
      status: 'rejected',
      code: 'id_conflict',
    });
    const page = await runtime.dispatchFetch(`${origin}/api/v1/sync/pull?since=0&limit=1`);
    const body = (await page.json()) as {
      changes: { payload: { title: string } }[];
      has_more: boolean;
    };
    expect(body.has_more).toBe(true);
    expect(body.changes[0]!.payload.title).toBe('Example');
  });

  it('handles malformed members and repeated IDs positionally without a 500', async () => {
    const request = push(['same-batch', 'same-batch']);
    const response = await runtime.dispatchFetch(
      `${origin}/api/v1/sync/push`,
      json({ ...request, changes: [...request.changes, null] }),
    );
    expect(response.status).toBe(200);
    expect(
      ((await response.json()) as { outcomes: { status: string }[] }).outcomes.map(
        (row) => row.status,
      ),
    ).toEqual(['accepted', 'duplicate', 'rejected']);
  });

  it('accepts a maximum count batch through the real D1 JSON-table append', async () => {
    const request = push(Array.from({ length: 500 }, (_, index) => `bulk-${index}`));
    const response = await runtime.dispatchFetch(`${origin}/api/v1/sync/push`, json(request));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { outcomes: { status: string }[] };
    expect(body.outcomes).toHaveLength(500);
    expect(body.outcomes.every((outcome) => outcome.status === 'accepted')).toBe(true);
  });

  it('rejects unsupported schema and malformed pagination before persistence', async () => {
    const response = await runtime.dispatchFetch(
      `${origin}/api/v1/sync/push`,
      json({ ...push([]), schema_version: 999 }),
    );
    expect([response.status, await response.json()]).toEqual([409, { code: 'schema_mismatch' }]);
    for (const query of ['since=-1', 'since=Infinity', 'since=', 'limit=0', 'limit=oops']) {
      expect((await runtime.dispatchFetch(`${origin}/api/v1/sync/pull?${query}`)).status).toBe(400);
    }
  });
});
