import { Hono } from 'hono';
import { readJson } from './request';
import { hashesEqual, passwordHash, PASSWORD_MAX_LENGTH, randomHex, tokenHash } from './password';

export interface PasswordEnv {
  readonly DB: D1Database;
  readonly AUTH_MODE?: string;
}
interface Owner {
  user_id: string;
  username: string;
  salt: string;
  password_hash: string;
}
interface SessionRow {
  user_id: string;
  username: string;
  trusted: number;
  expires_at: number;
}
const COOKIE = 'book_reader_session';
const ATTEMPT_WINDOW = 15 * 60_000;
const MAX_ATTEMPTS = 10;

function cookie(token: string, request: Request, seconds: number): string {
  const url = new URL(request.url);
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  return `${COOKIE}=${token}; Path=/api; HttpOnly; SameSite=Lax; Max-Age=${seconds}${secure}`;
}
function readToken(request: Request): string | null {
  const value = request.headers.get('Cookie')?.match(/(?:^|;\s*)book_reader_session=([a-f0-9]{64})(?:;|$)/)?.[1];
  return value ?? null;
}
function publicSession(row: SessionRow) {
  return {
    userId: row.user_id,
    username: row.username,
    trustedDevice: row.trusted === 1,
    expiresAt: new Date(row.expires_at).toISOString(),
  };
}
export async function passwordSession(request: Request, env: PasswordEnv): Promise<SessionRow | null> {
  const token = readToken(request);
  if (!token) return null;
  return env.DB.prepare(
    'SELECT s.user_id, o.username, s.trusted, s.expires_at FROM auth_sessions s JOIN auth_owner o ON o.user_id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?',
  ).bind(await tokenHash(token), Date.now()).first<SessionRow>();
}

export const passwordRoutes = new Hono<{ Bindings: PasswordEnv }>();
passwordRoutes.use('*', async (c, next) => {
  if (c.env.AUTH_MODE !== 'password') return c.json({ code: 'password_auth_disabled' }, 404);
  const url = new URL(c.req.url);
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    return c.json({ code: 'https_required' }, 403);
  await next();
});
passwordRoutes.get('/session', async (c) => {
  const session = await passwordSession(c.req.raw, c.env);
  return session ? c.json(publicSession(session)) : c.json({ code: 'unauthenticated' }, 401);
});
passwordRoutes.post('/login', async (c) => {
  const body = await readJson(c.req.raw, 4096) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      typeof body.username !== 'string' || body.username.length > 128 ||
      typeof body.password !== 'string' || body.password.length > PASSWORD_MAX_LENGTH ||
      typeof body.trustedDevice !== 'boolean') return c.json({ code: 'invalid_credentials' }, 400);
  const now = Date.now();
  // One bounded, atomic owner-wide budget prevents distributed username/IP bypass.
  const budget = await c.env.DB.prepare(
    `INSERT INTO auth_attempts(bucket, started_at, attempts) VALUES('login', ?, 1)
     ON CONFLICT(bucket) DO UPDATE SET
       attempts = CASE WHEN started_at <= ? THEN 1 ELSE attempts + 1 END,
       started_at = CASE WHEN started_at <= ? THEN excluded.started_at ELSE started_at END
     RETURNING attempts, started_at`,
  ).bind(now, now - ATTEMPT_WINDOW, now - ATTEMPT_WINDOW).first<{ attempts: number; started_at: number }>();
  if (!budget) return c.json({ code: 'temporarily_unavailable' }, 503);
  if (budget.attempts > MAX_ATTEMPTS) {
    c.header('Retry-After', String(Math.max(1, Math.ceil((budget.started_at + ATTEMPT_WINDOW - now) / 1000))));
    return c.json({ code: 'too_many_attempts' }, 429);
  }
  const owner = await c.env.DB.prepare('SELECT * FROM auth_owner WHERE singleton = 1').first<Owner>();
  const derived = await passwordHash(body.password, owner?.salt ?? '0'.repeat(64));
  const valid = hashesEqual(derived, owner?.password_hash ?? '0'.repeat(64));
  if (!owner || !valid || body.username.trim().toLowerCase() !== owner.username)
    return c.json({ code: 'invalid_credentials' }, 401);
  const lifetime = (body.trustedDevice ? 30 * 24 : 8) * 60 * 60;
  const expiresAt = now + lifetime * 1000;
  const token = randomHex();
  const prior = readToken(c.req.raw);
  const statements = [
    c.env.DB.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').bind(now),
    c.env.DB.prepare('INSERT INTO auth_sessions(token_hash, user_id, trusted, expires_at) VALUES(?, ?, ?, ?)')
      .bind(await tokenHash(token), owner.user_id, body.trustedDevice ? 1 : 0, expiresAt),
  ];
  if (prior) statements.push(c.env.DB.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').bind(await tokenHash(prior)));
  await c.env.DB.batch(statements);
  c.header('Set-Cookie', cookie(token, c.req.raw, lifetime));
  return c.json(publicSession({ user_id: owner.user_id, username: owner.username, trusted: body.trustedDevice ? 1 : 0, expires_at: expiresAt }));
});
passwordRoutes.post('/logout', async (c) => {
  await readJson(c.req.raw, 256);
  const token = readToken(c.req.raw);
  if (token) await c.env.DB.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').bind(await tokenHash(token)).run();
  c.header('Set-Cookie', cookie('', c.req.raw, 0));
  return c.json({ ok: true });
});
