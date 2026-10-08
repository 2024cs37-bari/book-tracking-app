# ADR 0004: Durable browser file fallback and optional storage permission

- **Status:** Accepted
- **Date:** 2026-10-08

## Context

Cross-browser reader checks exposed two startup/storage limitations: Firefox never reached the
library navigation while optional persistence permission was pending, and Playwright WebKit's OPFS
probe failed, causing the memory fallback to lose original bytes on reload. An exposed storage API
is not evidence that writes work. Offline reading needs a durable fallback when OPFS is unusable.

## Decision

Probe OPFS first. If unavailable or unusable, probe a native IndexedDB binary store before selecting
memory. The fallback stores raw ArrayBuffers plus MIME types under the same content-addressed keys,
in a separate `book-reader-files` database with current schema version 2 and a `files` object store
keyed by `key`. Its released version 1 stored Blobs; WebKit CI demonstrated that decoding an
IndexedDB-backed Blob after offline navigation fails with an origin-bound blob access error.
Version 2 recreates Blobs from plain bytes in the current document instead.
The released Dexie metadata schema remains unchanged at version 1. Future binary schema
changes require new versions too; do not edit a released version.

The v1-to-v2 upgrade retains the original object store and every row. Legacy Blob rows are converted
on successful read, outside the schema transaction, preserving key, bytes and MIME. A legacy Blob
which cannot be decoded offline remains intact and may need one online read/re-import to convert.
No originals are discarded by migration.

Resolve writes only after IndexedDB transaction completion. Preserve MIME types, support the
existing file-store contract, and remove only explicitly requested keys. Import journaling and
metadata/outbox atomicity continue through the existing import/repository workflow.

Storage persistence permission is optional. Bound an unanswered `navigator.storage.persist()`
request to 1.5 seconds; return `null` if it is still pending, and let the library boot. This timeout
does not revoke a later browser permission answer or imply persistent storage was granted.

## Consequences

- UI reports the selected fallback accurately. Memory remains an explicitly non-durable last resort.
- IndexedDB shares browser quotas and eviction risks; "durable" means surviving normal reloads,
  not guaranteed disk permanence. Blob-backed reading still uses whole-file buffers.
- The file store remains isolated in `storage`; UI never imports IndexedDB implementations.
- Existing OPFS originals are retained. This change does not move or delete them, and a temporarily
  inaccessible prior store may require re-import before reading. A cross-store migration/lookup
  strategy is separate future work.
- Regression tests exercise committed binary round-trips/reopening, explicit removal, fallback
  selection and unanswered persistence permission, alongside actual-browser offline reading.
