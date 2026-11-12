# Synchronization contract

## Invariants

1. Local entity + immutable outbox event commit together.
2. Local reads/edits and reading do not wait for network success.
3. A retry reuses the original change ID and payload bytes.
4. A validated pull page, reference reconciliation, clock checkpoint and cursor commit together.
5. Remote application never writes an outgoing echo.
6. File bytes travel separately from metadata and are independently verified.
7. Meaningful progress divergence preserves a choice rather than silently discarding a position.

The detailed current scheduler/transport behavior is in [Sync implementation](SYNC-IMPLEMENTATION.md).
The authoritative HTTP contract and error codes are in [API](API.md). These documents describe
implemented behavior; future snapshot/compaction is not part of the current server.

## Delivery

`POST /api/v1/sync/push` sends a versioned batch containing device ID, immutable event IDs, entity
kind/ID, operation, HLC and canonical payload. The server validates envelopes/bounds and returns
per-event outcomes. Only accepted/identical-duplicate IDs are acknowledged locally. Rejected and
retryable events remain available for repair/retry; malformed acknowledgement sets cannot silently
clear unrelated pending work.

`GET /api/v1/sync/pull?since=<seq>&limit=<n>` returns increasing sequence rows, next cursor and
has-more. A cursor is exclusive. Clients validate schema, ordering, progression and payloads before
applying anything. A bad row fails the page transaction and leaves the prior cursor intact.
The D1 log is scoped by verified Access identity; event IDs cannot be used to read another user.

The engine processes bounded batches/pages in a single-flight cycle. Browser Web Locks coordinate
cycles across tabs; it then yields so the UI remains usable. Fresh clients bootstrap by pulling
from zero with ordinary pagination. The current server retains the full log. An expired-cursor
response triggers one guarded restart from zero; it cannot recover history a future server has
actually discarded without a complete snapshot. Do not enable compaction without that protocol.

## Conflict rules

| Entity             | Resolution                                                                         |
| ------------------ | ---------------------------------------------------------------------------------- |
| Book fields        | Per-field HLC registers, preserving provenance/explicit clears; deterministic ties |
| Book identity      | One SHA-256 identity; canonical ID/alias/reference reconciliation                  |
| Lifecycle          | Archive/delete tombstones with ordered lifecycle clock/timestamps                  |
| Progress           | Ordered updates; substantial cross-device differences retained for user choice     |
| Annotation         | ID identity, ordered edits, deletion tombstone                                     |
| Shelf/tag          | Ordered display fields and tombstones                                              |
| Membership         | Merge add/remove HLC; newer re-add survives older removal                          |
| Session            | Append-only, ID-deduplicated activity fact                                         |
| Pin/presence/queue | Local to each device; never replicated                                             |

The progress threshold is 0.1 of the book. The reader shows pending alternatives; staying here
asserts local intent as a fresh change, while accepting the pulled position avoids an echo.
New local reading dismisses the obsolete prompt. Format locators remain paired with fractions.

## Background work and user controls

When `VITE_SYNC_URL` is configured, the app starts a scheduler. Launch, local outbox/queued-file
changes, foreground and regained connectivity trigger work; bounded polling discovers remote
changes. Retry backoff includes jitter and respects Retry-After. Authentication/permanent failures
pause retry until an explicit user action; ordinary local reading continues.

Settings exposes state, last successful cycle, retry time, errors, pause/resume and manual retry.
Transfer queues preserve failure details and cancellation. Metadata acceptance precedes automatic
upload discovery. Remote-only books do not cause an automatic whole-library download.

Changing server identity must reset delivery bookkeeping so one server's cursor, acknowledgements
or completed uploads cannot imply another server has the same data. Device-specific caches and
local records are retained. See implementation notes for the persisted configuration boundary.

## Files and recovery

Current transfers use authenticated Worker-mediated PUT/GET to private R2 with a finite size cap.
Upload hashing is checked before trusted completion; downloaded SHA-256 is checked before local
presence. Restarting an interrupted whole-file transfer is supported; resumable multipart is future
work. Pins are only granted to durable, verified local files. Cache removal rechecks trusted remote
presence and size and protects readers through file leases.

Backup restoration generates fresh events for newly recovered records. Outbox repair never means
silently deleting pending changes. On auth failure sign in then retry; on invalid state export a
backup and diagnose the rejected payload rather than clearing the queue.

## Required evidence

Tests cover replay, partial acknowledgement, malformed pages, transaction rollback, duplicate-ID
collisions, three-way field convergence, explicit clears, membership re-add, progress choices,
clock recovery, timeout/backoff and checksum rejection. Configured browser integration must also
exercise real local HTTP/CSP/CORS and Worker/D1/R2, while production Access still requires a deployed
smoke test. [Development](DEVELOPMENT.md) records checks actually run.
