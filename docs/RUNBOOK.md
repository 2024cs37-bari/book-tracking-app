# Local runbook

Practical, copy-paste instructions for running, testing and troubleshooting this repository on a
developer machine. For product/architecture context see [README](../README.md); for CI and release
process see [Operations](OPERATIONS.md); for corpus provenance and measurement scope see
[Reader validation](READER-VALIDATION.md).

Nothing here requires Cloudflare credentials. There is no server, sync or account in the current
codebase.

## 1. Prerequisites

- Node.js **20.19+** (CI pins Node 22). Check with `node --version`.
- npm (ships with Node).
- A Chromium/Firefox/WebKit-capable host for browser checks. On Debian/Ubuntu, install browser
  system libraries with `--with-deps`.

## 2. First-time setup

```bash
npm ci                        # reproducible install from the lockfile
npm run check                 # typecheck + lint + format + tests + production build
npx playwright install chromium firefox webkit
# On supported Linux hosts add --with-deps to install native libraries:
# npx playwright install --with-deps chromium firefox webkit
```

`npm run check` must be green on a clean checkout. It does **not** touch the network beyond
the npm registry.

## 3. Everyday commands

| Command                           | Purpose                                                       |
| --------------------------------- | ------------------------------------------------------------- |
| `npm run dev`                     | Dev server with HMR (no service worker, no offline precache). |
| `npm run build`                   | Production build into `dist/`.                                |
| `npm run preview`                 | Serve the production build (service worker active).           |
| `npm run typecheck`               | Type-check all three TypeScript projects.                     |
| `npm run lint` / `lint:fix`       | ESLint including Solid reactivity rules.                      |
| `npm run format` / `format:check` | Prettier write / verify.                                      |
| `npm test` / `test:watch`         | Vitest unit + jsdom adapter suites.                           |
| `npm run test:browser`            | Playwright production checks (13 cases × 3 engines).          |
| `npm run corpus:fetch`            | Download + hash-verify the external corpus (network).         |
| `npm run test:corpus`             | Real-file and mobile-sized checks (9 cases × 3 engines).      |
| `npm run check`                   | Full local gate; run before pushing.                          |

### Target a single test

```bash
npm test -- --run tests/reader/epub-renderer.dom.test.ts
npm run test:browser -- --project=chromium --grep "fixed-layout"
npm run test:browser -- --project=webkit
```

### Local sync testing (Phase 3)

The sync server (`server/`) runs locally against a local D1 with no Cloudflare
Access in front, so the whole client↔server flow is testable offline. `.dev.vars`
(copied from `.dev.vars.example`) supplies a dev identity; the client points at
the local Worker with the `VITE_SYNC_URL` build variable, passed inline so it never leaks into the
production or test build. `.dev.vars` is git-ignored.

```bash
# One-time: install server deps and create the local D1 schema.
cd server && npm install && cp .dev.vars.example .dev.vars
npm run migrate:local

# Terminal 1 — the sync Worker (binds 127.0.0.1; localhost resolves to ::1 on
# some hosts, which workerd cannot bind).
cd server && npm run dev            # http://127.0.0.1:8787

# Terminal 2 — the client, pointed at the local Worker. Pass VITE_SYNC_URL inline
# (do not use .env.local — Vite would bake it into the test build too).
VITE_SYNC_URL=http://127.0.0.1:8787/api npm run dev -- --host 127.0.0.1   # http://127.0.0.1:5173
```

Then open `http://127.0.0.1:5173`, import a book or make changes, and use
**Settings → Sync → "Sync now"**. Verify the Worker directly with:

```bash
curl -s "http://127.0.0.1:8787/api/v1/sync/pull?since=0&limit=10"
```

To converge two "devices", open the app in a second browser profile (both share
the one local server) and sync each. Reset the local log with
`cd server && npx wrangler d1 execute book_reader_sync --local --command "DELETE FROM changes"`.
Production deploy (real D1 + Access) is in `server/README.md`.

## 4. Manual smoke test (reader)

1. `npm run dev` and open the printed URL (default `http://localhost:5173`).
2. Import a real EPUB and PDF through the "Import books" control.
3. Open a book → **Read**. Verify previous/next, the contents panel, and the settings panel.
4. Change font size, margins and theme; step away and back with **Next/Previous**.
5. Close the reader and reopen — it resumes at the saved position.
6. Confirm the browser console has no page errors.

### Phase 1 feature checks

- **PDF outline:** open a PDF that has a table of contents; the contents panel lists its outline and
  selecting an entry jumps to that page. Entries with an unresolved destination are shown disabled.
- **In-book search:** open the **Search in book** panel, enter a word/phrase, and confirm results
  appear incrementally for both an EPUB and a PDF. Click a result to jump to it; press **Stop** mid
  search and confirm it halts. Each EPUB result shows a non-empty excerpt.
- **PDF cover:** after importing a PDF, its library card and detail page show a generated cover
  thumbnail (first page), not just the format placeholder.
- **Manual metadata editing:** on a book's detail page use **Edit details**, change the title/author/
  publisher/language/ISBN/pages, **Save**, and confirm the values persist after a reload. Blanking
  the title is rejected; a non-numeric page count is rejected.
- **Library filters:** use the **Shelf** selector (Active / Archived / All) and the **Reading status**
  filter. Archive a book and confirm it leaves the Active shelf and appears under Archived/All.
  Mark a book deleted and confirm it is absent from both Active and All.

### Offline check (production only)

Offline resume requires the service worker, which exists only in a production build:

```bash
npm run build
npm run preview
```

Open the preview URL, import a book, open it once, then use DevTools → Network → **Offline** and
reload. The reader should reopen and resume. Development mode (`npm run dev`) has **no** service
worker, so offline reload will not work there.

## 5. Corpus checks

The corpus stores unmodified upstream originals **outside the repository**. Never commit book files.

```bash
export BOOK_CORPUS_DIR=/var/tmp/opencode/reader-corpus   # must be outside the repo
npm run corpus:fetch
npm run test:corpus                       # all three engines
npm run test:corpus -- --project=chromium
```

- Default cache: `book-tracking-corpus-v1` under the OS temp directory.
- Every fetch and read verifies SHA-256; tampered or oversized files fail.
- Files with decode-limit pages (large scans) are verified to fail **visibly**, not to render blank.

## 6. Troubleshooting

### `node_modules` looks corrupted after an interrupted install

```bash
rm -rf node_modules package-lock.json
npm install
```

### Browser tests can't launch / "Executable doesn't exist"

Reinstall browser binaries; add `--with-deps` on Linux:

```bash
npx playwright install --with-deps chromium firefox webkit
```

### Browser tests hit a stale server

Playwright reuses a server on the configured port when not in CI. Stop any stray
`npm run preview` process, or use another port:

```bash
PLAYWRIGHT_PORT=4175 npm run test:browser -- --project=chromium
```

### Offline resume fails locally

- You are probably running `npm run dev`. Use `npm run build && npm run preview`.
- The service worker needs one completed **online** page load before offline works.
- Private/incognito windows and cleared site data remove both the shell and stored book bytes.

### `corpus:fetch` fails to download

- Corporate proxies/VPNs, IPv6-less networks, or upstream rate limiting can cause timeouts;
  the fetch sets a browser-like user agent and a longer IPv4 fallback window.
- Pre-populate `$BOOK_CORPUS_DIR` manually if a host is unreachable. The **hash must match** the
  manifest in `tooling/corpus-manifest.ts`, or the fetch/read will refuse the file.
- `403`/timeouts are upstream/environmental; the pinned hashes and test scope are unchanged.

### PDF page shows a visible error instead of content

Some corpus pages contain source images above the 4,000,000-pixel decode cap. They are expected to
fail visibly and preserve your last good position. See
[ADR 0005](decisions/0005-pdf-render-errors.md). This is a documented limit, not a bug to "fix" by
enlarging the cap without a memory review.

### App never renders / blank page

The app awaits IndexedDB before first paint. If IndexedDB is unavailable (some private modes), a
fatal message is shown. Check the console; clearing site data and reloading usually recovers.

## 7. Repository invariants to respect

- `domain` depends on nothing; `data`/`storage`/`reader` depend on `domain`; `services` orchestrates;
  `ui` renders and must not import Dexie, OPFS or foliate-js directly.
- The Dexie metadata schema is at **v2** (adds Phase 2 collections and reading history). Each
  released version is frozen: never edit a shipped `version(n).stores(...)` block in place — add a
  new version. The separate binary file store is its own IndexedDB at **v2**.
- Every replicated mutation writes its outbox row in the same transaction.
- Never delete original bytes implicitly; archive/tombstone only.
- Never commit book files, secrets, build output or local databases.
- Vendored `vendor/foliate-js` is pinned; document any local patch in `vendor/PROVENANCE.md`.

## 8. Before you push

```bash
npm run check
npm run test:browser                 # or at least --project=chromium locally
# For reader/corpus changes, also run:
BOOK_CORPUS_DIR=/var/tmp/opencode/reader-corpus npm run test:corpus
```

CI runs `npm run check`, `npm run corpus:fetch`, `npm run test:browser` and `npm run test:corpus`
on a clean Ubuntu runner with Node 22.
