# Shareable diagnostics

The Settings diagnostics download produces `book-reader-diagnostics.json`. It is a local, explicit download; the application does not send it anywhere. The report helps distinguish a storage problem, pending synchronization, or a schema/build mismatch without including library content. Review the downloaded report before sharing it.

## Included fields

The versioned `book-reader-diagnostics` format currently includes:

- Application package version, build mode, local IndexedDB schema version and replicated wire schema version.
- File-storage backend and whether that adapter is durable; the browser persistence decision if known.
- Browser-reported origin storage usage and quota, rounded upward to whole MiB. These are approximate origin-wide figures, not individual original-file sizes. Unavailable estimates are `null` with `estimateAvailable: false`.
- Aggregate active, archived, deleted and total book counts.
- Aggregate pending and total outbox counts and transfer counts for queued, running, failed, complete and cancelled jobs.
- Whether sync is configured, its coarse current state and the last completed metadata-cycle timestamp if recorded.
- The report format version and generation time.

The last metadata-success timestamp does not prove all original files were uploaded. The failure count indicates transfer work requiring attention; detailed failure text remains in the local Settings view.

## Excluded fields

No book titles, authors, filenames, content hashes, original bytes, covers, text excerpts, notes, bookmarks, locators, reading positions, shelf/tag names, reading-session history, device or user identifiers are included. No sync endpoint URL, token, credential, outbox payload, raw exception message, local filesystem path, user-agent string or database name is included.

This is implemented as an explicit field allowlist rather than removing suspicious strings from a full database export. `DiagnosticsService.capture()` uses indexed aggregate counts and reads only the saved success timestamp from sync metadata. It never serializes book rows, file-transfer rows, configuration or error objects. Storage-estimate failures result in unavailable fields rather than exporting an exception.

Aggregate counts, approximate storage usage and timestamps still describe the installation. They are useful support information, not an anonymity guarantee. Sharing remains the user's decision.

## Implementation and maintenance

`services.diagnostics.capture()` returns a typed `DiagnosticReport`; `blob()` returns the JSON Blob; `download()` downloads it with a fixed, content-independent filename. The service performs no database writes, network calls or file-content reads. Downloading diagnostics cannot acknowledge or clear the outbox.

The report's own `version` changes when the public diagnostic format needs a breaking change. Adding a field requires reviewing its privacy effect, extending the allowlist explicitly, and updating this document. Do not spread a service status object or database row into the report. Raw errors and configuration belong only in local views unless a separate, reviewed export explicitly requests them.

Verification:

```sh
npx vitest run tests/services/diagnostics-service.test.ts
```

Tests seed distinctive private markers into book metadata, annotations, IDs, hashes, outbox payloads, endpoint/token URLs and transfer errors. They assert that none are exported, that only documented keys are present, that approximate usage/counts remain useful, and that serialization does not mutate the outbox. An injected storage failure also verifies that its private exception text never appears.
