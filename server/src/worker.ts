import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { verifyAccess } from './access';
import { D1ChangeStore } from './d1-storage';
import { handlePull, handlePush } from './sync-core';
import { validatePushRequest, type PushRequest } from './protocol';
import {
  fileObjectKey,
  handleBeginUpload,
  handleFinishUpload,
  isSha256Hex,
  MAX_FILE_BYTES,
  R2ObjectStore,
} from './files';

/** Schema version this server speaks; mirrors the client's DB_SCHEMA_VERSION. */
const SCHEMA_VERSION = 2;
const DEFAULT_PULL_LIMIT = 200;
const MAX_PULL_LIMIT = 500;

interface Env {
  readonly DB: D1Database;
  /** Private R2 bucket for original book files (Phase 4; see docs/STORAGE.md §7). */
  readonly FILES: R2Bucket;
  readonly ACCESS_AUD: string;
  readonly ACCESS_TEAM_DOMAIN: string;
  /**
   * LOCAL DEVELOPMENT ONLY. When set (via `.dev.vars`, which `wrangler deploy`
   * never uploads), requests skip Access and act as this user, so the stack is
   * testable without Cloudflare Access in front. Never set it in production.
   */
  readonly DEV_USER?: string;
  /** Allowed browser origin for CORS; reflects the request origin when unset. */
  readonly CLIENT_ORIGIN?: string;
}

const app = new Hono<{ Bindings: Env; Variables: { userId: string } }>();

// The client is served from a different origin than the API (and from the Vite
// dev server locally), so cross-origin credentialed requests need CORS. Preflight
// is handled here before auth, scoped to CLIENT_ORIGIN when configured.
app.use('/api/*', (c, next) =>
  cors({
    origin: (origin) =>
      c.env.CLIENT_ORIGIN !== undefined && c.env.CLIENT_ORIGIN.length > 0
        ? c.env.CLIENT_ORIGIN
        : origin,
    credentials: true,
    allowMethods: ['GET', 'POST', 'PUT', 'OPTIONS'],
    allowHeaders: ['content-type'],
  })(c, next),
);

// Every sync and file route is gated by a verified Cloudflare Access identity,
// which also scopes the user's change log and object keys (SYNC.md §2, §4).
app.use('/api/v1/*', async (c, next) => {
  const devUser = c.env.DEV_USER;
  if (devUser !== undefined && devUser.length > 0) {
    c.set('userId', devUser);
    await next();
    return;
  }
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

// --- File transfer (Phase 4): original bytes PUT/GET through private R2. ---

app.post('/api/v1/files/begin', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ code: 'bad_json' }, 400);
  }
  const { sha256, size } = (body ?? {}) as { sha256?: unknown; size?: unknown };
  const result = await handleBeginUpload(
    new R2ObjectStore(c.env.FILES),
    c.get('userId'),
    sha256,
    size,
  );
  return c.json(result.body as Record<string, unknown>, result.status as 200);
});

app.post('/api/v1/files/finish', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ code: 'bad_json' }, 400);
  }
  const { sha256, size } = (body ?? {}) as { sha256?: unknown; size?: unknown };
  const result = await handleFinishUpload(
    new R2ObjectStore(c.env.FILES),
    c.get('userId'),
    sha256,
    size,
  );
  return c.json(result.body as Record<string, unknown>, result.status as 200);
});

app.put('/api/v1/files/:sha', async (c) => {
  const sha = c.req.param('sha');
  if (!isSha256Hex(sha)) return c.json({ code: 'bad_hash' }, 400);
  const bytes = await c.req.arrayBuffer();
  if (bytes.byteLength === 0) return c.json({ code: 'empty' }, 400);
  if (bytes.byteLength > MAX_FILE_BYTES) return c.json({ code: 'too_large' }, 413);
  await new R2ObjectStore(c.env.FILES).put(fileObjectKey(c.get('userId'), sha), bytes);
  return c.json({ ok: true });
});

app.get('/api/v1/files/:sha', async (c) => {
  const sha = c.req.param('sha');
  if (!isSha256Hex(sha)) return c.json({ code: 'bad_hash' }, 400);
  const object = await new R2ObjectStore(c.env.FILES).get(fileObjectKey(c.get('userId'), sha));
  if (object === null) return c.json({ code: 'not_found' }, 404);
  return c.body(object.bytes, 200, {
    'content-type': 'application/octet-stream',
    'content-length': String(object.size),
  });
});

export default app;
