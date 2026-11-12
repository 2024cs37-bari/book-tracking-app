# Data model and compatibility

## Versions and authoritative sources

The executable client schema is `src/data/db.ts`. **Local IndexedDB version 4** includes the
local-only progress-conflict table and deterministic tag lookup keys; **replicated/export schema version 2** describes the shared
entities. The original-file IndexedDB fallback is a separate database at version 2. The server's
D1 change-log migration is `server/migrations/0001_init.sql`.

Never modify a released `version(n).stores(...)` block. New indexes/tables require a new local
version; wire shape changes require an explicit compatibility policy. Optional non-indexed fields
can be added without rebuilding IndexedDB, but validators/exports/old-client behavior still need
review. Current additive fields include book `metadataHlcs` and transfer failure details.

## Entities

| Table               | Key                   | Shared across devices | Meaning                                                           |
| ------------------- | --------------------- | --------------------- | ----------------------------------------------------------------- |
| `books`             | `id`, unique `sha256` | Yes                   | Original identity, metadata, field clocks and lifecycle           |
| `progress`          | `bookId`              | Yes                   | Reading status, optional locator, fraction, clock/device          |
| `annotations`       | `id`                  | Yes                   | Bookmark/highlight/note, locator, excerpt, note, color, tombstone |
| `shelves`           | `id`                  | Yes                   | Named collection and tombstone                                    |
| `shelfBooks`        | `[shelfId+bookId]`    | Yes                   | Add/remove HLC membership                                         |
| `tags`              | `id`                  | Yes                   | Display/normalized label and tombstone                            |
| `bookTags`          | `[tagId+bookId]`      | Yes                   | Add/remove HLC membership                                         |
| `sessions`          | `id`                  | Yes                   | Append-only reading span, time/fractions/device                   |
| `changes`           | `id`                  | Outbox only           | Immutable mutation payload and delivery acknowledgement           |
| `syncMeta`          | `key`                 | No                    | Device/clock/cursor/config/scheduler and identity aliases         |
| `deviceState`       | `bookId`              | No                    | Local presence, pin and last-opened time                          |
| `fileTransfers`     | `direction:sha256`    | No                    | Durable queue, retry/cancellation/error information               |
| `progressConflicts` | `bookId`              | No                    | Pending local/remote position choice                              |

Rows use camelCase. JSON backup schema is versioned separately from the portable ZIP container.
The HTTP envelope uses snake_case fields and opaque canonical entity payloads.

## Books and identity

`sha256` is lowercase hexadecimal SHA-256 over the unchanged original. `sizeBytes` and detected
`format` describe it. Titles/authors/language/publisher/ISBN/pages are editable metadata; a cover
is a derivative, never the original. `metadataIncomplete` explains extraction fallback.

`lifecycle` is indexed as `active`, `archived` or `deleted`. `archivedAt`/`deletedAt` carry history.
Archive is reversible; deletion is a recoverable metadata tombstone. Neither removes local or
remote original bytes. Tombstoned originals stay referenced during reconciliation.

Different devices can assign different opaque IDs to one content hash. Sync chooses the
lexicographically smallest ID, merges metadata and moves progress, annotations, collection
memberships, sessions and local device state in the same transaction. `syncMeta` aliases old IDs.
Existing outbox IDs/payload bytes remain immutable, so retry idempotency is preserved. New writes
resolve aliases. Never deduplicate on filename, title, author or ISBN.

## Clocks and conflict provenance

HLC compares parsed `(wall_ms, counter, device_id)` tuples; raw strings are not lexically ordered.
Every mutation advances a device clock. `updatedHlc` orders a row; `metadataHlcs` retains per-field
provenance across merged snapshots, including explicit clears of optional values. Legacy rows
without field clocks use their original row clock when first merged.

Import/extraction must not erase richer data simply because another snapshot lacks a field.
Independent non-empty edits resolve by field HLC, with deterministic tie-breaking. Lifecycle
history follows its register. Membership is active when the add clock is newer than removal.
Sessions are deduplicated by ID rather than mutable aggregate counters.

Shelves and tags retain their IDs when renamed, so memberships do not need rewriting. Name and
tombstone changes use the row HLC register; concurrent edits of the same collection resolve to the
newer HLC (including the device-ID tie-break). Local tag creation reuses an active normalized name,
and renaming rejects a name owned by another active tag in the same transaction as its outbox
write. Different IDs created or renamed independently offline can retain the same display name
after sync; they are not silently merged or assigned each other's memberships.

Tag lookup keys collapse whitespace and use Unicode default lowercasing (`toLowerCase`), independent
of the device locale. The v4 migration rebuilds this derived key only, preserving IDs, names,
clocks, tombstones, memberships and immutable outbox bytes. Distinct existing tags whose keys now
match remain distinct; no memberships are reassigned. Sync and backup recovery accept the former
default, Turkish/Azeri and Lithuanian lowercase forms and project them to the deterministic key.
Unrelated name/key mismatches remain invalid. The normalized key allows expansion up to 600 UTF-16
code units for a display name of at most 200. Devices with the earlier locale-dependent validator
should all upgrade before syncing language-sensitive names; those old clients cannot reliably
accept keys created under another locale.

Startup recovers clock state from committed entities/outbox and the saved checkpoint. Remote pages
checkpoint clock and cursor transactionally. A renderer/session must resolve the current canonical
book ID before writing progress after identity reconciliation.

## Progress, annotations and reading activity

A new book has a status (`to_read`, `reading`, `finished`, `abandoned`) before a reader position
exists. Missing locator fields mean no position yet; fraction starts at zero.

EPUB uses a CFI. PDF uses zero-based `page:yOffset`; text highlights add `:start:end` offsets into
that page's text. Every locator has a finite normalized fraction for fallback and comparison.
Annotations preserve creation/update clocks and deletion tombstones.

Progress from another device diverging by at least 0.1 fraction is retained as a local pending
choice. The current position is preserved until a decision; a fresh local choice is a new mutation.
See [Sync implementation](SYNC-IMPLEMENTATION.md) for exact rules and edge cases.

Sessions store start instant, duration, optional start/end fractions and device. Statistics are
computed, not synced aggregates. Calendar days/streaks use the viewing device's timezone and split
spans at midnight. Finished counts come from current reading status. Time is an activity estimate;
concurrent reading on devices can contribute overlapping spans.

## Original-file stores

Original key: `books/<sha256>.bin`. Cover key: `covers/<bookId>.<extension>`. OPFS is preferred after
a write/read probe. The native IndexedDB fallback stores `{key, bytes: ArrayBuffer, contentType}`
in `book-reader-files` v2. Its old Blob rows remain readable and migrate lazily; no originals are
discarded during schema upgrade. Memory fallback is explicitly non-durable.

Metadata and bytes cannot share a transaction. Import/restore verifies files before committing
metadata and retains staged bytes on transaction failure. Reconciliation reports missing files
and orphans; it never silently repairs/removes them. File leases coordinate readers, writers and
cache removal across tabs where Web Locks is available.

## Server model

D1 currently stores the authenticated user's **change history**, not a second set of materialized
book/annotation tables. `(user_id, change_id)` is unique; sequence is globally increasing and pull
queries are user-scoped. A duplicate identical event returns its existing outcome; a reused ID with
a different event is rejected. Clients validate/apply entity semantics and conflict rules.

R2 keys are derived from verified user identity and original hash. Objects acquire trusted hash
metadata only after verified upload. Current HEAD/GET behavior and exact size bounds are specified
in [API](API.md); client cache eviction requires trusted remote confirmation.

## Recovery and migration rules

- Preserve entity/outbox atomicity and pull-page/cursor atomicity.
- Validate imported shapes, ranges, identities and relationships before applying them.
- Keep pins, transfer state, conflict prompts, device identity and cursors out of portable replicas.
- Restore adds missing records with new local clocks/events; current matching records survive.
- Reject unsupported newer export schemas and malformed or inconsistent archives visibly.
- Do not compact server history until a complete snapshot/replay protocol can recover old clients.
- Test empty and populated prior schemas; capture an external backup before destructive changes.

See [Backup](BACKUP.md) for container limits, duplicate mapping and recovery previews, and
[Roadmap](ROADMAP.md) for larger-library formats, retention and native-storage migration.
