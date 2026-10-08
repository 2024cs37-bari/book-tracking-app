# Data model

## 1. Model boundaries

The client database is a local replica and operational cache. Replicated entities synchronize; device-specific availability and queue bookkeeping remain local. The server keeps authoritative accepted rows plus a sequenced change log so clients can recover after local data loss.

Use opaque UUIDs for entity IDs. Store UTC instants as integer milliseconds unless a specific duration is stated. Use HLC strings for replicated ordering, not client wall-clock timestamps alone. Validate all enumerations at repository and API boundaries.

The schema below is a logical baseline, not a migration file. Implementation must add indexes, constraints, and explicit migration versions appropriate to Dexie and D1.

## 2. Entity responsibilities

| Entity            | Replicated?  | Purpose                                                  |
| ----------------- | ------------ | -------------------------------------------------------- |
| `book`            | Yes          | Metadata and lifecycle state for one content hash.       |
| `progress`        | Yes          | Current position and reading status for a book.          |
| `annotation`      | Yes          | Highlight, note, or bookmark with locator and tombstone. |
| `shelf`           | Yes          | Named user collection.                                   |
| `shelf_book`      | Yes          | Shelf membership with add/remove ordering.               |
| `tag`             | Yes          | Reusable label.                                          |
| `book_tag`        | Yes          | Tag membership with add/remove ordering.                 |
| `reading_session` | Yes          | Append-only reading activity facts.                      |
| `device_state`    | No           | Per-device pin, local file presence, and recency.        |
| `changes`         | Local outbox | Mutations waiting for server acknowledgement.            |
| `sync_meta`       | Local        | Device ID, pull cursor, HLC state, schema state.         |
| `file_transfer`   | Local        | Durable upload/download/multipart queue state.           |
| Server change log | Server only  | Monotonic sequence for pull pagination and replay.       |

Folders are intentionally absent until separately designed. Archive and deletion are book lifecycle fields; remote original-file deletion is tracked as a separate explicit operation.

## 3. Logical schema

```sql
CREATE TABLE book (
  id                 TEXT PRIMARY KEY,
  sha256             TEXT NOT NULL UNIQUE,
  title              TEXT NOT NULL,
  author             TEXT,
  language           TEXT,
  format             TEXT NOT NULL,
  size_bytes         INTEGER NOT NULL,
  cover_key          TEXT,
  isbn               TEXT,
  publisher          TEXT,
  metadata_incomplete INTEGER NOT NULL DEFAULT 0,
  added_at           INTEGER NOT NULL,
  updated_hlc        TEXT NOT NULL,
  archived_at        INTEGER,
  deleted_at         INTEGER
);

CREATE TABLE progress (
  book_id       TEXT PRIMARY KEY REFERENCES book(id),
  locator_kind  TEXT NOT NULL,
  locator_value TEXT NOT NULL,
  fraction      REAL NOT NULL,
  status        TEXT NOT NULL,
  updated_hlc   TEXT NOT NULL,
  device_id     TEXT NOT NULL
);

CREATE TABLE annotation (
  id            TEXT PRIMARY KEY,
  book_id       TEXT NOT NULL REFERENCES book(id),
  kind          TEXT NOT NULL,
  locator_kind  TEXT NOT NULL,
  locator_value TEXT NOT NULL,
  text_excerpt  TEXT,
  note          TEXT,
  color         TEXT,
  created_hlc   TEXT NOT NULL,
  updated_hlc   TEXT NOT NULL,
  deleted       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE shelf (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  updated_hlc TEXT NOT NULL,
  deleted     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE shelf_book (
  shelf_id   TEXT NOT NULL REFERENCES shelf(id),
  book_id    TEXT NOT NULL REFERENCES book(id),
  added_hlc  TEXT NOT NULL,
  removed_hlc TEXT,
  PRIMARY KEY (shelf_id, book_id)
);

CREATE TABLE tag (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  updated_hlc TEXT NOT NULL,
  deleted     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE book_tag (
  tag_id     TEXT NOT NULL REFERENCES tag(id),
  book_id    TEXT NOT NULL REFERENCES book(id),
  added_hlc  TEXT NOT NULL,
  removed_hlc TEXT,
  PRIMARY KEY (tag_id, book_id)
);

CREATE TABLE reading_session (
  id            TEXT PRIMARY KEY,
  book_id       TEXT NOT NULL,
  started_at    INTEGER NOT NULL,
  duration_s    INTEGER NOT NULL,
  start_fraction REAL,
  end_fraction   REAL,
  device_id     TEXT NOT NULL
);

-- Local only
CREATE TABLE device_state (
  book_id        TEXT PRIMARY KEY,
  file_present   INTEGER NOT NULL DEFAULT 0,
  pinned_offline INTEGER NOT NULL DEFAULT 0,
  last_opened_at INTEGER
);

CREATE TABLE changes (
  id        TEXT PRIMARY KEY,
  entity    TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  op        TEXT NOT NULL,
  payload   TEXT NOT NULL,
  hlc       TEXT NOT NULL,
  device_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  pushed_at INTEGER
);

CREATE TABLE sync_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE file_transfer (
  id          TEXT PRIMARY KEY,
  sha256      TEXT NOT NULL,
  direction   TEXT NOT NULL,
  state       TEXT NOT NULL,
  bytes_done  INTEGER NOT NULL DEFAULT 0,
  upload_id   TEXT,
  part_state  TEXT,
  retry_after INTEGER,
  updated_at  INTEGER NOT NULL
);
```

The server's change-log shape is independent of client `changes`:

```sql
CREATE TABLE server_change (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  change_id TEXT NOT NULL UNIQUE,
  device_id TEXT NOT NULL,
  entity    TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  payload   TEXT NOT NULL,
  hlc       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
```

## 4. Local implementation notes (Dexie)

The SQL above is the logical schema. The client implements it with Dexie over IndexedDB, which
constrains a few details. These are deliberate and must be preserved by migrations:

- Row fields use camelCase (`sizeBytes`, `updatedHlc`, `pushedAt`); the logical names remain the
  contract for exports and sync payloads.
- Booleans are stored as real booleans (`metadataIncomplete`, `filePresent`, `pinnedOffline`).
  IndexedDB cannot index booleans, so no indexed field is a boolean.
- IndexedDB cannot index `null` or `undefined`, so indexed fields never use them as meaningful
  values. Two consequences:
  - `book.lifecycle` is an indexed string (`active` | `archived` | `deleted`) that mirrors
    `archivedAt`/`deletedAt`. Library queries filter on it; the timestamps carry the history.
  - `changes.pushedAt` uses `0` as the "not yet acknowledged" sentinel and a millisecond timestamp
    once pushed, so the outbox can be queried by index.
- `progress` stores the locator as flat optional columns (`locatorKind`, `locatorValue`) plus a
  `fraction` column, and all three are absent until the reader reports a position. A book therefore
  has a reading status from the moment it is imported, without inventing a placeholder position.
- Table names: `books`, `progress`, `changes`, `syncMeta`, `deviceState`, `fileTransfers`.
- A separate native IndexedDB file fallback uses `book-reader-files` version 1 with object store
  `files` keyed by `key`, containing `{ key, blob }`. It is local binary storage, not a replicated
  Dexie entity or a change to released metadata schema v1 (ADR 0004).
- Reader milestone uses these existing fields without a schema change (v1 remains released and
  unchanged). EPUB locator values are CFI; PDF values are zero-based `page:yOffset`, where offset
  is rounded scale-1 PDF viewport points after rotation. Both save normalized fraction. Reader
  settings live in localStorage as device defaults and are not replicated mutations.
- Timestamps are milliseconds since the Unix epoch. HLC strings are ordered as text only after
  parsing into components; never compare them lexically as raw strings across differing wall-clock
  digit counts.

## 5. Constraints and indexing

- `sha256` is lowercase hexadecimal SHA-256; validate exact length and format.
- `size_bytes >= 0`; `fraction` is finite and clamped/validated to `[0, 1]` at the boundary.
- `format`, `status`, `kind`, `locator_kind`, `direction`, and `state` are enumerated values.
- Unique content hash means one library record per byte-identical original. Re-import resolves to that record.
- Index books by title, author, status joins, format, and lifecycle fields; index change log by sequence; index sessions by start time and book.
- Foreign-key behavior must not cascade into silent remote file deletion. Tombstone/archive handling is explicit.
- `removed_hlc` is nullable: membership is active when there is no removal newer than the add. Re-add writes a newer add HLC.

## 6. Lifecycle semantics

- **Add/import:** store original by hash; create/update book metadata locally; enqueue replicated mutation and upload independently.
- **Archive:** set `archived_at`; sync as a reversible metadata state. The file remains available.
- **Delete metadata:** set a tombstone (`deleted_at`) and retain it through sync/retention windows. This removes the book from normal views but is recoverable during the retention policy.
- **Purge metadata:** only after explicit confirmation, successful export or acknowledgement, and defined server retention. Purging is not part of MVP.
- **Delete remote bytes:** separate explicit action, authorized and confirmed; must not occur because of archive or a metadata tombstone alone.
- **Deduplicate:** identical content hash links to the existing record; metadata merge behavior must avoid overwriting richer data with empty extraction values.

## 7. Clock and timestamp semantics

HLC ordering is `(wall_ms, counter, device_id)` with lexicographic comparison after parsing components. `device_id` deterministically breaks ties. HLC is for conflict order; `started_at`, `added_at`, and `last_opened_at` describe user-visible instants and are not interchangeable with HLC.

Reading sessions are append-only; validate duration and cap or flag implausible sessions. Statistics are derived from sessions and are not separately synchronized aggregates.

## 8. Migrations and compatibility

- Version every local schema and every D1 migration.
- Migrations are forward-only, deterministic, and tested on empty and populated fixtures.
- Backup/export before migrations that may discard or transform user data.
- Clients may be offline for long periods; sync payloads require a versioned envelope and server compatibility policy.
- Unknown optional fields should be tolerated; unknown entity types or unsupported schema versions must fail visibly without advancing the pull cursor.
- Do not change HLC format, locator semantics, or hash identity without migration and compatibility notes.

## 9. Questions to settle during implementation

- Whether tag names are case-folded using Unicode normalization and how duplicate tags merge.
- Exact deleted-book retention interval and when remote file bytes become eligible for explicit cleanup.
- Whether cover thumbnails are stored under a derivative key with their own content hash.
- The payload envelope version and forward/backward compatibility window.
