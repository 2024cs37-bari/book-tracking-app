# Operations and maintenance

## 1. Current repository state

The application scaffold exists and runs locally. Import, local persistence, metadata extraction, the
library UI, storage reconciliation and JSON export are implemented. EPUB/PDF reading, local settings,
progress/restore and production offline app caching are implemented with generated-fixture evidence.
Real-file corpus validation is pending; sync and the server are not implemented.

Implemented commands:

| Command                | Purpose                                                  |
| ---------------------- | -------------------------------------------------------- |
| `npm install`          | Install dependencies (Node.js 20.19+).                   |
| `npm run dev`          | Development server.                                      |
| `npm run build`        | Production build into `dist/`.                           |
| `npm run preview`      | Serve the production build.                              |
| `npm run typecheck`    | Type-check the app, tooling and test projects.           |
| `npm run lint`         | ESLint including Solid reactivity rules.                 |
| `npm run format`       | Prettier write; `format:check` verifies without writing. |
| `npm test`             | Vitest suite (Node plus adapter jsdom tests).            |
| `npm run test:browser` | Playwright Chromium/Firefox/WebKit checks.               |
| `npm run check`        | Full gate; this is what CI runs.                         |

Configuration and deployment for Cloudflare, and any runtime observability beyond the in-app Settings
view, do not exist yet. This document defines requirements for adding them.

## 2. Development workflow

- Use a supported Node.js LTS version (CI pins Node 22) and commit lockfiles.
- Keep local setup reproducible from a clean checkout; `npm ci && npm run check` must pass.
- Do not commit `.env` files, credentials, local databases, book files, or build output.
- Local development requires no Cloudflare credentials yet. When the Worker is added, provide a local
  mode that does not depend on production bindings.
- UI components talk to services and repositories through context; do not import Dexie, OPFS or fetch
  directly from a component.
- Add tests for domain rules, persistence atomicity and import/format behaviour alongside the change.

### Layer rules

`domain` has no dependencies. `data`, `storage` and `reader` depend on `domain`. `services` orchestrates
those layers. `app` wires everything and `ui` renders it. A dependency that points the other way is a
design error, not a style preference.

### Test environment

Tests run in Node with `fake-indexeddb` providing IndexedDB, so real Dexie transactions are exercised
rather than mocked. `tests/support/harness.ts` builds a fully wired stack against a throwaway database,
and `tests/support/fixtures.ts` generates EPUB/PDF/MOBI/FB2/CBZ files in memory. Fixtures are generated
rather than committed: book files cannot be checked in, and generated fixtures state exactly which
structural detail each test depends on. They verify this codebase's parsing, not conformance of
real-world files, so the regression corpus in Phase 1 remains a separate requirement.

Adapter tests opt into jsdom with `@vitest-environment jsdom`; the original suites still run in
Node. EPUB DOM tests use the real pinned parser with a custom-element pagination stand-in because
jsdom has no browser layout. PDF DOM tests replace pdf.js rasterization to inspect cache/cleanup
and page-request ordering. Neither is evidence that jsdom enforces CSP.

`npm run test:browser` builds and serves production assets, runs actual renderer engines through
Chromium, Firefox and Playwright WebKit projects,
injects generated files through `DataTransfer`, and verifies script blocking, EPUB 2/3/RTL, offline
CFI resume, nested NCX/EPUB 3 contents keyboard navigation, missing destinations, fragment CFI
round-trips, PDF painting/rotation/page-size variations, one-canvas/pixel bounds and offline PDF
page/offset resume. Asset cases assert CSS application, generated-font load status and decoded PNG
pixels, plus fixed-layout page geometry/progress/CSP and missing/malformed asset degradation.
`opentype.js` is a test-only font generator using original synthetic glyphs; it is not bundled into
the application. No font/image/book binaries are committed.
Install browsers with `npx playwright install chromium firefox webkit` (CI uses `--with-deps`).
Run a targeted project with `npm run test:browser -- --project=chromium`.
Playwright WebKit on Linux is not evidence for Safari/iOS hardware; native library availability
also varies outside Playwright's supported host distributions.
CI runs both gates. `PLAYWRIGHT_PORT=4175` can select a different test server port.

Real-file acquisition is explicit: `npm run corpus:fetch` writes outside the repository (set
`BOOK_CORPUS_DIR` to an external cache). `npm run test:corpus` runs nine cases per browser using
390×844/DPR-2 desktop contexts, with Chromium-only 4× CPU throttling. CI fetches pinned files and
retains JSON measurements; the normal Vitest quality gate does not fetch the corpus. See
[Reader validation](READER-VALIDATION.md) for license/hash evidence, reproduction, timing/memory
scope and the outstanding physical-hardware protocol.

Expanded PDF cases also attach `pdf-corpus-evidence` JSON: page counts, tested page numbers,
raster aspect/pixel observations and explicit decode-limit outcomes. Tests verify that invalid
or oversized input does not delete originals or persist a failed page. Review the private pdf.js
stream bridge on SDK upgrades.

The production service worker precaches application and renderer assets only; no book bytes or
dynamic library metadata enter CacheStorage. Offline cold navigation/reload requires one completed
online installation. Dev mode has no service worker. Browser CacheStorage/OPFS eviction can still
remove offline availability. IndexedDB schema version 1 is unchanged by this milestone.

## 3. Configuration and secrets

Configuration should be validated at application startup and separated into public build-time settings and server-only secrets. Production secrets belong in the deployment platform's secret manager, not source control. Provide example names and descriptions, never real values. Rotate compromised credentials and ensure logs do not reveal them.

Expected configuration categories, to be concretized with implementation:

- Public app origin and API base URL.
- Cloudflare account/resource bindings for Worker deployment.
- Access audience/issuer configuration.
- Local test/dev toggles that cannot disable production authorization accidentally.

## 4. Schema migrations

- Check in numbered, ordered D1 migrations and explicit local database version migrations.
- Test upgrade from empty state and every supported prior schema fixture.
- Test interrupted/retried migration behavior where platform semantics permit.
- Document backup/export expectations before migrations that may transform or remove data.
- Deploy additive server changes before clients that depend on them; define how stale clients are rejected safely.
- Do not perform destructive data cleanup in a schema migration without an explicit reviewed recovery plan.

## 5. Quality gates

Before a milestone is considered releasable:

- All tests, lint, type checking, and production build pass.
- Import and reader regression corpus passes on supported browsers/webviews.
- Offline behavior is tested with network disabled, including app reload and browser restart.
- Sync tests cover replay, partial failure, cursor safety, conflict handling, and authentication expiry.
- File transfer tests cover interruption, resumed work, checksum mismatch, quota failure, and duplicate content.
- Accessibility keyboard/focus checks and representative screen-size checks pass.
- Dependency licenses and vulnerability notices are reviewed.

## 6. Deployment and release

Use separate development and production resources and least-privilege credentials. Deploy reviewed database migrations before dependent Worker behavior. Verify Access enforcement, private R2, and route exposure before serving private data. Keep static app rollout compatible with supported stored schemas and sync envelope versions.

A release record should include version/commit, migration range, known format limitations, recovery notes, and rollback constraints. Rolling back frontend code must not roll back or corrupt user data.

## 7. Operational signals

Expose local diagnostics to the user without sending telemetry by default:

- Last successful sync and current sync state.
- Count and age of pending changes.
- Transfer queue state and retryable/permanent errors.
- Current pull cursor and schema versions in an exportable diagnostic bundle, with private content excluded.
- Local storage estimates and file presence.

Server monitoring may record request ID, route, duration, response status, rate limiting, and coarse error categories. It must omit tokens, signed URLs, book contents, and annotation text. Any remote telemetry or user analytics requires an explicit privacy decision.

## 8. Backup, export, and restore

Manual JSON/Markdown export and original-file archive are the first supported recovery mechanism. Before production sync, document how to export, validate an export, and restore into a clean client. Test restoration periodically with fixtures. Automated backup is deferred until credentials, encryption, retention, and restore are specified; a backup that has never been restored is not considered validated.

## 9. Incident and recovery runbooks

### Device lost or browser storage evicted

1. Reinstall/open client and authenticate.
2. Bootstrap metadata from server cursor zero (or supported snapshot).
3. Download books on demand or pin them again.
4. Verify counts and report missing objects without silently advancing past errors.

### Sync stuck

1. Inspect pending count, last success, auth, connectivity, and error category.
2. Retry transient work; do not clear the outbox.
3. Export local data if possible before repair/reset.
4. Capture a sanitized diagnostic bundle; never include content or credentials.

### File integrity failure

1. Mark local copy unavailable and preserve metadata/annotations.
2. Re-download or re-import from a trusted original.
3. Verify hash before marking available.
4. Avoid deleting the remote object until its state is independently verified.

### Accidental deletion

Use the tombstone/retention recovery path. Do not restore by directly editing production D1. If remote bytes were explicitly removed, recovery requires another original or a verified backup.

## 10. Cost and quota review

Before launch and periodically, review current Cloudflare plans, D1/R2 limits, browser storage behavior, and any package/API costs. Record observed usage and configure alerts where available. Cost assumptions are not architectural constants; keep service adapters replaceable and exports portable.
