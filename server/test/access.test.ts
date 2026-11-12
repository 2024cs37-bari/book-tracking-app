import { beforeAll, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, type JWK, type CryptoKey } from 'jose';
import { verifyAccess } from '../src/access';
import app from '../src/worker';

// Signature, issuer, audience and expiry verification are real JOSE code. Only
// rotating-key retrieval is local: these tests do not claim live Access coverage.
const keys = vi.hoisted(() => ({ value: [] as JWK[] }));
vi.mock('jose', async (importOriginal) => {
  const real = await importOriginal<typeof import('jose')>();
  return { ...real, createRemoteJWKSet: () => real.createLocalJWKSet({ keys: keys.value }) };
});

const env = {
  ACCESS_AUD: 'reader-audience',
  ACCESS_TEAM_DOMAIN: 'reader-test.cloudflareaccess.com',
};
let privateKey: CryptoKey;
beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  keys.value.push({
    ...(await exportJWK(pair.publicKey)),
    kid: 'test-key',
    alg: 'RS256',
    use: 'sig',
  });
});

async function token(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    sub: 'subject-1',
    email: 'owner@example.test',
    iss: `https://${env.ACCESS_TEAM_DOMAIN}`,
    aud: env.ACCESS_AUD,
    iat: now,
    exp: now + 60,
    ...overrides,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .sign(privateKey);
}

const request = (jwt: string) =>
  new Request('https://api.example.test/api/v1/files/' + 'a'.repeat(64), {
    headers: { 'Cf-Access-Jwt-Assertion': jwt },
  });

describe('Access authentication', () => {
  it('accepts only a correctly signed identity with the configured issuer and audience', async () => {
    expect(await verifyAccess(request(await token()), env)).toEqual({
      userId: 'owner@example.test',
    });
    for (const overrides of [
      { iss: 'https://other.cloudflareaccess.com' },
      { aud: 'other-app' },
      { exp: 1 },
      { exp: undefined },
    ] as const) {
      expect(await verifyAccess(request(await token(overrides)), env)).toBeNull();
    }
    const valid = await token();
    const parts = valid.split('.');
    parts[1] = btoa(JSON.stringify({ email: 'attacker@example.test' }));
    expect(await verifyAccess(request(parts.join('.')), env)).toBeNull();
  });

  it('accepts the Access cookie and fails closed on malformed percent escapes/configuration', async () => {
    const cookieRequest = new Request('https://api.example.test', {
      headers: { cookie: `CF_Authorization=${encodeURIComponent(await token())}` },
    });
    expect(await verifyAccess(cookieRequest, env)).toEqual({ userId: 'owner@example.test' });
    expect(
      await verifyAccess(
        new Request('https://api.example.test', { headers: { cookie: 'CF_Authorization=%zz' } }),
        env,
      ),
    ).toBeNull();
    expect(
      await verifyAccess(request('bad'), { ACCESS_AUD: '', ACCESS_TEAM_DOMAIN: '' }),
    ).toBeNull();
    expect(
      await verifyAccess(request('bad'), { ...env, ACCESS_TEAM_DOMAIN: 'evil.test/path' }),
    ).toBeNull();
  });

  it('protects every API route and never trusts DEV_USER on a public host', async () => {
    const bindings = {
      ...env,
      DEV_USER: 'bypass',
      FILES: { get: async () => null },
    } as unknown as Parameters<typeof app.request>[2];
    for (const [path, method] of [
      ['sync/push', 'POST'],
      ['sync/pull', 'GET'],
      ['files/begin', 'POST'],
      ['files/finish', 'POST'],
      [`files/${'a'.repeat(64)}`, 'PUT'],
      [`files/${'a'.repeat(64)}`, 'GET'],
      [`files/${'a'.repeat(64)}`, 'HEAD'],
    ] as const) {
      const response = await app.request(
        `https://api.example.test/api/v1/${path}`,
        { method },
        bindings,
      );
      expect(response.status).toBe(401);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
    }
    const authorized = await app.request(request(await token()), {}, bindings);
    expect(authorized.status).toBe(404);
  });

  it('does not reflect arbitrary CORS origins when CLIENT_ORIGIN is unset', async () => {
    const bindings = { ...env } as unknown as Parameters<typeof app.request>[2];
    const response = await app.request(
      'https://api.example.test/api/v1/sync/pull',
      { headers: { origin: 'https://evil.test' } },
      bindings,
    );
    expect(response.status).toBe(403);
    expect(response.headers.has('access-control-allow-origin')).toBe(false);
    const preflight = await app.request(
      'https://api.example.test/api/v1/sync/pull',
      {
        method: 'OPTIONS',
        headers: { origin: 'https://api.example.test', 'access-control-request-method': 'GET' },
      },
      bindings,
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://api.example.test');
  });
});
