# Storage and offline availability

## Responsibilities

Metadata uses Dexie/IndexedDB; original bytes use a `BookFileStore`; transfer queues and pins are
local device state. A metadata row does not prove the original exists locally or remotely.
Originals are unchanged bytes addressed by SHA-256; covers are replaceable derivatives.

Browser storage selection probes OPFS, then a separate durable IndexedDB byte store, then memory. Each
startup uses independent probe keys so concurrent windows cannot remove one another's checks. An
unanswered optional persistence request is bounded so startup can proceed. The UI distinguishes
durable fallback from memory-only storage. Browser quotas, private mode, eviction and clearing
site data still apply; persistence permission and pins are not absolute disk guarantees.

## Import and repair

Import bounds file size, detects content, hashes bytes, extracts metadata, writes/verifies the
original, then commits metadata/outbox. Crashes between file and metadata steps can leave an
unreferenced file; reconciliation reports it. Re-import of identical content repairs missing or
corrupt bytes without replacing user-edited metadata.

The file store and metadata database cannot share a transaction. Do not remove staged originals
merely because a later metadata operation failed. Portable restore follows the same recoverable
ordering. See [Backup](BACKUP.md).

## Pins and local cache removal

Pinning is a per-device decision. The book must be present, hash-verified and in a durable store
before it is marked pinned. Unpinning changes only the pin; it does not remove bytes.

Settings lets the user select a target original-file budget and explicitly free space. Cleanup
walks least-recently-opened candidates and only removes originals when:

- The book is not pinned or tombstoned.
- No reader, importer, backup or transfer holds a shared file lease.
- An exclusive Web Lock can protect removal from other tabs.
- The configured server currently confirms a trusted original with matching hash and size.

Failed network verification stops removal. A previous completed upload alone is insufficient.
After remote verification, cleanup resolves current book references by content hash and checks
their lifecycle and pins again. It keeps a short metadata transaction open across local removal,
so sync canonicalization or a concurrent tombstone cannot invalidate that final check. Network
verification never holds that transaction. Pinning and import completion also resolve the current
content identity after file IO, avoiding stale device-state records when sync replaces a UUID.
Metadata, progress, annotations and covers remain. If protected data exceeds the target, report
that the target could not be reached; never force removal. Without cross-tab locks, browser cache
cleanup is unavailable. No automatic removal occurs merely because browser quota is low.

## Reconciliation

Settings reports missing local originals, unreferenced files and estimated usage. Tombstoned books
continue to reference originals so recovery remains possible. Cleanup rechecks references under
exclusive file leases before removing recognized orphan originals. Unknown file keys and cover
artifacts are retained for review; stale reports are not deletion authority.

`filePresent` is advisory device state; opening a reader and storage diagnostics check actual
availability. A missing book can be downloaded or re-imported. Save-original and portable backups
provide recovery outside the origin's browser storage.

## Transfers

File jobs are keyed by direction and hash, survive restart, retain errors/retry deadlines, and can
be cancelled. Explicit download requests can requeue a previously completed download after eviction.
Automatic discovery does not reset a failed job's backoff or revive a cancelled job.

The current protocol restarts interrupted whole-file work. Multipart upload IDs/parts require a
future versioned state machine, server expiry and abandoned-part cleanup. Current request and backup
limits are documented independently in [API](API.md) and [Backup](BACKUP.md).

## Platform stores and future work

The native runtime selects the implemented Tauri adapter in app-owned directories. It preserves
file identity through bounded IPC, hash checks and atomic publication, and treats startup failure
as fatal instead of falling back to a separate browser store. Metadata remains in the WebView
IndexedDB profile. Browser-to-native migration uses the validated portable backup flow; it does
not copy browser profiles implicitly. See [Desktop](DESKTOP.md) for runtime and recovery evidence.

Streaming backups, large-file range reads and additional platform adapters remain future work.
Each needs recovery and platform tests; native storage alone does not establish their behavior.
