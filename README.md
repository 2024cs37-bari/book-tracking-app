# Personal Book Reader

Offline-first, cross-device reading and library management for one person.

> **Project status:** Phase 1 (local reader MVP) in progress. Import, storage, metadata and the
> library UI work end to end. The reader milestone adds local EPUB/PDF reading and offline resume.
> Both formats remain experimental pending real-file corpus validation.

Personal Book Reader keeps a private book collection readable and recoverable across web, mobile PWA
and desktop without making the network a dependency. Local storage is the source of truth for the
interface; Cloudflare provides synchronization and durable file storage in later phases.

## What works today

- **Import** EPUB, PDF, MOBI, AZW3, FB2 and CBZ files through the file picker.
- **Content-addressed storage**: files are hashed with a streaming SHA-256 and stored under that
  hash, so re-importing identical bytes links to the existing book instead of duplicating it.
- **Metadata extraction** from the EPUB package document (title, author, language, publisher, ISBN,
  cover) and, best-effort, from the PDF information dictionary (title, author, page count). Files
  with unreadable metadata are still imported, with the title derived from the filename and flagged
  as incomplete.
- **Format detection by content** rather than extension, including distinguishing KF8 (AZW3) from
  older MOBI.
- **Library view** with search across title/author/publisher/ISBN, sorting, reading status, and
  status editing.
- **Local persistence** in IndexedDB with an outbox: every mutation is written together with a change
  record, ready for the sync engine.
- **Lifecycle management**: archive and restore, plus soft delete with tombstones. Nothing removes
  original bytes implicitly.
- **Storage reconciliation** that reports unreferenced files and books missing their local file, with
  an explicit cleanup action.
- **JSON export** of library metadata, generated entirely on the client.
- **Reader** at `/read/:id`: EPUB via pinned upstream foliate-js, PDF via pdf.js directly,
  previous/next navigation, font size/PDF zoom, line height, margins and themes.
- **Progress**: EPUB CFI or zero-based PDF page/vertical offset plus normalized fraction,
  debounced local saves with an atomic outbox row, and restoration on reopen.
- **Offline app shell** in production builds: service-worker precache includes renderer modules,
  PDF worker, fonts and decoding assets. Book bytes remain in the file store.
- **Content security policy**: app scripts restricted to self; EPUB content gets a stricter
  no-script/no-network policy before rendering. A hostile generated EPUB is browser-tested.

## What is deliberately not implemented yet

- No sync, no server, no accounts. The outbox grows locally and is reported in Settings.
- No annotations, shelves, tags, statistics, or selective offline pinning.
- No reader TOC UI or in-book search. Real-file EPUB/PDF corpus, mobile memory profiling and
  Firefox/WebKit validation remain pending. Generated-fixture checks run in Chromium.
- MOBI/AZW3 are importable but unvalidated for reading; FB2/CBZ are importable with reading
  explicitly marked as unimplemented.
- DRM-protected books are unsupported and always will be.

## Getting started

Requires Node.js 20.19 or newer.

```bash
npm install
npm run dev        # start the development server
```

Open the printed URL and import a book. Everything stays in the browser.

## Commands

| Command                | Purpose                                                   |
| ---------------------- | --------------------------------------------------------- |
| `npm run dev`          | Development server with hot reload                        |
| `npm run build`        | Production build into `dist/`                             |
| `npm run preview`      | Serve the production build locally                        |
| `npm run typecheck`    | Type-check app, tooling and test projects                 |
| `npm run lint`         | ESLint, including Solid-specific reactivity rules         |
| `npm run lint:fix`     | ESLint with automatic fixes                               |
| `npm run format`       | Format with Prettier                                      |
| `npm run format:check` | Verify formatting without writing                         |
| `npm test`             | Run the unit test suite once                              |
| `npm run test:watch`   | Run tests in watch mode                                   |
| `npm run test:browser` | Chromium checks against a production build (Playwright)   |
| `npm run check`        | Full gate: typecheck, lint, format check, tests and build |

CI runs `npm run check` and `npm run test:browser`. Install the test browser once with
`npx playwright install chromium`. Run both gates before pushing reader changes.
Offline navigation/reload needs a production build (`npm run build && npm run preview`)
and a completed first-online service-worker installation; development mode has no precache.

## Project structure

```text
src/
  app/         Application shell: bootstrap, service wiring, routes
  domain/      Pure types and rules (HLC, locators, books, progress, enums, hashing identity)
  data/        Dexie schema, row types, and repositories including the outbox
  storage/     File stores (OPFS, memory), streaming SHA-256, mime mapping, reconciliation
  reader/      Renderer contract, EPUB/PDF adapters, content-based format detection
  services/    Use cases: import, metadata, export, reader sessions and progress
  ui/          Solid components
  styles/      Global stylesheet
tests/         Vitest suites mirroring src/, plus fixtures and a harness
docs/          Product, architecture and operational documentation
vendor/        Pinned foliate-js source snapshot and third-party license notices
tooling/       Renderer assets and offline app-shell build integration
```

Layer rules: `domain` depends on nothing, `data`/`storage`/`reader` depend on `domain`, `services`
orchestrates the layers, and `ui` talks to services and repositories through context rather than
importing storage or database code directly.

## Architecture at a glance

```text
SolidJS UI / PWA  →  repositories (Dexie + IndexedDB)  →  outbox
                  →  file store (OPFS, memory fallback)
                  →  renderer registry (EPUB / PDF adapters)
                        ↓ later phase
                  Cloudflare Access → Worker/Hono → D1 + private R2
```

See [Architecture](docs/ARCHITECTURE.md) for the boundaries, [Data model](docs/DATA-MODEL.md) for the
schema, and [Import and reader](docs/IMPORT-AND-READER.md) for the import pipeline and format policy.

## Documentation map

| Document                                                              | Purpose                                             |
| --------------------------------------------------------------------- | --------------------------------------------------- |
| [Product](docs/PRODUCT.md)                                            | Scope, user experience, requirements, terminology   |
| [Architecture](docs/ARCHITECTURE.md)                                  | System boundaries and technology choices            |
| [Data model](docs/DATA-MODEL.md)                                      | Entities, schema, lifecycle, migrations             |
| [Sync](docs/SYNC.md)                                                  | Synchronization protocol and conflict behaviour     |
| [Storage](docs/STORAGE.md)                                            | Local database, files, quotas, selective offline    |
| [Backend](docs/BACKEND.md)                                            | Cloudflare services, API, authentication            |
| [Import and reader](docs/IMPORT-AND-READER.md)                        | Ingestion, rendering, locators, format validation   |
| [Operations](docs/OPERATIONS.md)                                      | Development, release, backup, diagnostics, recovery |
| [Roadmap](docs/ROADMAP.md)                                            | Phases, dependencies, acceptance criteria           |
| [Technology baseline](docs/decisions/0001-technology-baseline.md)     | Initial architecture decisions                      |
| [Data lifecycle](docs/decisions/0002-data-lifecycle.md)               | Archive, deletion, tombstones, recoverability       |
| [Reader engines](docs/decisions/0003-reader-engines.md)               | Pinned provenance, CSP and format evidence          |
| [Archived initial requirements](docs/archive/initial-requirements.md) | Original planning document, kept for history        |

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md). Changes should keep the documentation, tests and code
consistent; behaviour changes need tests, and any change to persisted data needs a migration.

## Security and privacy

This is a private library, not a public catalogue. There is no analytics or third-party tracking, no
public object storage, and no upload until sync is configured. See [SECURITY.md](SECURITY.md).

## License

No license has been selected yet. Until one is added, all rights are reserved by the repository owner,
and a license decision should be made before accepting external code contributions.
