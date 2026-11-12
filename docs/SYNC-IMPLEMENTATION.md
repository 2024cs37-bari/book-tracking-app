# Synchronization implementation and maintenance

This document describes the implemented client behavior as of November 7, 2026. For the API contract and deployment requirements see [API.md](API.md), [BACKEND.md](BACKEND.md) and [SYNC.md](SYNC.md). Configuration is a build decision: an empty `VITE_SYNC_URL` keeps the application fully local with a durable pending outbox.

## Integration surface

`createAppServices()` assembles these services; application boot starts the background coordinator after opening local storage. Rendering and reading do not await network work.

| Service/API                                      | Behavior                                                                                                                                                  |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `background.start()` / `stop()`                  | Attach/remove local-change, online and foreground triggers and timers. Stop does not discard pending work.                                                |
| `background.getStatus()` / `subscribe(listener)` | Current immutable status; subscribers receive an initial snapshot and subsequent changes. Subscription returns a disposer.                                |
| `background.requestSync()`                       | Debounced automatic wakeup; respects pause, authentication/permanent errors and retry deadlines.                                                          |
| `background.retryNow()`                          | Explicit retry, clears pause/block and requeues failed transfers. Resolves when the joined cycle settles; errors are reflected in status.                 |
| `background.pause()` / `resume()`                | Persist automatic-sync preference. An already running request may finish; the coordinator does not start another cycle while paused.                      |
| `fileTransfer.cancel(id)`                        | Abort an active transfer on this instance and persist cancellation. Cancellation cannot undo bytes the server already accepted.                           |
| `fileTransfers.ensureUpload(hash)`               | Automatic discovery; never revives failed, cancelled or completed jobs.                                                                                   |
| `fileTransfers.enqueueDownload(hash)`            | Explicit download; can requeue a completed download after local eviction.                                                                                 |
| `fileTransfer.hasRemoteCopy(hash, size)`         | Authenticated HEAD to the configured server; only verified remote content with matching size is confirmed.                                                |
| `subscribeLibraryChanges(listener)`              | Local database mutation notifications, including other tabs and remotely applied state; UI resources refetch without importing Dexie. Returns a disposer. |

Status states are `idle`, `running`, `offline`, `waiting`, `paused`, `auth-required` and `error`. `nextAttemptAt` is a wall-clock deadline. `lastSuccessAt` is persisted in `syncMeta/background_last_success`; it records a completed metadata cycle, **not proof every original was uploaded**. File jobs retain their own state, errors, retryability, attempt count and backoff. Settings displays both. `background_paused` persists the explicit pause preference. Authentication and permanent protocol failures require an explicit retry in the current instance.

## Scheduling and retry bounds

The coordinator runs on launch, foreground, reconnect, local outbox changes and newly queued downloads. It polls every 60 seconds while the application remains open to discover remote-only writes. Local triggers debounce for 750 ms. Browsers may throttle background tabs; this is not a service-worker background-sync guarantee after the application is closed.

A metadata cycle pushes at most ten batches of 100 changes and pulls at most twenty pages of 200 changes. Remaining work schedules another cycle. The engine joins concurrent calls. The coordinator serializes metadata work for the same local database using Web Locks when available. File transfers use a separate database-scoped Web Lock, at most two concurrent jobs and twenty jobs per pass.

Network and timeout errors, 429 and 5xx use exponential backoff with jitter (about 1 second initially, capped around 5 minutes). `Retry-After` accepts both delta seconds and HTTP dates and takes precedence when longer. Local edits cannot bypass an active retry deadline. JSON metadata requests time out after 30 seconds and file requests after 120 seconds. Manual retry intentionally overrides failure backoff.

401/403 pause for sign-in. Schema mismatch, malformed JSON/envelopes, invalid entity data, mismatched push acknowledgements and rejected change outcomes are permanent failures surfaced for investigation. Neither outbox rows nor local books are deleted to make a failure disappear. A transient partial push acknowledges accepted IDs and retains all others; the pull still runs before surfacing the partial failure.

## Durable state and merge rules

Every local replicated mutation writes its entity and immutable outbox row in one IndexedDB transaction. Acknowledgements must contain exactly the requested IDs with no duplicates or unrelated IDs. Accepted and duplicate outcomes retire only those changes. Pull pages must move the cursor forward when `has_more` is true, keep sequences strictly increasing and match wire schema version 2. A malformed page rolls back entity writes and cursor advancement together.

Remote rows are validated before application. Remote application never creates an outbox echo. Each page atomically stores entities, alias changes, the pull cursor and a clock checkpoint. Startup recovers logical time from all committed entity/outbox HLCs as well as the saved checkpoint, so a crash before `pagehide` cannot reuse an older clock value. HLC counter exhaustion advances the logical wall component instead of producing an invalid timestamp.

Local outbox creation, incoming sync and backup recovery use the same typed row projection in
`src/data/replicated-validation.ts`. It checks safe identifiers, bounded text, lifecycle timestamps,
date/session limits, normalized tag names, locator structure and HLC bounds. Unknown extra row
fields are dropped; absent optional metadata field clocks remain supported. HLCs more than 24 hours
ahead of this device are refused, field clocks cannot exceed the row update, and no payload clock
can exceed its wire event clock. Invalid rows stop the entire page with `invalid_payload`; they
are never skipped to advance a cursor. Child records may arrive before parent records, so full
relationship validation belongs to complete backup snapshots. The completed graph remains
exportable under the same row rules. Same-content size/format disagreements and UUID/hash
disagreements stop with `identity_conflict` before canonical references are changed. Investigate
the originating client or data; do not delete local rows or advance the cursor to hide the error.

Book metadata uses optional `metadataHlcs` field registers. A merge retains each value's own timestamp rather than attributing every retained value to the latest whole-row timestamp; therefore three-way and out-of-order snapshot merges converge. Legacy rows acquire field clocks from their original row HLC, and missing legacy optional fields do not erase known metadata. Explicit current-client field clears retain a clock even though the optional value is absent. Lifecycle and its archive/delete timestamps move as one register. Earliest import time is retained and extraction completeness is monotonic.

Independent imports of identical SHA-256 content can create different UUIDs. When such rows meet, the lexicographically smaller UUID becomes canonical. A single transaction moves progress, progress conflicts, annotations, shelves, tags, sessions and local file/pin state. Aliases live in `syncMeta` as `book_alias:<old-id>`. Existing outbox payloads and change IDs stay immutable, which preserves server idempotency; incoming old-ID references resolve through aliases. Book lookup and progress writes resolve aliases so an open reader can save after reconciliation. The UI redirects old book routes to the canonical ID.

Reading positions within the divergence threshold follow HLC order. Different-device positions at least 10 percentage points apart preserve a local position and a remote candidate for user choice. An older replay cannot replace a newer unresolved candidate. “Stay here” reasserts local state even before the first locator exists; “Go to” accepts the selected remote position. Memberships merge latest add/remove timestamps. Annotations, shelves and tags use HLC registers; sessions remain append-only.

Renaming a shelf or tag updates its existing ID and row HLC, preserving memberships on all devices.
Concurrent renames of that same ID follow HLC order. A local tag rename rejects an occupied
normalized name, but names are not distributed unique keys: separate IDs independently created or
renamed offline may have the same name after convergence. Both retain their own memberships and
can be renamed explicitly; sync does not silently merge them.

## Original-file lifecycle

After metadata has been acknowledged, the coordinator discovers locally present nondeleted originals and queues idempotent uploads. It never downloads the entire remote library: download jobs originate from an explicit user request or the offline-storage pinning flow. Failed jobs preserve error details. Auth/permanent failures do not spin; transient failures retain their retry deadline across restart. Jobs left running after a crash restart under the queue lock. An explicit request can revive cancelled work.

Every downloaded original is SHA-256 verified before storage, including an existing local file when a download is explicitly requested. A corrupt local copy can be repaired from verified downloaded content. Shared file leases protect originals used by upload/download or reading from cache eviction. Completion only records presence after verification/storage. Single-request uploads are limited to 100,000,000 bytes to match the current Worker deployment limit; larger originals remain usable locally with a visible permanent transfer error.

A configured server URL identifies the pull cursor and upload confirmations. When it changes, retained outbox entries are made pending, upload confirmations are discarded and the pull cursor resets. The application does not assume a completed upload on one server makes cache eviction safe on another: eviction performs a fresh HEAD verification. Old-server originals that are absent locally must be restored/imported or downloaded from the old server before a new target can receive them.

## Verification and scope

Run focused deterministic tests with:

```sh
npx vitest run tests/sync tests/transfer tests/domain/hlc.test.ts
```

These exercise fake-time scheduling against actual IndexedDB state, partial acknowledgements, atomic malformed-page failure, associative metadata merges, explicit clears, three independently initialized databases, full reference migration, clock crash recovery, retry deadlines, pause persistence, cancellation and corrupted download repair.

`tests/sync/validation.test.ts` additionally verifies hostile-but-previously-accepted payloads,
atomic rollback of invalid local input, preserved original identity, legacy optional fields,
unknown-field projection and all eight current repository row types arriving out of order before
a successful metadata export.

`tests/sync/http-integration.test.ts` starts a real local HTTP server using contract-derived responses. It runs the real fetch transport and synchronization engine, verifies a 429 leaves local work intact and retries identical IDs, bounds a hung request, rejects a 200 HTML sign-in page, and checks HEAD size handling. These tests establish client behavior against the controlled HTTP boundary; they do not establish Cloudflare Access configuration or deployed service availability. The Postman API simulation skill guided the boundary/failure verification approach; no Postman-hosted simulation or production account is required.

The dedicated configured browser suite is:

```sh
npm --prefix server ci
npm run test:sync-browser
```

`playwright.sync.config.ts` builds an isolated test-mode bundle into ignored `.sync-test-dist`, previews it on loopback port 4193, and runs the real Worker under Miniflare with ephemeral D1/R2 on port 8793. `server/browser-test-server.mjs` reads no `.dev.vars`, Wrangler configuration, production credentials or persistent account data. All writes use a loopback-only test identity. The suite passed in Chromium against the actual local Worker on November 7, 2026. Three isolated browser contexts exercised offline independent imports, automatic reconnect, canonical identity and collection/tag convergence, verified R2 upload, metadata-only startup followed by requested original download, bookmark replication, and a genuine reading-position conflict with explicit resolution. No browser page errors were observed. This exposed an initial-reader-relocation bug that cleared conflicts before display; reader startup now suspends position persistence while an explicit choice is pending. The suite exercises cross-origin browser CSP/CORS and real metadata/file endpoints. Loopback HTTP is permitted for explicit test builds; normal production builds still require HTTPS.

Before deploying, validate configured HTTPS frontend/API origins, Cloudflare Access session behavior, D1 migrations, R2 binding and quotas, certificate handling, and backups against the real account. Multipart/resumable transfer beyond one request and operating-system background transfer after app closure are future work, not implied by the durable queue fields.
