# Sync API contract

This document describes the implemented `v1` Worker API. `server/src/protocol.ts`
is the server envelope definition; `src/sync/protocol.ts` is the independently
built client copy. Keep both compatible when changing the contract. The API
stores a private, ordered change log and content-addressed original files.
Conflict resolution and validation of individual book/progress fields belong to
the client.

## Address, identity, and browser access

The frontend's `VITE_SYNC_URL` includes `/api`, for example
`https://reader.example.test/api`. Transports append `/v1/...`. An empty value
keeps the application local. This is public build configuration and must contain
no credentials, query string, or fragment. Production builds require HTTPS;
Vite development and explicitly selected test builds (`--mode test`) also
permit HTTP loopback endpoints.

Every route below requires a verified Cloudflare Access identity. The Worker
checks the RS256 signature, issuer, audience, issued-at claim, and expiry of
`Cf-Access-Jwt-Assertion`, falling back to the `CF_Authorization` cookie. The
verified email (or subject when no email is present) scopes all D1 and R2 access.
Device IDs never authorize a user. Configure the Access policy to allow only the
intended owner. Missing or invalid authentication returns `401` with
`{"code":"unauthenticated"}`.

Same-origin hosting is recommended: serve the frontend at your chosen host and
route `/api/*` on that host to the Worker. A separate API origin requires
`CLIENT_ORIGIN` to equal the exact frontend origin, without a trailing slash.
Cross-origin requests include cookies; browser cookie policy and Cloudflare
Access preflight configuration must also permit this arrangement. An unlisted
browser origin is rejected with `403 origin_forbidden`, including mutations.
When `CLIENT_ORIGIN` is unset, only same-origin browser requests are allowed.
Requests without an Origin header still require authentication. OPTIONS
preflight is handled without application authentication and never reads data.

All API responses carry `Cache-Control: private, no-store` and
`X-Content-Type-Options: nosniff`. CORS permits GET, HEAD, POST, PUT, and OPTIONS;
`Content-Length` and `Retry-After` are exposed to permitted origins.

## Metadata push

`POST /api/v1/sync/push`, `Content-Type: application/json`:

```json
{
  "device_id": "device-uuid",
  "schema_version": 2,
  "changes": [
    {
      "id": "change-uuid",
      "entity": "book",
      "entity_id": "book-uuid",
      "op": "upsert",
      "hlc": "1794000000000:0:device-uuid",
      "payload": { "id": "book-uuid", "title": "Example" }
    }
  ]
}
```

The payload above illustrates the transport envelope, not a complete canonical
book row. Replicate canonical entity rows produced by the client repositories;
partial invented rows are not a supported application update mechanism.

| Field or bound   | Contract                                                                              |
| ---------------- | ------------------------------------------------------------------------------------- |
| `device_id`      | Nonempty string, at most 128 characters                                               |
| `schema_version` | Exactly `2`; other positive integers return `409 schema_mismatch`                     |
| `changes`        | Array, maximum 500 entries; empty is valid                                            |
| Entire request   | Maximum 8 MiB of UTF-8 body bytes, enforced during reading                            |
| `id`             | Nonempty string, maximum 128 characters; unique per user mutation                     |
| `entity`         | `book`, `progress`, `annotation`, `shelf`, `shelf_book`, `tag`, `book_tag`, `session` |
| `entity_id`      | Nonempty string, maximum 512 characters                                               |
| `op`             | `upsert` or `delete`                                                                  |
| `hlc`            | `nonnegativeSafeInteger:nonnegativeSafeInteger:device`, maximum 512 characters        |
| `payload`        | JSON object, maximum 64 KiB when serialized as UTF-8                                  |

A valid batch returns HTTP 200 and one positional outcome per submitted change:

```json
{
  "outcomes": [{ "id": "change-uuid", "status": "accepted", "seq": 42 }]
}
```

`accepted` means persisted. Retrying the same ID with the same entity, operation,
clock, serialized payload, and device returns `duplicate` and its existing
sequence. Reusing an ID with different data returns
`rejected` / `id_conflict`; it never overwrites the first row. Structurally invalid
members return `rejected` / `invalid_change` without discarding valid members.
A member without a usable ID receives `id: ""`. Repeated IDs within one batch
have separate positional outcomes.

A failure can occur after earlier chunks have committed. Retry the original
immutable change IDs; never generate new IDs merely because the response was
lost. D1 batches keep each insert and conflict check in one transaction, and
idempotency makes partial retries safe. Clients should surface rejected changes
instead of retrying them indefinitely. The wire type reserves `retryable` for
future per-change transient failures; current storage failures use HTTP 503.

Storage groups changes into JSON chunks of at most 1.5 MB, using two statements
per chunk (insert and authoritative lookup). This keeps a full 500-change request
within D1 query and binding limits while preserving the caller's outcome order.

## Metadata pull

`GET /api/v1/sync/pull?since=0&limit=200`:

```json
{
  "changes": [
    {
      "seq": 42,
      "change_id": "change-uuid",
      "entity": "book",
      "entity_id": "book-uuid",
      "hlc": "1794000000000:0:device-uuid",
      "payload": { "id": "book-uuid", "title": "Example" }
    }
  ],
  "next_cursor": 42,
  "has_more": false,
  "schema_version": 2
}
```

`since` is an unsigned safe integer and defaults to 0. `limit` is a positive safe
integer, defaults to 200, and is capped at 500. Malformed values return
`400 bad_cursor` or `400 bad_limit`.

Sequences increase globally and may contain gaps between a user's rows. Pull
returns only the authenticated user's changes, ordered by sequence and strictly
after `since`. An empty page preserves the supplied cursor. Continue while
`has_more` is true. Apply each page and save its cursor atomically. Delete
semantics are represented in canonical payload tombstones; pull does not add an
`op` field. There is currently no history compaction, expired-cursor response, or
snapshot endpoint.

## Original files

Files use lowercase SHA-256 hex (64 characters) and positive integer byte sizes.
The mediated upload maximum is **100,000,000 bytes**, matching the default
Cloudflare request limit. The endpoint streams bytes and does not buffer an
entire original in Worker JavaScript memory.

1. `POST /api/v1/files/begin` with `{"sha256":"<hash>","size":123}` returns
   `{"already_available":false}`. It returns true only when the current user's
   existing R2 object has that verified checksum and exact size.
2. If missing, `PUT /api/v1/files/<hash>` with the original bytes. Content-Length
   is required; browser `fetch` with a Blob provides it automatically. Use
   `application/octet-stream`. R2 verifies SHA-256 before publishing the object.
   Success returns `{"ok":true}`. Repeating correct bytes is safe.
3. `POST /api/v1/files/finish` with the same hash and required size checks the
   stored checksum and size, returning `{"ok":true}` only when both match.
4. `GET /api/v1/files/<hash>` returns an octet-stream attachment. The client must
   independently verify SHA-256 before saving or marking local availability.
5. `HEAD /api/v1/files/<hash>` returns 200 and Content-Length only for an object
   with the verified matching checksum. It returns 404 for absent or legacy
   unverified objects. Use it before deleting a local copy in favor of remote
   storage, and compare the exact expected byte size.

R2 is private. Keys are `files/<verified-user>/<sha256>`; callers never choose the
user component or receive a public R2 URL. There is no signed-URL or multipart
protocol, remote file deletion endpoint, or public bucket.

Earlier builds could store objects without checksum verification. Those remain
available through GET for recovery, but begin/HEAD/finish never treat them as a
verified remote original. Download, verify locally, then re-upload them to
establish the checksum before local eviction.

## Error handling

Errors use JSON `{"code":"machine_readable_code"}`; HEAD responses have no body.

| Status | Representative code                                                                                                                                               | Caller response                                              |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 400    | `bad_json`, `not_object`, `bad_device`, `bad_schema`, `bad_changes`, `too_many`, `bad_cursor`, `bad_limit`, `bad_hash`, `bad_size`, `bad_content_length`, `empty` | Correct the request; do not repeat unchanged                 |
| 401    | `unauthenticated`                                                                                                                                                 | Complete Access sign-in, then retry                          |
| 403    | `origin_forbidden`                                                                                                                                                | Correct frontend/Worker origin configuration                 |
| 404    | `not_found`                                                                                                                                                       | Original unavailable; retain local copy                      |
| 409    | `schema_mismatch`                                                                                                                                                 | Update compatible client/server before retrying              |
| 409    | `object_missing`, `size_mismatch`, `hash_unverified`                                                                                                              | Verify and re-upload original; do not announce completion    |
| 411    | `length_required`                                                                                                                                                 | Supply a fixed-length original body                          |
| 413    | `too_large`                                                                                                                                                       | Reduce push batch or keep oversized original local           |
| 415    | `unsupported_media_type`                                                                                                                                          | Send JSON with application/json                              |
| 422    | `hash_mismatch`                                                                                                                                                   | Correct the bytes/hash; stored valid bytes were not replaced |
| 503    | `temporarily_unavailable`                                                                                                                                         | Retry with bounded backoff; Retry-After is 5 seconds         |
| 503    | `server_misconfigured`                                                                                                                                            | Correct the deployment origin configuration                  |

A Cloudflare edge rejection can return its own response format or limits before
the Worker runs. A non-JSON response must not be interpreted as success.

## Reproducible verification

From `server/`, run `npm ci`, `npm run typecheck`, then `npm test`. Tests bundle
the actual Worker and run it in local workerd with D1 and R2. They exercise
persistence, full 500-change batches, retries/collisions, pagination, malformed requests, CORS, file
checksums, legacy recovery, and user isolation. JOSE tests verify signatures and
claims using local generated keys; they do not contact Cloudflare Access.

For a manual local smoke check, follow [server setup](../server/README.md), then:

```sh
curl --fail-with-body http://127.0.0.1:8787/api/v1/sync/pull
curl --fail-with-body http://127.0.0.1:8787/api/v1/sync/push \
  -H 'Content-Type: application/json' \
  --data '{"device_id":"smoke","schema_version":2,"changes":[]}'
```

No production deployment, real account authentication, storage billing limit,
or cross-site browser cookie behavior is established by the local suite. Verify
those against the intended deployment before enabling unattended sync there.
