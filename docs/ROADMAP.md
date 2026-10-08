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

**Status:** In progress. Foundation and import pipeline are implemented; rendering is not.

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
- 117 unit tests covering domain rules, persistence atomicity, format detection, metadata extraction,
  import outcomes and storage reconciliation.

Remaining:

- EPUB renderer adapter (foliate-js) behind the `Renderer` interface.
- PDF renderer adapter (pdf.js) with visible-page rendering and bounded cache.
- Reader shell: progress capture and restore, TOC.
- Cover generation for PDFs.
- Manual metadata editing.
- OPFS behaviour verified in real browsers, and the format regression corpus established.

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
