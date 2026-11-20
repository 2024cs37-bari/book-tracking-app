import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { passwordHash, tokenHash } from '../src/password';

let runtime: Miniflare;
const origin = 'https://reader.example.test';
const password = 'test-only-long-password';
let sessionCookie = '';
const post = (body: unknown, cookie = '') => ({
  method: 'POST',
  headers: { origin, 'content-type': 'application/json', cookie },
  body: JSON.stringify(body),
});
beforeAll(async () => {
  const bundled = await build({ entryPoints: ['src/worker.ts'], bundle: true, write: false, format: 'esm', target: 'es2022', platform: 'browser', external: ['node:*'] });
  runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: bundled.outputFiles[0]!.text,
    compatibilityDate: '2026-10-01', compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['DB'], r2Buckets: ['FILES'],
    bindings: { AUTH_MODE: 'password', DEV_USER: 'must-not-bypass', ACCESS_AUD: '', ACCESS_TEAM_DOMAIN: '' },
  }));
  const db = await runtime.getD1Database('DB');
  for (const name of ['0001_init.sql', '0002_password_auth.sql']) {
    const sql = await readFile(`migrations/${name}`, 'utf8');
    await db.exec(sql.replace(/--[^\n]*/g, '').replace(/\n/g, ' '));
  }
  await db.prepare('INSERT INTO auth_owner VALUES(1, ?, ?, ?, ?)').bind('existing-owner', 'reader', 'a'.repeat(64), await passwordHash(password, 'a'.repeat(64))).run();
}, 30_000);
afterAll(async () => { await runtime?.dispose(); });

describe('password authentication with real Worker and D1', () => {
  it('does not bypass password auth with DEV_USER and rejects missing/cross-site origins', async () => {
    expect((await runtime.dispatchFetch(`${origin}/api/v1/sync/pull`)).status).toBe(401);
    expect((await runtime.dispatchFetch(`${origin}/api/auth/login`, { ...post({}), headers: { 'content-type': 'application/json' } })).status).toBe(403);
    expect((await runtime.dispatchFetch(`${origin}/api/auth/login`, { ...post({}), headers: { origin: 'https://evil.test', 'content-type': 'application/json' } })).status).toBe(403);
  });
  it('uses generic credential errors and creates a private, secure session', async () => {
    for (const username of ['reader', 'unknown']) {
      const failed = await runtime.dispatchFetch(`${origin}/api/auth/login`, post({ username, password: 'wrong', trustedDevice: false }));
      expect(failed.status).toBe(401);
      expect(await failed.json()).toEqual({ code: 'invalid_credentials' });
    }
    const response = await runtime.dispatchFetch(`${origin}/api/auth/login`, post({ username: 'reader', password, trustedDevice: false }));
    expect(response.status).toBe(200);
    const setCookie = response.headers.get('set-cookie')!;
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Max-Age=28800');
    expect(response.headers.get('cache-control')).toContain('no-store');
    sessionCookie = setCookie.split(';')[0]!;
    const session = await response.json() as { userId: string; trustedDevice: boolean };
    expect(session.userId).toBe('existing-owner');
    expect(session.trustedDevice).toBe(false);
    const db = await runtime.getD1Database('DB');
    const rows = await db.prepare('SELECT token_hash FROM auth_sessions').all<{ token_hash: string }>();
    expect(rows.results[0]!.token_hash).toBe(await tokenHash(sessionCookie.split('=')[1]!));
    expect(rows.results[0]!.token_hash).not.toBe(sessionCookie.split('=')[1]);
  });
  it('authorizes metadata and files only within the owner identity', async () => {
    const headers = { cookie: sessionCookie };
    expect((await runtime.dispatchFetch(`${origin}/api/auth/session`, { headers })).status).toBe(200);
    expect((await runtime.dispatchFetch(`${origin}/api/v1/sync/pull`, { headers })).status).toBe(200);
    const hash = 'f'.repeat(64);
    await (await runtime.getR2Bucket('FILES')).put(`files/another-owner/${hash}`, 'private');
    expect((await runtime.dispatchFetch(`${origin}/api/v1/files/${hash}`, { headers })).status).toBe(404);
    expect((await runtime.dispatchFetch(`${origin}/api/v1/files/${hash}`)).status).toBe(401);
  });
  it('revokes sessions on logout and rejects expired sessions', async () => {
    const response = await runtime.dispatchFetch(`${origin}/api/auth/logout`, post({}, sessionCookie));
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await runtime.dispatchFetch(`${origin}/api/auth/session`, { headers: { cookie: sessionCookie } })).status).toBe(401);
    const db = await runtime.getD1Database('DB');
    await db.prepare('INSERT INTO auth_sessions VALUES(?, ?, 0, ?)').bind(await tokenHash('b'.repeat(64)), 'existing-owner', Date.now() - 1000).run();
    expect((await runtime.dispatchFetch(`${origin}/api/auth/session`, { headers: { cookie: `book_reader_session=${'b'.repeat(64)}` } })).status).toBe(401);
  });
  it('enforces a persistent attempt budget before expensive hashing', async () => {
    const db = await runtime.getD1Database('DB');
    await db.prepare("UPDATE auth_attempts SET attempts = 10, started_at = ? WHERE bucket = 'login'").bind(Date.now()).run();
    const response = await runtime.dispatchFetch(`${origin}/api/auth/login`, post({ username: 'reader', password, trustedDevice: false }));
    expect(response.status).toBe(429);
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
  });
});
