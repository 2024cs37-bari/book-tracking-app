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

**Status:** In progress. Reader milestone implemented and verified with generated fixtures in
Chromium; full Phase 1 corpus and remaining features are not complete.

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
- Library view with search, sort, status editing, archive/restore, soft delete.
- Storage reconciliation report and JSON metadata export.
- 130 Vitest tests covering the original foundation plus DOM adapter lifecycle/bounds and reader
  progress/debounce/outbox integration; 13 browser cases across Chromium, Firefox and Playwright
  WebKit projects (39 checks).
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

**Next milestone selected: reader usability and validation (Phase 1 completion).**
EPUB contents navigation and the generated asset/fixed-layout slice are implemented. Next establish
a legally usable real-file corpus and mobile memory measurements, and expand fixed-layout spread,
SVG and obfuscated-font cases. Finish PDF covers and manual metadata editing alongside validation.
Phase 2 bookmarks/annotations will build on these navigation and locator guarantees.

Remaining:

- PDF outline UI and in-book search.
- Cover generation for PDFs.
- Manual metadata editing.
- Real-file format corpus, fixed-layout spreads/SVG, obfuscated fonts and mobile memory profiling.
  The cross-browser generated-file suite covers offline reload; broader platform storage behavior,
  browser restart and actual Safari/iOS/Android hardware validation remain pending.

Acceptance criteria (unchanged):

- Import, close, restart, and reopen supported EPUB/PDF without a network.
- A crashed/failed import can be reconciled without corrupting metadata or bytes.
- Duplicate content does not create a second file identity.
- Export can be produced while offline and can be validated by a clean import tool/test.
- Unsupported/DRM-protected/malformed cases fail clearly and safely.

## Phase 2 — Collections and reading history

**Dependencies:** Phase 1 local data boundaries.

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
