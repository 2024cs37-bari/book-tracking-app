import { Hono } from 'hono';
import { verifyAccess } from './access';
import { D1ChangeStore } from './d1-storage';
import { handlePull, handlePush } from './sync-core';
import { validatePushRequest, type PushRequest } from './protocol';

/** Schema version this server speaks; mirrors the client's DB_SCHEMA_VERSION. */
const SCHEMA_VERSION = 2;
const DEFAULT_PULL_LIMIT = 200;
const MAX_PULL_LIMIT = 500;

interface Env {
  readonly DB: D1Database;
  readonly ACCESS_AUD: string;
  readonly ACCESS_TEAM_DOMAIN: string;
}

const app = new Hono<{ Bindings: Env; Variables: { userId: string } }>();

// Every sync route is gated by a verified Cloudflare Access identity, which
// also scopes the user's change log (docs/SYNC.md §2, §4).
app.use('/api/v1/sync/*', async (c, next) => {
  const identity = await verifyAccess(c.req.raw, c.env);
  if (identity === null) return c.json({ code: 'unauthenticated' }, 401);
  c.set('userId', identity.userId);
  await next();
});

app.post('/api/v1/sync/push', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ code: 'bad_json' }, 400);
  }
  const error = validatePushRequest(body);
  if (error !== null) return c.json({ code: error }, 400);
  const response = await handlePush(
    new D1ChangeStore(c.env.DB),
    c.get('userId'),
    body as PushRequest,
  );
  return c.json(response);
});

app.get('/api/v1/sync/pull', async (c) => {
  const since = Number(c.req.query('since') ?? '0');
  if (!Number.isSafeInteger(since) || since < 0) return c.json({ code: 'bad_cursor' }, 400);
  const requested = Number(c.req.query('limit') ?? String(DEFAULT_PULL_LIMIT));
  const limit = Number.isSafeInteger(requested)
    ? Math.max(1, Math.min(requested, MAX_PULL_LIMIT))
    : DEFAULT_PULL_LIMIT;
  const response = await handlePull(
    new D1ChangeStore(c.env.DB),
    c.get('userId'),
    since,
    limit,
    SCHEMA_VERSION,
  );
  return c.json(response);
});

export default app;
