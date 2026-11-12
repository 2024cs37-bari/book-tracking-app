# Cloudflare backend

## Implemented responsibilities

The optional backend stores a private change history and original book files. It is never required
for reading a local book or recording a local mutation. The independently installed `server/`
package contains the Hono Worker, protocol validation, Access verification, D1 migration and local
workerd integration tests. [API](API.md) is the authoritative endpoint and error contract;
[server setup](../server/README.md) contains executable deployment instructions.

| Component               | Current responsibility                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------- |
| Static frontend hosting | Serve the matching app shell, reader engines and assets                                           |
| Cloudflare Access       | Authenticate the intended owner; Worker independently verifies the assertion                      |
| Worker + Hono           | Exact-origin policy, bounded request validation, idempotent log writes and mediated file transfer |
| D1                      | Per-user idempotent append-only changes with a globally sequenced pull cursor                     |
| Private R2              | Original bytes under verified-user and SHA-256-derived object keys                                |

D1 does not maintain a second normalized copy of every entity. Clients validate entity fields,
resolve conflicts, reconcile duplicate identities and materialize their local libraries from the
log. Covers are local derivatives and portable-backup members, not a separate R2 service.

## Authentication and configuration

Production uses HTTPS and Cloudflare Access. The Worker verifies the assertion signature, issuer,
audience and lifetime before using its email/subject to scope storage. Device IDs are sync metadata,
not authorization. Configure the Access policy for the intended owner and check every alternate
hostname. The supplied configuration disables public workers.dev and preview URLs.

A same-origin frontend with `/api/*` routed to the Worker is recommended. A separate API origin
requires exact `CLIENT_ORIGIN`, compatible Access preflight/cookie settings and matching frontend
CSP. CORS is not authentication. Unauthenticated preflight never reads private data; actual API
requests always require identity. Browser responses are private/no-store.

`DEV_USER` is a local development convenience accepted only on loopback hosts. Do not configure it
in production. Public Vite variables contain configuration only, never credentials. The frontend
`VITE_SYNC_URL` ends in `/api`; production builds reject insecure or malformed origins.

## Current API

All paths below are relative to `/api/v1` and require authentication.

| Method and path                | Behavior                                                          |
| ------------------------------ | ----------------------------------------------------------------- |
| `POST /sync/push`              | Accept bounded schema-v2 changes; return one outcome per mutation |
| `GET /sync/pull?since=&limit=` | Return ordered rows strictly after the exclusive cursor           |
| `POST /files/begin`            | Report whether exact verified hash/size already exists            |
| `PUT /files/:sha256`           | Stream an original through the Worker; R2 checks SHA-256          |
| `POST /files/finish`           | Confirm verified object checksum and exact declared size          |
| `GET /files/:sha256`           | Stream a private original for client-side verification            |
| `HEAD /files/:sha256`          | Confirm trusted remote presence and size before local eviction    |

There are no upload-authorize/download-authorize, signed-URL, status-suffix, server export, snapshot,
multipart or remote deletion endpoints. Client-side JSON and portable exports remain usable without
this backend.

## Sync and retries

Push accepts at most 500 changes, 64 KiB UTF-8 per serialized payload and 8 MiB for the whole body.
The server validates the envelope and supports only wire schema 2. A reused mutation ID with the
same data returns its original sequence; a changed payload under that ID is rejected. Malformed
members have explicit outcomes. Earlier chunks can commit before a later storage failure, so
clients retry immutable IDs instead of generating replacements.

Pull returns at most 500 rows per page, ordered by sequence within the authenticated user's log.
Sequence gaps are normal because other users can occupy intervening values. Clients validate and
apply the page, its cursor, canonical identities and clock checkpoint atomically. There is no
history compaction or cursor expiry yet: retaining the entire history supports rebuilding a new
installation. A future retention feature requires complete snapshots and compatibility rules.
See [Sync](SYNC.md) and [Sync implementation](SYNC-IMPLEMENTATION.md).

## Original integrity and recovery

Transfers are mediated through the authenticated Worker and streamed into/from private R2. The
current whole-file request limit is **100,000,000 bytes**. A failed transfer restarts; there is no
multipart resume. Local import and portable-backup limits are independent.

The upload's expected SHA-256 is passed to R2 for checksum verification. Begin, finish and HEAD
trust only an object with that checksum and exact size. Downloads are independently hashed before
publication in local storage. Legacy objects without a verified checksum remain GET-recoverable,
but are not evidence that the last local copy can be safely removed. Download, verify and re-upload
such an original to establish trusted remote availability.

D1 and R2 are not one transaction. Their retryable workflow tolerates upload/metadata ordering;
metadata deletion does not remove the remote original. Any future object-retention policy must
consider tombstones, offline clients and backups, and report candidates before deleting bytes.

## Operation and release evidence

Run `npm ci --prefix server` and `npm run check:server` from the project root. Tests bundle the
actual Worker and exercise local workerd, D1 and R2, including checksum failures, retry collisions,
CORS and user separation. Generated JOSE keys verify assertion claims locally. The configured
browser sync suite also exercises frontend CSP, browser CORS, reconnect and file transfer against
an isolated local Worker. Neither suite certifies a deployed Access policy or cloud account.

For production, provision separate resources, apply reviewed migrations, set actual bindings and
Access configuration, deploy matching frontend/API versions, and perform denied-login plus
multi-device recovery exercises. Recheck current Cloudflare quotas and prices in the owner's
account. Monitor aggregate request/storage/error rates without logging book titles, annotations,
assertions or request bodies. [Operations](OPERATIONS.md) covers release and incident procedures.
