# Synchronization protocol

## 1. Goals and invariants

Sync transfers durable user intent between a user's devices. It is asynchronous, resumable, idempotent, and subordinate to local availability.

Invariants:

1. Local mutation plus local outbox entry commit atomically.
2. The UI does not wait for the network to read or mutate local data.
3. A push retry cannot duplicate a mutation.
4. A pull cursor advances only after every change in the page has been applied transactionally.
5. Applying remote changes does not re-enqueue them as local changes.
6. File transfers are separate from metadata sync and independently resumable.
7. Conflicts are deterministic and user-visible when automatic resolution could discard meaningful progress.

## 2. Device identity and HLC

Each installation receives a random stable `device_id`. It is not an account credential. Reinstalling may create a new ID; device state is not trusted for authorization.

Maintain a Hybrid Logical Clock tuple `(wall_ms, counter, device_id)`. On local events, advance it using local time and prior clock state. On receiving a remote HLC, merge according to the standard HLC update rule, then advance before creating subsequent local mutations. Compare tuples lexicographically, including device ID as a deterministic final tie-break. Validate clock fields and bound pathological future timestamps to prevent one corrupted clock from dominating indefinitely; retain diagnostic information when clamping is needed.

## 3. Local mutation transaction

For every replicated mutation:

1. Validate input and allocate entity/change IDs.
2. Advance local HLC.
3. Update the entity row.
4. Insert one immutable outbox row with canonical payload, HLC, device ID, and idempotency ID.
5. Commit both together.

If any step fails, neither entity update nor outbox event is visible. Local-only pin and cache state do not generate replicated changes.

The change ID is unique and reused for every retry. Once acknowledged, a change is marked pushed (or removed only after a defined retention policy); an ambiguous network timeout must not mint a replacement ID.

## 4. API envelope

All requests require Cloudflare Access identity. Payloads are schema-validated and size-limited. Example shapes are illustrative; generated TypeScript types and runtime validators should be introduced together.

### Push

`POST /api/v1/sync/push`

```json
{
  "device_id": "uuid",
  "schema_version": 1,
  "changes": [
    {
      "id": "uuid",
      "entity": "progress",
      "entity_id": "book-uuid",
      "op": "upsert",
      "hlc": "<wall_ms>:<counter>:<device_id>",
      "payload": { "book_id": "book-uuid", "fraction": 0.42 }
    }
  ]
}
```

Response includes per-change outcome (`accepted`, `duplicate`, `retryable`, `rejected`), stable server sequence when accepted, and machine-readable error codes. A batch may partially succeed; the client marks only accepted/duplicate IDs acknowledged. Permanent rejection is surfaced and retained for user repair rather than dropped.

### Pull

`GET /api/v1/sync/pull?since=<seq>&limit=<n>`

```json
{
  "changes": [
    {
      "seq": 123,
      "change_id": "uuid",
      "entity": "progress",
      "entity_id": "book-uuid",
      "hlc": "...",
      "payload": {}
    }
  ],
  "next_cursor": 123,
  "has_more": false,
  "schema_version": 1
}
```

`since` is an exclusive sequence cursor. The server returns changes in strictly increasing sequence order. The client applies the page and stores `next_cursor` in one local transaction. If application fails, it retries the same page.

The limit and maximum response bytes are server-configured; the client follows `has_more` until caught up, yielding to foreground work between pages.

## 5. Push/pull ordering

A sync cycle:

1. Acquire a local single-flight lock.
2. Push a bounded batch of unacknowledged outbox entries.
3. Mark only confirmed accepted/duplicate entries as acknowledged.
4. Pull bounded pages from the last committed cursor.
5. Apply each page atomically; ignore already-seen `change_id` values defensively.
6. Persist cursor with applied entities.
7. Schedule independent file transfers.

A client may push and pull in another order only if tests preserve all invariants. Change ordering is by server sequence for delivery; entity resolution uses HLC rules, not arrival order.

## 6. Conflict rules

| Entity         | Rule                                                                                                                                                     |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Book metadata  | Per-field policy must preserve non-empty extracted/user-edited values; lifecycle fields use HLC and explicit archive/tombstone semantics.                |
| Progress       | LWW by HLC for ordinary updates. If two device positions diverge by a configured fraction threshold, retain both candidates and prompt before resolving. |
| Annotation     | Create by ID; edits LWW per annotation by HLC; deletion is a tombstone.                                                                                  |
| Shelf/tag name | LWW by HLC; conflicting names may be presented in history if useful.                                                                                     |
| Membership     | Add/remove events are ordered by HLC; a newer re-add wins over an older removal.                                                                         |
| Session        | Append-only, deduplicated by session ID.                                                                                                                 |
| Device state   | Never synchronized.                                                                                                                                      |

For progress divergence, do not overwrite the local position with the remote candidate before recording the pending choice. The prompt should show device, last-updated time, and approximate reading position. A policy for dismissing/merging pending candidates must be explicit.

## 7. Bootstrap and pagination

A fresh device pulls from cursor zero. It paginates until caught up; it must not assume a single response contains the library. For very large libraries, a future snapshot/bootstrap endpoint may be added, but must include a consistent snapshot cursor and replay changes after that cursor. Do not add a snapshot path until ordinary pagination is measured.

Server sequence allocation and event append must be transactionally ordered. If events can be compacted, server must retain a minimum supported cursor and return a specific `cursor_expired` response requiring snapshot/rebootstrap. Never silently return a partial history while claiming success.

## 8. Retry, limits, and errors

- Retry transient network errors, rate limits, and server errors with exponential backoff and jitter.
- Respect `Retry-After` when supplied.
- Use bounded batch size, request bytes, response bytes, and concurrency.
- Permanent validation/auth/schema errors are not retried indefinitely; expose them and preserve local data.
- Authentication expiry pauses network work and prompts for reauthentication without losing queues.
- Background sync is opportunistic only; trigger on launch, foreground, regained connectivity, explicit refresh, and debounced reading progress.
- Progress debounce is approximately 30 seconds while reading and on book close; local persistence happens more frequently enough to avoid loss on crash.

## 9. File transfer relationship

Metadata sync can announce file hash, size, and availability separately. Upload obtains short-lived authorization, transfers directly to private R2, verifies object size/checksum, and confirms completion. Download verifies SHA-256 before marking local presence. Transfer queues and multipart state persist locally and do not block metadata sync. See [Storage](STORAGE.md) and [Backend](BACKEND.md).

## 10. Test invariants

Required tests include:

- Same push repeated produces one server mutation and one log event.
- Partial batch success only acknowledges confirmed IDs.
- Crash between entity application and cursor write cannot occur because both are transactional.
- Replaying a pull page is safe.
- Remote application does not generate an outgoing echo.
- Out-of-order HLC operations converge deterministically.
- Membership re-add after remove is active.
- Progress divergence preserves both candidates until user choice.
- A failed pull page does not advance the cursor.
- Expired cursor requires explicit bootstrap and never claims data completeness.
- Local-only pin state never overwrites another device's pin state.

## 11. Decisions still required before production sync

Choose concrete request/response validators, maximum payload and batch sizes, HLC future-drift bounds, retention/compaction policy, stale-client compatibility window, and exact progress divergence threshold. These values should be based on testing and deployed service limits, not invented as permanent constants in this baseline.
