# Roadmap and future application

This roadmap separates code capability from release evidence. Historical ADRs explain original
choices; [Development](DEVELOPMENT.md) records actual changes/checks. The target remains a private
single-user reader, not a public book platform.

## Current implemented baseline

- Local library/import, deduplication and repair, EPUB/PDF reading, contents/search/settings.
- Bookmarks, notes, highlights, collections, metadata editing, archive and tombstones.
- Reading activity and statistics; metadata/Markdown export; bounded portable backup/recovery.
- Atomic local outbox, deterministic metadata sync, progress divergence and identity reconciliation.
- Authenticated Worker/D1/R2 backend, verified file transfer and background retry scheduling.
- Device-local pinning, conservative verified-remote cache cleanup and original-file export.
- Offline production app shell, optional dictionary consent and browser-dependent read-aloud.

These capabilities require continuing regression and real-file evidence. EPUB/PDF remain
experimental; the existence of a renderer is not conformance certification. Production configuration
still must be provisioned and validated in the owner's Cloudflare account.

## Release gate A — Reliable local library

Exit criteria:

1. Import failures cannot publish invalid originals; duplicates can repair missing bytes.
2. Reader navigation/close/reopen retains the latest successfully saved position; failed saves are
   visible and retryable without overwriting newer progress.
3. Portable recovery validates all metadata and bytes before application; existing user data stays
   intact. JSON-only recovery is explicit about absent originals.
4. Archive/tombstone behavior, pinning and cleanup cannot silently destroy recoverable originals.
5. Keyboard/focus behavior and narrow-screen layouts work in app chrome. Reading statistics remain
   estimates of recorded visible activity, not a claim of eye-tracked attention.
6. Typecheck/lint/format/unit/browser gates pass; regression tests cover failure and recovery paths.

Current hardening addresses these gates first. Physical-device/corpus work below is still required
before removing experimental format labels.

## Release gate B — Private cross-device use

Exit criteria:

- Two independently populated clients converge after replay/reordering, disconnection, duplicate
  content import, partial acknowledgement and concurrent edits; annotations and positions survive.
- Background work is bounded, visible, pausable and respectful of auth expiry/backoff. A local edit
  never waits on network success. Failed jobs remain inspectable and retryable.
- Real local Worker/D1/R2 tests exercise the browser transport, CSP and CORS, not only mocked fetch.
- Production Access is enforced on every API hostname, exact origins are configured, storage is
  private, migration is applied and verified export/recovery is rehearsed.
- Request/response and file limits are documented; large unsupported work fails clearly.

Local tests establish local behavior. Actual Access login/cookie/CORS behavior must additionally be
checked against the deployment; never infer deployment security from DEV_USER tests.

## Release gate C — Platform evidence

Run the pinned corpus and generated browser tests in Chromium, Firefox and Playwright WebKit. Then
repeat import, offline navigation/reload, selection/annotation and recovery on real Android and
Safari/iOS hardware. Record device/OS/browser, file hash, renderer version, timing and memory across
several repetitions. Expand EPUB fixed spreads, RTL, obfuscated fonts and large-image PDF coverage.

Add accessibility checks for zoom, keyboard-only use, focus restoration, contrast and assistive
technology. Chromium desktop emulation is not a substitute for these measurements.
See [Reader validation](READER-VALIDATION.md).

## Next: large libraries and maintenance

1. **Streamed backups:** avoid whole-library buffers, allow a destination picker or chunked archive,
   preserve manifest version/hash validation and partial-backup warnings. Prove restore of a library
   exceeding current portable limits before increasing defaults.
2. **Multipart transfer:** add resumable parts, durable upload IDs, part checksum rules, cancellation,
   expiry and cleanup. Only mark originals available after final integrity verification. Interrupted
   jobs must resume or explicitly restart; never label a whole-file retry as multipart resume.
3. **History retention:** measure D1 growth first. Add snapshots with a consistent replay cursor and
   compatibility floor before compaction. Test a long-offline client and tombstone propagation.
4. **Operational diagnostics:** the allowlisted local diagnostic export is implemented. Add
   owner-controlled aggregate alerts after deployment, with explicit retention and privacy rules.
5. **Library scale:** benchmark large metadata collections, cover generation, search cancellation,
   startup clock recovery and outbox growth before replacing repositories or introducing workers.

## Next: desktop delivery

The Linux Tauri foundation now shares the web frontend and provides native original storage, bounded
IPC, atomic checked writes, OS Save dialogs and guarded close/restart. See [Desktop](DESKTOP.md) for
actual checks. It remains experimental and local-only: a configured desktop sync URL is rejected
because Cloudflare Access authentication cannot reuse the web client's origin/cookie flow safely.

Before a cross-device desktop release, define native sign-in, account identity matching, credential
storage in the OS keychain, refresh/revocation and logout. Preserve exact-origin server validation;
do not enable an arbitrary native HTTP proxy or ship shared service credentials. Test the resulting
flow against an actual Access deployment and unauthenticated/expired/revoked sessions.

Additional acceptance includes verified migration from portable browser exports, repeated offline
close/restart, platform-specific permissions, signed releases where required, safe updates and
uninstall semantics that explain retained data. Package Linux first, then Windows/macOS with their
own build/installation/recovery evidence. Drag/drop is an import UI, not an alternative identity or
storage model.

## Conditional future capabilities

- **MOBI/AZW3/FB2/CBZ readers:** promote one format at a time only after a legally distributable
  corpus passes navigation, locators, annotations, offline restore and resource/error handling.
- **Native mobile:** only when measured PWA storage/background/file limitations block the product;
  keep one domain and sync protocol across clients.
- **End-to-end encryption:** first decide key creation, multi-device transfer, recovery/loss,
  authenticated manifests, rotation, and how encrypted hashes affect deduplication. No recoverable
  design means no rollout.
- **Automatic third-party backups:** use explicit provider authorization, encryption/retention and
  restore exercises; preserve local export without vendor dependence.
- **Nested folders or richer goals/statistics:** validate a concrete need, model membership and
  conflicts explicitly, and avoid changing book identity or reading status semantics.

Public sharing, social feeds, DRM circumvention, sales, recommendations and multi-user collaboration
remain out of scope. A license decision belongs to the owner before public contributions/releases.

## Change policy

A milestone closes only when user behavior, migration/recovery, tests and docs agree. Record
unavailable external validation honestly. Preserve the previous stable artifact and migration
history; additive features must not make an older supported client corrupt data. Prefer focused
slices with explicit acceptance tests over expanding the feature list without evidence.
