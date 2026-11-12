# Development and hardening record

This record distinguishes implemented behavior, executed checks and external release prerequisites.
The target is a private, single-user, offline-first library with EPUB/PDF reading, optional private
sync and recoverable original files. DRM bypass, public sharing and collaboration remain out of scope.

## Baseline audit — 2026-11-07

The starting app already contained readers, annotations, collections, statistics and a sync client,
while older documentation described many of them as future work. Baseline checks passed: 298 client
unit tests, 13 server tests and 38 Chromium browser tests, plus types/lint/build. Formatting attempted
to include local tool artifacts. Firefox, WebKit and the external corpus had not been rerun in that audit.

Confirmed issues included blocked dictionary/cross-origin connections, misleading durable-storage
warnings, weak recovery validation, incomplete sync convergence/scheduling and missing offline controls.
The workspace has no Git metadata. A pre-hardening source safety snapshot is at
`/tmp/book-tracking-before-hardening-20261107.tar.gz`; temporary storage is not a durable backup.

## Slice 1 — Trust, identity and recovery

Implemented:

- Least-privilege app connection policy with validated sync origins and optional dictionary consent.
- Bounded Worker JSON validation, exact CORS origins, verified Access claims, loopback-only dev
  identity, immutable mutation idempotency and bounded D1 batches.
- Streamed private original uploads with R2 SHA-256 verification, exact completion checks and trusted
  HEAD availability; legacy unverified originals remain recoverable but cannot justify local eviction.
- Per-field metadata clocks, explicit clears, canonical identity for duplicate imports across devices,
  transactional child/alias migration, atomic pull cursor/checkpoint and clock crash recovery.
- Bounded portable archives, hash/CRC/manifest/relationship validation, preview then additive recovery,
  current-record preservation and fresh outbox events. JSON-only export remains explicitly metadata-only.

Focused tests cover malformed input, rollback, stale previews, id collisions, replay/convergence,
independent device imports, legacy object recovery and checksum failures. The configured browser suite
uses three isolated contexts and a real local Worker/D1/R2 to exercise offline edits, reconnect,
collections, original upload/download, bookmarks and explicit progress-conflict resolution.

## Slice 2 — Daily offline use

Implemented:

- OPFS/IndexedDB/memory capability reporting, byte verification and duplicate-import repair.
- Shared file leases, device-local pins, individual original export and explicit conservative cache
  cleanup. Open/pinned/tombstoned originals remain protected; eviction requires live verified remote
  hash/size evidence and cross-tab locks.
- Background metadata and transfer scheduling with bounded cycles, persistent pause, retry/backoff,
  Retry-After, auth/permanent error states and active-request cancellation.
- Installable production app shell with integrity-checked precache; existing windows retain their
  current engine during updates. Private API/auth requests bypass the offline shell.
- Settings for sync, recovery and offline storage; allowlisted diagnostics export with no private
  content, file/account/device identifiers, endpoint addresses or raw errors.

The browser suites exercise durable fallback, pin persistence, exact original export, fresh-profile
portable recovery, dictionary consent and current/failed app-shell updates.

## Slice 3 — Reader reliability and usable controls

Implemented:

- Retryable position saves, bounded recent intent journal, canonical IDs and preservation of unresolved
  cross-device position choices through initial renderer relocation.
- Monotonic visible reading spans, periodic checkpoints, retryable activity recording and resume after
  visibility/page lifecycle changes.
- PDF render cancellation, displayed-canvas cleanup, bounded thumbnails and object URL lifetimes.
- Bounded EPUB archive preflight/metadata extraction and dictionary request/body/cache limits.
- Reading days/streaks/finished counts and daily last recorded positions. Backward movement remains
  visible rather than being counted as new forward progress.
- Stable library card identity during background commits; cover resources reload only when their key
  changes. A pointer-down/import/pointer-up regression protects navigation during refresh.
- Keyboard focus transfer from the skip link, reader tab semantics and contrast-aware accent colors.
  Automated accessibility checks cover populated views at desktop and narrow widths.

Cross-browser testing found and fixed an EPUB save-error feedback loop: a temporary save banner
changed the viewport, which generated another relocation/save and hid the failure. Failed saves now
remain visible and duplicate relocations do not create extra writes. The exact failure/reload path
has a browser regression.

## Slice 4 — Release evidence and maintainability

Current code and contracts replace outdated design-only assertions in README, architecture, data,
sync, storage, backend, import, contribution, recovery and operations documentation. Historical ADRs
retain their context with explicit implementation updates. Relative document links are checked.

Client and server checks, production browser tests, local configured-sync integration, accessibility
checks and the pinned real-book corpus have separate commands and CI responsibilities. Test builds
and result directories are isolated so simultaneous suites cannot overwrite each other's assets.
Dependency auditing distinguishes shipped packages from development tooling.
Unit tests cap parallel workers at four to bound resource use on shared development hosts.

A final independent audit also closed stale-book-ID writes in device state, imports, annotations,
sessions and collection memberships; cache eviction rechecks hash/current pins/tombstones after
remote verification. Incoming sync, local outbox creation and recovery now share row validation,
so malformed data cannot be accepted as synced and then make every export invalid. Pending reader
intent uses stable original identity and recovers legacy alias keys. PDF page-stream errors remain
attached to the page lifetime even if a thumbnail starts decoding before foreground navigation;
programmatic PDF restoration preserves exact logical offsets through browser pixel rounding.

The completion audit also added the missing format filter, inline shelf/tag renaming and visible
annotation-anchor diagnostics. Unloaded annotation content stays unchecked; unavailable anchors
never destroy notes or create sync mutations. Rename preserves memberships and rejects occupied
local tag names. Locale-independent lookup keys migrate in local schema v4 while old outbox bytes,
tag IDs, names and clocks remain intact. Recovery and sync accept the supported legacy locale keys.
Concurrent browser startup probes now have independent keys, preventing accidental fallback to a
different storage backend. Maximum-length tag and rename-focus checks extend the responsive audit.
The final real-book corpus exposed a Firefox thumbnail click race: replacing a loading placeholder
between pointer-down and pointer-up could suppress navigation. Decorative thumbnail content now
ignores pointer events, keeping the stable button as the gesture target. A deterministic regression
holds thumbnail encoding until after pointer-down; it failed before the fix and passed afterward
across all three browser engines.

A successful local suite is not a claim that a remote CI run, production deployment or physical
device was tested.

## Slice 5 — Desktop foundation

A Linux-first Tauri shell and narrow native file-store adapter are implemented.
Native commands operate on validated logical book/cover keys inside the app-owned directory, with
bounded binary chunks, hash verification, staged atomic publication and a single-instance file lock.
The web build retains its browser storage path. Actual isolated native runtime checks verified
EPUB/PDF import and reading, original export, portable recovery into a fresh profile, collection
renaming and close/reopen progress. Native synchronization is explicitly disabled until an Access
authentication design is implemented. See [Desktop](DESKTOP.md) for exact package/runtime evidence
and remaining platform release requirements.

## Validation ledger before the UI redesign

- Baseline: 298 client, 13 server and 38 Chromium browser tests passed.
- Final `npm run check:all`: passed with 497 client tests in 51 files and 28 server tests in 5 files,
  plus TypeScript, lint, formatting, local documentation links and the production web build.
- Server tests include actual local workerd/D1/R2 and the maximum push batch.
- Configured browser sync: the final scenario passed in three independent fresh-backend runs,
  each using three isolated clients and actual local D1/R2. Both readers establish different local
  positions before the conflict assertion; pre-existing conflicts are resolved deliberately.
- Accessibility: 4 cases passed, covering populated desktop/narrow views, maximum-length tags,
  collection rename focus, reader keyboard controls and dark/Amber contrast. Serious/critical axe
  findings and document overflow fail this gate; third-party publication content remains outside it.
- Shipped npm dependencies: zero vulnerabilities reported for client and server.
- Native core: 11 Rust tests and 23 focused JavaScript tests passed. Optimized Linux packaging and
  the actual archive's executable passed native save/recovery/close and schema-v4 upgrade checks.
  Cargo audit checked 416 locked dependencies: zero vulnerability-class findings and two visible
  informational warnings (unmaintained macro tooling and GLib iterator unsoundness). See
  [Desktop](DESKTOP.md) for advisory IDs, dependency constraints, package hash and inspection limits.
- The real IndexedDB v3→v4 migration and explicit progress-conflict regressions passed 9 cases
  across Chromium, Firefox and WebKit. Migration preserved originals, tag IDs, memberships,
  tombstones and both pending/acknowledged outbox payload bytes.
- Final full generated browser matrix: 159 passed, 53 in each of Chromium, Firefox and WebKit.
  A recovery fixture previously navigated away before a status commit; the exported archive
  correctly contained the earlier value. The fixture now waits for the committed source state
  and follows app navigation. Recovery then passed nine repeated cases and the full matrix.
- Pinned corpus: 27 passed across all three engines after the thumbnail gesture fix. The corpus
  includes eight hash-verified external originals and a generated 240-page image PDF; resource-limit
  failures remain explicit expected behavior, not claims that oversized images rendered successfully.
  All 27 measurement/correctness records, tested asset fingerprints and single-run limitations are
  retained in [the validation report](validation/2026-11-07-reader.json), with interpretation in
  [Reader validation](READER-VALIDATION.md).

## External prerequisites and remaining scope

Production resource provisioning, Access policy/cookie behavior, actual cloud quotas and operational
recovery must be verified in the owner's account. Physical Android/iOS devices, screen-reader
sessions, native installer/signing/update checks and broader format conformance are separate evidence.
EPUB/PDF remain experimental; other formats are importable but have no registered renderer.

Current limits are documented rather than silently raised: 256 MiB imports, 100,000,000-byte mediated
uploads, and 128 MiB portable archives with 64 MiB per original. Large streamed backups, multipart
resume, server snapshots/compaction, native mobile and end-to-end encryption remain roadmap work
with explicit acceptance/recovery requirements. The owner must choose a license before a public release.

## November 2026 interface redesign

The [design guide](DESIGN.md) records reviewed references, shared visual rules and screenshots.
The library now prioritizes covers, readable metadata and a compact search/filter row. Common
status filters remain visible; advanced filtering is disclosed with a count and keyboard-safe
close/reset controls. Book details emphasizes reading; edition information and maintenance are
expandable. Settings uses section navigation and progressively disclosed technical details.
Statistics uses a clear time hierarchy. The reader has quiet top controls and a bottom page-turn
bar, with a compact appearance sheet and flatter navigation/notes/listening panels.

Warm light/dark palettes, contrast-aware accents, local typographic cover fallbacks and reduced
motion support apply consistently. No new runtime dependencies, remote fonts or image services
were introduced. The app does not automatically add the generated screenshot books.

Post-redesign verification (distinct from the pre-redesign ledger above):

- `npm run check`: 497 client tests in 51 files, types, lint, formatting, documentation links and
  production build passed. The two existing theme tests were then rerun against the new surface
  palette values; they pass without changing application code.
- `npm run test:accessibility`: 4 cases passed at 1280 and 390 pixels, including expanded library
  filters and advanced Settings diagnostics, long collections, focus and dark/Amber controls.
- Complete Chromium/Firefox/WebKit application suite: **165/165** passed, including the new
  library filter/Escape/reset and mobile reader-sheet dismissal regressions.
- **27 unique corpus cases** have fresh passing evidence. The initial run passed 24/27; the
  three failures came from a fixed aspect-ratio test tolerance on a source 8:1 PDF page rendered
  as 684×85 pixels instead of fractional 684×85.5. The assertion now accounts for one-pixel
  raster quantization; all 15 PDF cases passed on rerun, alongside the 12 reader measurements.
  The [new report](validation/2026-11-07-ui.json) retains that provenance and all evidence.
- Updated Linux package: actual archive executable checked for retained library/position, native
  export, themes/disclosures, collection focus and PDF thumbnail navigation. See
  [Desktop](DESKTOP.md) for package identity and precise test scope.

A sampled desktop sidebar-close reflow emitted one bounded Foliate ResizeObserver notification;
reader geometry was stable across 74 sampled frames before and after the change. Mobile samples
had no such notification. This remains recorded, without suppressing errors or claiming universal
performance. The in-app automation browser displayed the library/details but did not complete EPUB
rendering during preview; validated reader evidence comes from the named Playwright engines and
native package, not that automation preview. Physical-device and assistive-technology checks remain
separate release work.

## Custom controls and motion follow-up

The interrupted UI-polish work has been continued with a shared custom combobox for library
filters/sort, book status, app/reader themes and speech voices. Menus fit the viewport, wrap long
labels, support keyboard previews and typed search, and scroll independently of the book. Escape
closes a nested menu before its enclosing reader sheet. Dynamic options retain stable values.

The shell now has short route fades, reversible library filter transitions, disclosure motion,
animated selection underlines and subtle icon feedback. Reduced-motion preferences remove those
animations. Reading-surface geometry and saved positions are not animated. No dependency was added.

Takeover verification found and repaired two related focus races: an `overflow: hidden` filter
wrapper could scroll when a field was focused during expansion, and the selector dismissed itself
on every ancestor/document scroll. The wrapper now clips without becoming a scroll container;
the menu follows a visible anchor and dismisses when the anchor leaves the viewport or its
scrolling container. A dedicated browser regression covers the visible-anchor case. Screenshot
review also caught and corrected a wrapping **Sort by** label.

The accessibility scanner now waits for finite UI animations to settle before measuring contrast;
normal motion remains enabled during navigation and interaction. It polls current animation state
instead of retaining completion promises for removed exit elements. Legacy Theme test locators
now explicitly identify the combobox, since its open listbox has the same accessible label.

Verification and retained evidence:

- `npm run check:all`: 497 client tests in 51 files and 28 server tests in 5 files passed, with
  types, lint, formatting, documentation links and production build.
- The focused dropdown suite passed 24 cases across Chromium, Firefox and WebKit, including
  keyboard/typeahead, cancellation, mobile viewport bounds, dynamic voices, document scrolling,
  reader page preservation and reduced motion.
- The fresh complete application browser matrix passed **189/189** cases, 63 in each of those
  engines, after correcting the ambiguous Theme locators. No retries were used in the passing run.
- All 4 accessibility cases passed on the final interface, including an open custom menu,
  desktop/mobile populated views and dark/Amber themes. Existing Foliate ResizeObserver messages
  remain visible during scans; application controls were not excluded to suppress findings.
- The Linux package was rebuilt, extracted and launched in a fresh isolated profile. Native
  keyboard choice/commit, generated PDF import/navigation, reader-theme selection, nested Escape
  and page-position preservation passed. Package identity and exact scope are in [Desktop](DESKTOP.md).
- The [motion validation record](validation/2026-11-07-motion.json) retains the browser-matrix
  outcome, source hashes, commands, screenshots and scope limitations.

The [design guide](DESIGN.md), [accessibility guide](ACCESSIBILITY.md) and [user guide](USER-GUIDE.md)
describe the new interactions. Screenshots use generated fixtures in isolated profiles. This
follow-up does not repeat the external reader corpus, historical native recovery checks,
physical-device testing or screen-reader sessions; those retain their separately documented scope.

## Advanced reader — 2026-11-07

The reader now offers single, facing and continuous modes. PDF adds fit-width/page/actual size,
50–400% zoom, rotation, separate-cover pairing, right-to-left page order and optional inversion.
EPUB adds typeface, alignment, column measure and spacing controls, with native paginated/scrolled
flows. A direct page/section jump, focus mode and full screen complete the shell controls. Legacy
preferences upgrade without discarding valid fields; progress and annotation identities stay separate.
Fixed-layout EPUBs preserve publisher geometry and disable unsupported continuous/reflow options.

The PDF adapter now shares one document across a bounded set of page surfaces. Successful pages
remain visible until replacements paint. Cancellation releases fetched/pending pages, neighboring
failures are remembered, and a delayed focus/resize rebuild cannot overwrite a pending page turn.
The EPUB adapter forwards shell shortcuts from book frames and crosses section boundaries on wheel
input. A small documented `fixed-layout.js` patch enables explicit single/facing behavior.

Fresh final checks:

- `npm run check:all`: **506 client tests / 52 files**, **28 server tests / 5 files**, types, lint,
  formatting, documentation links and production build passed.
- Application browser matrix: **210 passed**, 70 in each of Chromium, Firefox and WebKit; includes
  21 new mode workflows for spread highlights, narrow fallback, continuous cache/offset recovery,
  fit/zoom/rotation, focus/full screen and EPUB flows/typography/offline resume.
- Pinned corpus: **27 passed** in one complete invocation, with all 27 evidence records retained.
  The corpus is the existing single-page baseline; generated tests provide the advanced-mode slice.
- Accessibility: **4 passed**, including the expanded reader controls and focus mode at 1280/390 px.
  The audit found and fixed the mobile settings summary name and low-contrast focus shortcut label.
- Linux `.deb` rebuilt successfully. The extracted executable passed facing/continuous PDF,
  fit/rotation/zoom/theme/focus and EPUB flow/typography/section-resume smoke checks in an isolated
  Wry/WebKit profile. The package was not installed over the user's app.

A pre-existing test-fixture issue surfaced during the full client run: two separately generated
EPUB ZIPs could straddle a ZIP timestamp boundary, making the supposedly identical imports have
different hashes. That test now shares the same original Blob across both devices. Production sync
code was not changed. Browser assertions now use the format-specific settings labels and the same
2× PDF zoom workload. Firefox wheel-boundary setup uses a native paginator anchor after proving a
real wheel scroll, avoiding oversized synthetic deltas. Native automation readiness/quoting issues
were corrected before the recorded clean-profile pass.

[Retained report](validation/2026-11-07-reader-modes.json) includes source/log/package hashes, exact
coverage and corpus measurements. [PDF controls](validation/reader-modes-2026-11-07/pdf-facing-settings.png),
[phone settings](validation/reader-modes-2026-11-07/pdf-settings-mobile.png),
[EPUB typography](validation/reader-modes-2026-11-07/epub-typography.png) and
[native PDF](validation/reader-modes-2026-11-07/native-pdf.png) show the final implementation.
The preview at `127.0.0.1:4177` was rebuilt and its waiting offline update activated by closing and
reopening only the agent-created preview tab. No library storage was cleared.

Continuous PDF's six-surface/8-million-pixel steady display budget is not a process-memory ceiling.
Fixed-layout and section-based EPUB limits, oversized PDF source-image failures, physical-device
and assistive-technology certification remain documented in the reader/user guides.
