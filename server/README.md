# Sync server

Cloudflare Worker backend for cross-device sync (Phase 3). It is a durable,
ordered, idempotent change log over D1, gated by Cloudflare Access. It stores
the client's canonical change payloads verbatim and never interprets them —
conflict resolution is the client's job (see [ADR 0006](../docs/decisions/0006-sync-client.md)
and [docs/SYNC.md](../docs/SYNC.md)).

## Layout

- `src/protocol.ts` — wire contract + request validation (untrusted input).
- `src/sync-core.ts` — pure push/pull logic, tested against an in-memory store.
- `src/storage.ts` / `src/d1-storage.ts` — the `ChangeStore` interface and its D1 implementation.
- `src/access.ts` — Cloudflare Access JWT verification (JWKS, audience, issuer).
- `src/worker.ts` — the Hono app wiring Access + routes + D1.
- `migrations/` — D1 schema.

## Endpoints

- `POST /api/v1/sync/push` — append a batch; per-change `accepted`/`duplicate`/`rejected` with server seq.
- `GET /api/v1/sync/pull?since=<seq>&limit=<n>` — a page of changes after the cursor.

Both require a valid Access identity, which also scopes the change log per user.

## Develop and test

```sh
npm install
npm run typecheck
npm test            # pure sync-core logic
```

## Deploy (one-time setup)

The repo ships placeholders only; real resource ids and Access values are set at
deploy time and are not committed.

```sh
# 1. Create the D1 database and paste its id into wrangler.toml (database_id).
npx wrangler d1 create book_reader_sync

# 2. Apply the schema.
npm run migrate            # remote; use migrate:local for local dev

# 3. Set the Cloudflare Access application audience and team domain.
#    Put an Access policy in front of the Worker route, then set:
#    ACCESS_AUD           = the Access application AUD tag
#    ACCESS_TEAM_DOMAIN   = <team>.cloudflareaccess.com
#    (as wrangler vars or dashboard environment variables)

# 4. Deploy.
npm run deploy
```

Then point the client at the Worker: construct `createHttpSyncTransport({ baseUrl })`
and a `SyncEngine`, and wire them into the app's services. The client is already
built and tested against this contract; see `src/sync/` in the root project.

## Not yet implemented

- R2 file transfer (Phase 4).
- Snapshot/bootstrap and history compaction (docs/SYNC.md §7) — ordinary pagination first.
- Concrete batch/payload size limits and retention policy (docs/SYNC.md §11) — set from measured behaviour.
