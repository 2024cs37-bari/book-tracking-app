# Backup and recovery

The app provides two local exports from **Settings → Backup and recovery**:

- **Portable backup (.zip):** all book metadata, original book files, available covers, reading progress, annotations, shelves, tags, memberships and reading sessions. Every original must be present and pass SHA-256 verification. If a book is missing, damaged or exceeds a supported size, the entire export fails with a specific error. No incomplete archive is reported as a full backup.
- **Metadata export (.json):** all replicated library rows, including archived and deleted books. It contains **no original book files or cover bytes**. Keep originals separately; missing books must be reimported or downloaded before they can be read.

Keep downloads outside browser-managed storage. Browser persistence, offline caching and sync do not replace a backup. The download action cannot prove that the browser finished saving the file; verify the saved file by selecting it in recovery and checking its preview.

## Restoring safely

Choose **Restore from backup…** and select a JSON or portable ZIP export. The app reads and validates the entire backup before showing a preview. It does not write library rows or files during this step. Review the number of books and records to add, existing records to preserve, original files, storage required and any missing originals, then choose **Add missing data from backup**. Cancel discards the preview without changes.

Recovery is **additive**, not a replacement of the current library:

- Existing records, including newer edits, reading progress and deletion tombstones, remain unchanged. Repeated recovery does not duplicate records or queue duplicate changes.
- Missing records are added. Books already present under a different identifier are matched by the original content hash, and recovered annotations, sessions and memberships reference the existing book. Active tags reuse an existing tag with the same normalized name.
- The same book identifier pointing to a different content hash, size or format is a conflict and fails recovery. A damaged existing original is not silently overwritten. Preserve or repair that file through the normal original-file recovery/import path first.
- Originals in portable backups can repair missing local availability even when the book metadata already exists. Covers belonging only to preserved metadata are not copied unnecessarily. A JSON recovery clears unavailable cover references for newly added books.
- If the library changes while the preview is open or while files are staged, the metadata commit is refused. Select the backup again for an updated preview. This prevents confirmation of stale counts.
- Restored rows become intentional new local mutations and enter the sync outbox. A configured synchronization service can propagate them to other devices. Device identifiers, sync credentials, server cursors, pending conflicts, local pin choices, transfer state and existing outbox history are never imported from a backup.

An old backup cannot overwrite a current local record. To inspect the exact old state, recover it into a separate, empty browser profile. Keep the current profile and its backup until the recovered library has been checked.

## Size and compatibility limits

Portable ZIP version 1 supports **128 MiB total**, **64 MiB per original**, **4 MiB per cover**, **8 MiB metadata** and **10,002 ZIP entries**. Metadata is capped at **100,000 total rows**. Export reserves metadata/header space before retaining original bytes, so a library near the total limit can be refused before the final archive is built. Limits bound browser memory; this implementation assembles a bounded archive in memory and is not a streaming archive format.

For larger libraries, use the JSON metadata export and separately retain the original files. A future streaming format must receive its own version and tests rather than silently increasing these limits.

The metadata reader accepts replicated schema versions 1 and 2. Schema 1 may omit the six tables added in schema 2. Schema 2 requires all eight replicated arrays. Unknown, fractional, negative and future schema versions are refused. Local IndexedDB migrations are diagnostic export information; they do not control restore compatibility.

A portable backup is an ordinary **uncompressed ZIP** made by this app. Do not unpack and recompress it before recovery. The parser deliberately accepts only the bounded stored-entry ZIP subset the writer produces; it refuses compressed entries, encryption, ZIP64, multiple disks, comments on the archive, unsupported flags, unsafe paths, duplicate names, inconsistent central/local headers, overlapping/trailing data and damaged CRCs. It never invokes a decompressor, preventing ZIP expansion attacks.

## Portable format contract

The ZIP contains:

```text
manifest.json
metadata.json
books/<lowercase-sha256>.bin
covers/<book-id>.<extension>   # only covers included by metadata
```

`manifest.json` has this shape:

```json
{
  "format": "book-reader-backup",
  "version": 1,
  "metadata": { "path": "metadata.json", "sizeBytes": 1234, "sha256": "..." },
  "originals": [{ "path": "books/<sha256>.bin", "sizeBytes": 123, "sha256": "..." }],
  "covers": [{ "path": "covers/<id>.png", "sizeBytes": 456, "sha256": "..." }]
}
```

`metadata.json` is the same document shape as the JSON export. The manifest accounts for every archive entry except itself. Each entry's exact byte size and SHA-256 digest are verified, and original entries must also match the book's recorded content hash and size. Every exported book must have exactly one original. Cover entries must exactly match the cover references. Unexpected or missing entries fail preparation.

Hashes and CRCs detect corruption and inconsistent contents. They are **not signatures** and do not authenticate the author of a backup. The backup is unencrypted and contains private reading data and book contents; store and share it accordingly.

## Validation and transaction model

Metadata capture reads all eight replicated tables in one readonly IndexedDB transaction so shelves, membership references and book rows come from a consistent snapshot. Original files are immutable and addressed by hash. Export holds the shared original-file lease while reading and verifying each file; removals cannot invalidate an in-progress original read.

Validation projects approved fields into new typed rows instead of persisting casts of JSON values. It checks field types and limits, safe identifiers, lowercase content hashes, known enums, lifecycle timestamps, finite numeric values, fractions, locators, normalized tag names, clock syntax/counter bounds, duplicate identities and orphan relationships. Clock values more than 24 hours ahead are rejected. Optional per-field metadata clocks use a fixed known field vocabulary and are checked too. Unknown extra row properties are dropped; malformed known properties are rejected.

The row projection is shared with local mutation enqueueing and incoming synchronization in
`src/data/replicated-validation.ts`. This prevents accepting synchronized or locally edited rows
that a later backup would reject. Book field clocks cannot exceed the book update clock; dates
must fit the JavaScript date range, and session timestamps leave room for the maximum session
duration. Full backup validation additionally checks duplicate identities and the complete
relationship graph; sync may receive child records before their parents on later pages.

Applying recovery follows this order:

1. Acquire shared leases for affected original hashes and recheck that the library still matches the preview.
2. Recheck existing originals and stage only missing, verified bytes. Existing bytes with a different digest are never replaced. Verify stored bytes after writing them.
3. Open one read-write IndexedDB transaction covering all replicated tables, outbox, sync metadata and device state. Check the library snapshot again inside that transaction.
4. Add only planned missing rows and outbox events. Mutable records receive fresh local HLC stamps; per-field metadata clock values are refreshed. Membership active/removed state is retained while rebasing its ordering. Historical session facts and annotation creation times are kept; an annotation creation clock ahead of its new update is capped to that update.
5. Persist the local clock and accurate local file availability in the same transaction, commit, and release file leases.

A database failure rolls back every metadata, outbox, device-state and clock-state write. In-memory clock counters may advance on an aborted transaction, creating harmless gaps rather than ordering reuse.

File storage and IndexedDB cannot share one transaction. If staging or the final database commit fails, verified staged originals may remain as **unreferenced local files**. Recovery intentionally keeps them so retry can reuse them and so rollback cannot delete bytes another operation has adopted. Storage diagnostics/reconciliation can identify unused originals; cleanup must use original-file leases and recheck references before deleting them. Covers are regenerable derivatives and should not be automatically removed concurrently with backup/import. A browser crash after staging has the same recoverable outcome.

## Service APIs

The application supplies the active file store and shared logical clock:

```ts
const exports = new ExportService(db, files);
const restores = new RestoreService(db, { files, clock });

const json = await exports.buildMetadataExport();
const zip: Blob = await exports.buildPortableBackup();

// File selection may provide a .json or .zip Blob. This is read-only.
const preview = await restores.prepare(file);
// Present preview to the user before calling apply.
const summary = await restores.apply(preview);
```

`prepare(string)` always reads a metadata JSON document. `prepare(Blob)` detects a ZIP signature; all other inputs are read as bounded UTF-8 JSON. The returned preview is immutable and contains counts/warnings, not untrusted rows. A private weak map associates the exact preview object with its validated plan, so constructed or copied preview objects cannot authorize a mutation. A successful preview is consumed; a failed or stale preview should be discarded and prepared again. The UI does this automatically.

`RestoreService.restore(json)` remains a programmatic compatibility convenience that prepares and immediately applies metadata. Interactive callers should use the two-step API. `ExportService.download()` preserves the original JSON filename pattern; `downloadPortable()` saves a `.zip` with the `book-reader-backup-YYYY-MM-DD.zip` pattern. Passing no file store supports metadata-only integrations and tests, but portable operations require it.

`BackupPanel` owns the user-facing selection, validation, preview, apply/cancel and download flow. Its optional `onRestored` callback refreshes parent diagnostics. The parent can disable operations using its `disabled` prop.

## Verification and future development

Run:

```sh
npx vitest run tests/services/restore-service.test.ts
npm run typecheck
```

The tests exercise a real generated EPUB round trip, missing/corrupt originals, manifest tampering with a valid ZIP CRC, metadata identity mismatch, hostile ZIP shapes, input size rejection before reading, malformed schemas and fields, orphan references, duplicate rows, same-content UUID reconciliation, metadata-only availability, PDF locators, fresh clock ordering, stale previews, idempotence, atomic rollback, failed file writes, retry from staged bytes and protection from concurrent file removal.

Preserve these guarantees when adding formats or schema fields. Update the validation projection and limits alongside any persisted row change. Never treat matching filenames or hashes stored in a manifest as proof of intact bytes; verify bytes. Never turn additive recovery into replacement semantics without a separately reviewed preview, conflict model and recoverable pre-restore snapshot. Large-library streaming backups, authenticated/encrypted archives and cross-profile recovery drills remain separate future improvements.
