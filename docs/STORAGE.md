# Local and remote storage

## 1. Responsibilities

The storage layer preserves metadata, original file bytes, and queued work independently. It must distinguish library metadata presence from local file availability and cloud file availability.

| Data                                                        | Initial local storage                         | Remote storage                                |
| ----------------------------------------------------------- | --------------------------------------------- | --------------------------------------------- |
| Book metadata, progress, collections, annotations, sessions | Dexie/IndexedDB                               | D1 after sync                                 |
| Browser book bytes                                          | OPFS when supported; tested fallback required | Private R2 after upload                       |
| Desktop book bytes                                          | Tauri app data directory                      | Private R2 after upload                       |
| Pinned/last-opened state                                    | Per-device local database                     | None                                          |
| Outbox, cursor, transfer queue                              | Local database                                | Server idempotency/change-log state as needed |
| Cover thumbnail                                             | Local cache/object store                      | Private R2 derivative or regenerated copy     |

## 2. Local metadata database

Use Dexie over IndexedDB for the initial implementation. It is mature for browser persistence, supports indexed queries and transactions, and avoids making a WebAssembly SQLite deployment prerequisite for the PWA. Keep domain logic behind repositories so a later database change is possible without rewriting UI behavior.

Requirements:

- Declare explicit Dexie schema versions and tested upgrade functions.
- Use transactions for replicated entity + outbox writes and pull page + cursor writes.
- Avoid large binary blobs in the metadata tables when OPFS is available.
- Provide a local export before destructive reset or risky migration.
- Detect unavailable/quota-exceeded storage and surface actionable errors.

IndexedDB is not a guaranteed durable disk. Browser eviction, private browsing, user clearing, and platform-specific behavior must be handled. `navigator.storage.persist()` may be requested where available; the app must work if permission is denied.

## 3. File store and content identity

The file-store interface should support writing, reading, deleting local cache copies, existence checks, byte counts, and streaming hash verification. Implementations:

- Web: OPFS when capability checks and browser tests pass. Provide a fallback strategy based on actual supported browsers and expected maximum file sizes.
- Tauri: application data directory, accessed through narrow native commands or an approved plugin.

Original files are stored unmodified and keyed by the lowercase SHA-256 of their bytes. The hash is the deduplication identity and R2 object key. Hash while streaming where practical to avoid unnecessary memory copies. Verify the hash after import and download. A cover thumbnail is a derivative and must not replace the original or be mistaken for the book's content hash.

Filesystem writes and IndexedDB metadata cannot share a transaction. Import must therefore use a recoverable staged workflow: write temporary file, verify content, commit metadata/outbox, then atomically promote where supported; or persist an import journal that can reconcile orphaned files and rows after a crash. Never leave ambiguous half-imported state silently.

## 4. Availability state

Represent separately:

- Metadata present locally.
- Original present locally and verified.
- Upload state (`not_started`, `queued`, `uploading`, `available_remote`, `failed`).
- Download state (`not_requested`, `queued`, `downloading`, `available_local`, `failed`).
- Device pin state.

A UI label such as “Available offline” is shown only when the local original exists and integrity checks pass. A failed hash verification marks the file unavailable and offers re-download/re-import.

## 5. Selective offline and quota management

Initial offline policy:

- Never evict the currently open file or a pinned file.
- Keep recently opened unpinned books up to a configurable budget when storage permits.
- Download remote-only books on demand.
- Keep metadata and small covers available locally where possible.
- Evict least-recently-used unpinned file bytes first; do not delete metadata or annotations.
- Warn before a pin cannot be honored because of quota; do not silently mark it pinned but absent.

Budget estimates are advisory because browsers may impose independent quotas. Query storage estimates where supported, handle write failures, and reconcile reported byte counts against actual store contents periodically. Avoid automatically downloading the entire library in the initial release.

## 6. Transfer queues

Upload/download jobs are durable local records. Each job contains content hash, direction, state, completed bytes or parts, retry timing, and an opaque multipart upload ID if needed. Signed URLs are short-lived and must not be persisted longer than necessary. On restart, renew authorization and resume only if server-side multipart state remains valid; otherwise restart cleanly and clean up abandoned parts through a server policy.

Queue processing is bounded by concurrency, respects connectivity and battery/data-saving signals where available, and can be paused by the user. Metadata sync remains independent.

## 7. Server object storage

R2 is private. The Worker authorizes an upload/download request and issues a short-lived URL or mediates a download if direct signed operations cannot satisfy the security model. The Worker does not proxy large book bodies by default. Confirm object size, expected hash, and completion state before publishing file availability to clients. See [Backend](BACKEND.md).

## 8. Export and restore

Manual export is the initial backup path:

- JSON export includes schema/version metadata, books, progress, collections, annotations, and sessions.
- Markdown export contains human-readable annotations and locator context.
- Optional archive export includes original files, mapped by content hash, with a manifest.
- Export is generated locally and must remain possible when the server is unavailable.

Restore validates the manifest, hashes, schema version, and relationships before modifying current state. Prefer import into a staging area and show counts/errors before merge. Automated external backup is deferred until restore is tested and credential handling is designed.

## 9. Data removal and cleanup

Archiving does not remove bytes. Metadata tombstones and remote object deletion are separate. Local cache eviction may remove bytes without changing replicated metadata. Permanent remote deletion requires explicit confirmation, and any future garbage collection must account for all metadata references and retention policy. See [ADR 0002](decisions/0002-data-lifecycle.md).
