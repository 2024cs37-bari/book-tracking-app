# ADR 0006: Client sync engine (push/pull/apply)

- **Status:** Accepted
- **Date:** 2026-10-10

## Context

Phase 3 is cross-device sync against a Cloudflare Worker + D1 + R2 + Access backend
(docs/SYNC.md). The local data model has been replication-ready since Phase 1: every replicated
mutation co-commits one immutable outbox row in the same Dexie transaction, ordered by a Hybrid
Logical Clock. The client half of sync — draining the outbox and applying remote changes — is pure
local logic that can be built and verified before any server exists.

Two design questions needed answers before writing the apply path:

1. **Which HLC drives last-writer-wins?** Each mutation currently advances the clock once for the
   entity's `updated_hlc` and the outbox row (`makeChangeRow`) advances it again for the change's
   own `hlc`, so the two differ by one tick (the "latent double-advance" noted since Phase 2).
2. **How are deletes represented on the wire?** The pull envelope in SYNC.md §4 carries no `op`.

## Decision

Build the client engine as three layers under `src/sync/`, all injectable and server-free:

- **`protocol.ts`** — wire types for push/pull plus runtime validators (`isPushResponse`,
  `isPullResponse`), since responses are untrusted network input. `buildPushRequest` turns outbox
  rows into a push body.
- **`apply.ts`** — `applyChange` resolves one remote change by the entity's conflict rule
  (SYNC.md §6): last-writer-wins by HLC for books/progress/annotations/shelves/tags, add/remove-HLC
  merge for memberships (a newer re-add beats an older remove), and id-dedupe for append-only
  sessions. `applyPullPage` applies a whole page and advances the cursor in one transaction, then
  observes the remote HLCs into the clock only after commit.
- **`engine.ts`** — `SyncEngine.sync()` runs a single-flight cycle: push bounded batches and
  acknowledge only confirmed ids, then pull pages and apply each atomically.

**LWW uses the payload entity's `updated_hlc`, not the change's top-level `hlc`.** The outbox
payload is the full entity row, which carries its own `updated_hlc`; that is the value compared
against the local row. The server orders delivery by its assigned sequence, so the change's
top-level `hlc` is not needed for conflict resolution. Consequently the **double-advance is left as
is**: it is benign — the extra tick never participates in LWW, and the clock stays monotonic — and
removing it would mean editing every repository's write path in the sacred outbox core for no
correctness gain.

**Deletes are tombstone upserts.** `applyChange` needs no `op`: an entity's deleted state lives in
its own row (`deleted: true`, a `deleted` lifecycle, or a membership `removed_hlc`), so applying the
payload reproduces the tombstone. Applying remote changes writes only entity tables, never the
outbox, so a remote change never echoes back as a local mutation.

## Consequences

- The engine is fully tested without a server: `tests/sync/` includes a two-device fake-server
  round-trip proving convergence, plus idempotent push, partial-batch acknowledgement, failed-pull
  cursor safety, membership order-independence and no-echo. The real network adapter
  (`http-transport.ts`, `createHttpSyncTransport`) is also in place and tested with a stubbed
  `fetch`: Access-credentialed JSON over HTTPS, response validation, and error classification
  (retryable vs auth-expiry vs cursor-expiry vs permanent, honouring `Retry-After`).
- Not yet built: the Worker/D1/R2/Access **server** the transport points at; file transfer;
  progress-divergence prompting (SYNC.md §6 — baseline is LWW); per-field book-metadata policy;
  snapshot/bootstrap and cursor-expiry handling beyond surfacing the error (SYNC.md §7). The
  thresholds and limits in SYNC.md §11 remain open and must come from measured service behaviour.
- The engine is not wired into the running app yet, because there is no server to point it at;
  construction waits for a configured server URL.
