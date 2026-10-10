# Roadmap

The roadmap is dependency-driven. A later phase must not hide unresolved storage, rendering, or recovery behavior from an earlier phase.

## Phase 0 — Documentation and contracts

**Status:** Complete

Deliverables:

- Product scope and terminology.
- Architecture and technology decisions.
- Local/remote data model and lifecycle rules.
- Sync and file-transfer contracts.
- Format validation plan, operations expectations, and contribution rules.

Exit criteria: documentation is internally consistent, assumptions are marked, and implementation decisions can be reviewed without a generated app.

## Phase 1 — Local EPUB/PDF reader MVP

**Status:** In progress. Reader milestones verified with generated fixtures in Chromium, Firefox
and Playwright WebKit; full Phase 1 real-file corpus and remaining features are not complete.

Done:

- SolidJS/Vite/TypeScript scaffold with a full quality gate (typecheck, lint, format, tests, build)
  and CI.
- Dexie schema (v1), repositories, and an outbox written in the same transaction as every replicated
  mutation.
- Streaming SHA-256 and content-addressed file storage with OPFS, plus a probed memory fallback that
  is surfaced in the UI rather than hidden.
- Format detection by content, including MOBI vs KF8 (AZW3) discrimination.
- Import pipeline: hashing, dedup by content hash, EPUB (OPF) and PDF (Info dictionary) metadata
  extraction, cover storage, incomplete-metadata fallback to filename.
- Library view with search, sort, reading-status filter, an archived-books shelf, status editing,
  archive/restore, soft delete, and manual metadata editing.
- Storage reconciliation report and JSON metadata export.
- 197 Vitest tests across 23 files covering the original foundation plus DOM adapter
  lifecycle/bounds, reader progress/debounce/outbox integration, metadata editing, PDF outline
  conversion, PDF cover rendering and cancellable in-book search; 13 browser cases across Chromium,
  Firefox and Playwright WebKit projects (39 checks).
- CSP before rendering, with a hostile generated EPUB demonstrating script blocking.
- Vendored upstream foliate-js at `78914aef4466eb960965702401634c2cb348e9b1` (ADR 0003).
- EPUB/PDF adapters, `/read/:id`, reader settings, native locators plus fractions, debounced progress
  and offline close/reopen/reload resume. PDF keeps one visible canvas with a 4-million-pixel cap.
- Production app-shell precache, including local renderer assets and the PDF worker.
- EPUB TOC UI: nested NCX/navigation entries, fragment-to-CFI translation, native keyboard controls,
  unavailable destinations disabled, and generated-fixture offline navigation/resume evidence.
- Generated EPUB asset/layout corpus: decoded PNG pixels, embedded CSS, a synthetic OpenType font,
  single-page fixed layouts, missing/malformed image/font handling, script blocking and offline resume.
- CI browser projects for Chromium, Firefox and Playwright WebKit; fixture bytes and font glyphs
  are generated in memory, with no book/image/font binaries committed.
- CSP blob-stylesheet allowance and documented upstream paginator lifecycle guards, with a
  deterministic late-font-ready teardown regression.
- Probed durable IndexedDB binary fallback when OPFS cannot write, and bounded optional persistence
  permission waiting (ADR 0004); the released metadata schema remains unchanged.
- External checksum-pinned Moby-Dick, SVG in Spine and Hello World PDF corpus, without committing
  book files; mobile-sized checks and generated 240-page image-PDF resource measurements.
- Chapter-level package-CFI restoration corrected using the real Moby-Dick TOC as a regression.
- Five additional pinned PDFs: long embedded-font text, scans, mixed page sizes, rotation and an
  invalid structure. Corpus suite has nine cases per browser (27 checks) alongside 39 generated
  browser checks. Oversized-image cases assert explicit limits and recovery, not full readability.
- Per-document pdf.js stream-error guard, failed-page progress protection and cancellation/resize
  handling (ADR 0005); no schema changes or original-file deletion.
- PDF outline/TOC extraction (pdf.js destinations resolved to page locators; unresolved entries kept
  but disabled), lazy first-page PDF cover rendering bounded by edge and pixel caps, cancellable
  in-book search for both EPUB (via vendored foliate-js) and PDF (page text scan), and manual
  metadata editing wired to the transactional `updateMetadata` outbox path.

Evidence: [CI run 37742014444](https://github.com/2024cs37-bari/book-tracking-app/actions/runs/37742014444)
on 2026-10-08 passed the full quality gate and all 39 browser checks. The local quality gate
(typecheck, lint, format, build) now passes with 197 Vitest tests across 23 files, and the
generated-file browser suite has been re-run against the new reader/library features — 42 checks
pass on Chromium and Firefox. WebKit cannot launch on the current Arch dev host (missing system
libraries), so WebKit/Safari remains CI- and hardware-validated only. The real-file corpus suite has
not been re-run since the feature work below and should be before this milestone is declared complete.

**Next milestone selected: reader usability and validation (Phase 1 completion).**
The remaining feature work for Phase 1 (PDF outline, in-book search, PDF covers, manual metadata
editing, reading-status filter and an archived-books shelf) is now implemented and unit-tested.
EPUB contents, generated assets and selected real-file corpus slices are implemented. Desktop
mobile-sized measurements are recorded in [Reader validation](READER-VALIDATION.md). What remains is
validation, not features: physical-device measurements, further PDF/oversized-image variants, and
expanded obfuscated-font and layout coverage. Phase 2 bookmarks/annotations will build on these
navigation and locator guarantees.

Remaining:

- Re-run the **real-file corpus** suite against the new reader features (PDF outline navigation,
  in-book search, generated covers) and extend it to cover those paths. The generated-file
  cross-browser suite has been re-run and extended (new `library`, `metadata`, `pdf-outline` and
  `search` specs) and passes on Chromium and Firefox.
- Real-file format corpus, fixed-layout spreads/SVG, obfuscated fonts and mobile memory profiling.
  The cross-browser generated-file suite covers offline reload; broader platform storage behavior,
  browser restart and actual Safari/iOS/Android hardware validation remain pending (WebKit cannot
  run on the local dev host).

Acceptance criteria (unchanged):

- Import, close, restart, and reopen supported EPUB/PDF without a network.
- A crashed/failed import can be reconciled without corrupting metadata or bytes.
- Duplicate content does not create a second file identity.
- Export can be produced while offline and can be validated by a clean import tool/test.
- Unsupported/DRM-protected/malformed cases fail clearly and safely.

## Phase 2 — Collections and reading history

**Dependencies:** Phase 1 local data boundaries.

**Status:** In progress. The data layer landed first: Dexie schema **v2** (annotations, shelves,
shelfBooks, tags, bookTags, sessions) with a tested v1→v2 migration, repositories that co-write the
outbox for every replicated mutation (membership tracked by add/remove HLC, deletes tombstoned),
reading-session recording with derived statistics, and export extended to every new entity. The UI
has since landed too: shelf/tag management (in Settings) and tag/shelf membership plus manual
metadata editing on the book page, a reading-status + shelf/tag library filter, a reading-stats
view, and backup **restore** (the recovery counterpart to export: a snapshot `bulkPut` that writes
no outbox and refuses a newer schema version), and reader annotations — bookmarks, notes and
**EPUB text-selection highlights** (drawn via foliate's overlayer and re-applied per section on
navigation). The reader also turns pages with the arrow keys and exports a book's bookmarks,
highlights and notes as a Markdown file. Still to come in Phase 2: **PDF highlights**, which need a
selectable text layer over
the canvas-only PDF renderer; the data model, reader UI and EPUB path are already in place, so this
is a renderer addition gated by `PdfRenderer.supportsHighlights`.

Deliverables:

- Shelves, tags, status workflows, archive view.
- Annotations, bookmarks, TOC, and cancellable in-book search where renderer support is reliable.
- Reading sessions and local statistics.
- Progress divergence model/UI prepared for future sync.

Acceptance criteria: all features work offline, are covered by migration tests, and export includes them.

## Phase 3 — Authenticated sync backend

**Dependencies:** stable schema, export, local mutation/outbox contracts.

Deliverables:

- Cloudflare Access + Worker/Hono + D1 migrations.
- Versioned push/pull API with runtime validation, idempotency, cursors, and bounded retries.
- HLC implementation and deterministic conflict rules.
- Pull bootstrap, auth expiry behavior, diagnostics, and integration tests.

Acceptance criteria: two clients converge after reordering, replay, partial failure, offline periods, and conflict prompts; no local mutation is lost.

## Phase 4 — Durable file transfer and PWA offline controls

**Dependencies:** authenticated metadata sync and tested storage abstraction.

Deliverables:

- Private R2 upload/download authorization and completion flow.
- Resumable transfer queue, checksum verification, duplicate handling, and abandoned-upload cleanup policy.
- Service worker/app-shell updates and storage persistence request.
- Pinning, LRU eviction, storage budget/status, remote-only indicators.

Acceptance criteria: interrupted transfers resume or recover cleanly; pinned/current content is protected; browser quota failure is visible; metadata remains usable without file bytes.

## Phase 5 — Desktop delivery

**Dependencies:** stable web UI and repository/file-store interfaces.

Deliverables:

- Tauri wrapper for Linux, Windows, and macOS.
- Filesystem adapter, import/drop integration, update strategy, and platform security review.
- Desktop-specific regression and packaging documentation.

Acceptance criteria: desktop uses the same domain behavior, stores files durably in its app data area, and does not require a separate feature fork.

## Phase 6 — Hardening and optional capabilities

Deliverables:

- Performance profiling and targeted optimization.
- Automated backup only after restore is proven.
- MOBI/AZW3 promotion from experimental only if corpus and platform tests pass.
- Consider native mobile packaging or client-side encryption only with a new decision record and recovery design.
- Security, accessibility, dependency, and cost reviews.

## Deferred indefinitely unless justified

Social/public sharing, multi-user collaboration, DRM circumvention, custom rendering engine, recommendations, nested folders, and mandatory online enrichment.

## Milestone change policy

A milestone is not complete because code exists. It requires its acceptance criteria, migration/restore story, documented limitations, and regression coverage. If an assumption fails, update the relevant ADR and roadmap rather than silently widening scope.
