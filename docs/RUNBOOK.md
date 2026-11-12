# Local development runbook

## Setup

Use Node.js 20.19+ (current Node LTS recommended; CI uses Node 22).

```bash
npm ci
npm ci --prefix server
npm run check:all
npx playwright install chromium firefox webkit
npm run dev
```

On supported Debian/Ubuntu hosts, browser installation can use `--with-deps`. Other distributions
may need equivalent native libraries. Do not delete the lockfile to repair an interrupted install;
rerun `npm ci` to reproduce the committed dependency tree.

The default frontend needs no account/server. Import original files through the Library picker.
Generated fixtures live in `tests/support/fixtures.ts`; never add personal books or secrets to Git.

## Verification commands

| Command                                      | Purpose                                                          |
| -------------------------------------------- | ---------------------------------------------------------------- |
| `npm run docs:check`                         | Check local Markdown link targets without network access         |
| `npm run check`                              | Client typecheck, lint, formatting, tests and production build   |
| `npm run check:server`                       | Server typecheck and unit/local Worker integration tests         |
| `npm run check:all`                          | Both checks; install both packages first                         |
| `npm run test:sync-browser`                  | Three isolated clients with actual local Worker/D1/R2            |
| `npm run test:browser`                       | Production browser regressions                                   |
| `npm run test:browser -- --project=chromium` | One browser engine                                               |
| `npm run corpus:fetch`                       | Explicit network fetch/hash check of external licensed originals |
| `npm run test:corpus`                        | Real-file checks and mobile-sized desktop measurements           |

For focused tests, pass filenames: `npm test -- tests/services/offline-storage.test.ts`.
Use an unused `PLAYWRIGHT_PORT` if a development preview already occupies the default port.
Browser tests should run against the matching build, not an old reused server.

## Offline smoke test

```bash
npm run build
npm run preview
```

1. Open the preview while online and wait for offline caching to report ready.
2. Import/open an EPUB and a PDF, turn pages, add a bookmark/highlight and close/reopen.
3. Disable networking, reload and verify contents, navigation and the saved position.
4. Re-enable networking. If a new version is waiting, close all app tabs/windows and reopen.

Vite development has no production precache. Pinned files cannot survive manual clearing of site
data. [Offline app](OFFLINE-APP.md) explains update/cache behavior.

## Local sync

The server supports loopback-only development identity and local D1/R2. No production credentials
are needed. Follow the exact current setup in [server README](../server/README.md). Typical separate
terminals use a Worker on 127.0.0.1:8787 and a frontend on 127.0.0.1:5173. Configure the Worker
`CLIENT_ORIGIN` to the exact frontend origin and supply its documented local dev identity.

```bash
# Frontend terminal; do not persist this in .env.local where test builds would inherit it.
VITE_SYNC_URL=http://127.0.0.1:8787/api npm run dev -- --host 127.0.0.1
```

The API base ends in `/api`. Cross-origin requests require the build's configured origin in CSP and
an exact server CORS origin. Use two separate browser profiles/contexts to test separate devices.
Settings shows background status/queues and allows pause/retry. Import on one device, observe
metadata on the other, then explicitly download the original and read it.

Do not test local migrations against production, upload personal books in test runs, or set
`DEV_USER` on a deployed route. A deployed Access login must be separately verified.

## Recovery exercise

1. In Settings, download a portable backup while all originals are local and within its limits.
2. Open a fresh browser profile, select that backup and inspect the validated recovery preview.
3. Apply missing data and verify metadata, collections, annotations and actual reading.
4. Repeat with a JSON-only export and verify the UI honestly reports originals missing until
   re-import/download. Re-import must preserve edited metadata and restore local availability.
5. Keep an external original/metadata copy; deleting a browser profile must not delete the backup.

[Backup](BACKUP.md) describes additive recovery, bounds, canonical identities and failure handling.

## Troubleshooting

- **Blank/fatal startup:** IndexedDB may be blocked. Inspect the displayed error and browser storage
  settings. Export any recoverable data before clearing site data.
- **Memory-only warning:** originals will not survive closing; save originals/export first. An
  IndexedDB fallback notice is different and should not claim memory-only loss.
- **Offline reload fails:** use production preview, complete initial caching, and inspect the
  app-shell status. Private mode/eviction/cleared site data may have removed cached assets.
- **Sync auth required:** sign in through the configured Access application, then retry. Preserve
  the local outbox; do not clear it to make the pending count disappear.
- **Sync CSP/CORS error:** verify VITE_SYNC_URL (including `/api`), HTTPS/loopback policy and exact
  CLIENT_ORIGIN. Never resolve it by allowing every origin or disabling book CSP.
- **Failed upload/download:** inspect queue error and limits. A hash failure is not success. Retry
  after restoring network/auth; use original export for files above transfer limits.
- **Missing original:** download from a configured server or re-import identical original bytes.
- **PDF page error:** some source images exceed the decode budget; preserve position and navigate
  to another page. Do not raise caps without memory measurements.
- **Save error:** use reader retry and keep the app open if possible; a local pending-intent journal
  improves recovery but cannot guarantee it when browser storage fails.
- **Corpus fetch fails:** upstream availability is external. Preserve pinned hashes and report the
  failed source; never silently substitute different bytes to obtain a passing result.

## Work boundaries

Keep migrations additive; entity/outbox writes and pull-page/cursor writes are atomic. Original
cleanup must respect leases, pins, references and verified remote copies. Avoid reading/logging
credentials or private library content. Vendored engine patches belong in `vendor/PROVENANCE.md`.
Run appropriate focused checks during a slice and the combined gate before release.
