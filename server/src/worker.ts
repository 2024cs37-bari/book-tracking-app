import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { verifyAccess } from './access';
import { D1ChangeStore } from './d1-storage';
import { handlePull, handlePush } from './sync-core';
import { MAX_PUSH_BYTES, SCHEMA_VERSION, validatePushRequest, type PushRequest } from './protocol';
import { contentLength, readJson, RequestError } from './request';
import {
  fileObjectKey,
  handleBeginUpload,
  handleFinishUpload,
  isSha256Hex,
  MAX_FILE_BYTES,
  R2ObjectStore,
} from './files';

const DEFAULT_PULL_LIMIT = 200;
const MAX_PULL_LIMIT = 500;
const MAX_FILE_METADATA_BYTES = 4096;

export interface Env {
  readonly DB: D1Database;
  readonly FILES: R2Bucket;
  readonly ACCESS_AUD: string;
  readonly ACCESS_TEAM_DOMAIN: string;
  /** Local .dev.vars only. The bypass is also restricted to loopback request URLs. */
  readonly DEV_USER?: string;
  /** Exact permitted frontend origin. Unset allows only same-origin browser requests. */
  readonly CLIENT_ORIGIN?: string;
}

const app = new Hono<{ Bindings: Env; Variables: { userId: string } }>();

function isLoopback(url: URL): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

app.onError((error, c) => {
  if (error instanceof RequestError) return c.json({ code: error.code }, error.status);
  // Never return or log storage exceptions containing keys or private payloads.
  return c.json({ code: 'temporarily_unavailable' }, 503, { 'Retry-After': '5' });
});
app.notFound((c) => c.json({ code: 'not_found' }, 404));

app.use('/api/*', async (c, next) => {
  c.header('Cache-Control', 'private, no-store');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Vary', 'Origin');
  const requestUrl = new URL(c.req.url);
  const configured = c.env.CLIENT_ORIGIN?.trim();
  let allowed = requestUrl.origin;
  if (configured) {
    let url: URL;
    try {
      url = new URL(configured);
    } catch {
      return c.json({ code: 'server_misconfigured' }, 503);
    }
    if (
      url.origin !== configured ||
      (url.protocol !== 'https:' &&
        !(isLoopback(url) && isLoopback(requestUrl) && url.protocol === 'http:'))
    ) {
      return c.json({ code: 'server_misconfigured' }, 503);
    }
    allowed = configured;
  }
  const origin = c.req.header('Origin');
  // Reject mutations too, rather than relying solely on browser CORS reads.
  if (origin !== undefined && origin !== allowed && origin !== requestUrl.origin) {
    return c.json({ code: 'origin_forbidden' }, 403);
  }
  return cors({
    origin: (value) => (value === allowed || value === requestUrl.origin ? value : ''),
    credentials: true,
    allowMethods: ['GET', 'HEAD', 'POST', 'PUT', 'OPTIONS'],
    allowHeaders: ['content-type'],
    exposeHeaders: ['content-length', 'retry-after'],
    maxAge: 600,
  })(c, next);
});

app.use('/api/v1/*', async (c, next) => {
  const devUser = c.env.DEV_USER;
  if (devUser && isLoopback(new URL(c.req.url))) {
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
  const body = await readJson(c.req.raw, MAX_PUSH_BYTES);
  const error = validatePushRequest(body);
  if (error !== null) return c.json({ code: error }, error === 'schema_mismatch' ? 409 : 400);
  return c.json(
    await handlePush(new D1ChangeStore(c.env.DB), c.get('userId'), body as PushRequest),
  );
});

app.get('/api/v1/sync/pull', async (c) => {
  const cursor = c.req.query('since') ?? '0';
  const since = Number(cursor);
  if (!/^\d+$/.test(cursor) || !Number.isSafeInteger(since))
    return c.json({ code: 'bad_cursor' }, 400);
  const rawLimit = c.req.query('limit') ?? String(DEFAULT_PULL_LIMIT);
  const requested = Number(rawLimit);
  if (!/^\d+$/.test(rawLimit) || !Number.isSafeInteger(requested) || requested < 1) {
    return c.json({ code: 'bad_limit' }, 400);
  }
  const limit = Math.min(requested, MAX_PULL_LIMIT);
  return c.json(
    await handlePull(new D1ChangeStore(c.env.DB), c.get('userId'), since, limit, SCHEMA_VERSION),
  );
});

for (const [path, handler] of [
  ['begin', handleBeginUpload],
  ['finish', handleFinishUpload],
] as const) {
  app.post(`/api/v1/files/${path}`, async (c) => {
    const body = await readJson(c.req.raw, MAX_FILE_METADATA_BYTES);
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ code: 'not_object' }, 400);
    }
    const { sha256, size } = body as { sha256?: unknown; size?: unknown };
    const result = await handler(new R2ObjectStore(c.env.FILES), c.get('userId'), sha256, size);
    return c.json(result.body, result.status);
  });
}

app.put('/api/v1/files/:sha', async (c) => {
  const sha = c.req.param('sha');
  if (!isSha256Hex(sha)) return c.json({ code: 'bad_hash' }, 400);
  const size = contentLength(c.req.raw);
  // Browser fetch(Blob) supplies this automatically. Unknown-length streams
  // need a future multipart protocol, not unbounded buffering in the Worker.
  if (size === undefined) return c.json({ code: 'length_required' }, 411);
  if (size === 0 || c.req.raw.body === null) return c.json({ code: 'empty' }, 400);
  if (size > MAX_FILE_BYTES) return c.json({ code: 'too_large' }, 413);
  try {
    await new R2ObjectStore(c.env.FILES).put(
      fileObjectKey(c.get('userId'), sha),
      c.req.raw.body,
      sha,
    );
  } catch (error) {
    // R2 rejects a bad checksum atomically; never overwrite a good object with
    // unverified bytes. Other storage errors remain retryable 503 responses.
    if (error instanceof Error && /checksum|digest/i.test(error.message)) {
      return c.json({ code: 'hash_mismatch' }, 422);
    }
    throw error;
  }
  return c.json({ ok: true });
});

app.get('/api/v1/files/:sha', async (c) => {
  const sha = c.req.param('sha');
  if (!isSha256Hex(sha)) return c.json({ code: 'bad_hash' }, 400);
  // Hono dispatches HEAD through GET, preserving the raw request method.
  if (c.req.raw.method === 'HEAD') {
    const metadata = await new R2ObjectStore(c.env.FILES).head(fileObjectKey(c.get('userId'), sha));
    if (metadata === null || metadata.sha256 !== sha) return c.body(null, 404);
    return c.body(null, 200, {
      'Content-Length': String(metadata.size),
      'Content-Type': 'application/octet-stream',
    });
  }
  const object = await new R2ObjectStore(c.env.FILES).get(fileObjectKey(c.get('userId'), sha));
  if (object === null) return c.json({ code: 'not_found' }, 404);
  // Existing legacy objects remain downloadable so their owners can recover
  // and re-upload them. Downloaders independently verify SHA-256 before save.
  return c.body(object.body, 200, {
    'content-type': 'application/octet-stream',
    'content-length': String(object.size),
    'content-disposition': 'attachment',
  });
});

export default app;
