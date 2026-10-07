# Personal Book Reader

Offline-first, cross-device reading and library management for one person.

> **Project status:** Documentation baseline. The runtime has not been scaffolded yet.

Personal Book Reader is designed to make a private book collection readable and recoverable across web, mobile PWA, and desktop platforms without making the network a dependency for everyday reading. Local storage is the source of truth for the user interface; Cloudflare provides synchronization, durable file storage, and authenticated access.

## Product direction

- Import and read DRM-free EPUB and PDF books first.
- Validate MOBI and AZW3 support against real files before promising it as a stable feature.
- Keep reading, progress updates, and library management usable offline.
- Preserve original files and make data exportable at any time.
- Use one shared SolidJS codebase, with a PWA as the first delivery target and thin Tauri wrappers later.
- Keep recurring operating costs near zero for a single user while avoiding assumptions about permanently fixed free-tier limits.

The product deliberately does **not** include social sharing, multi-user collaboration, analytics tracking, or a custom document-rendering engine.

## Current phase

The project is in the documentation and architecture phase. The first implementation milestone is a local EPUB/PDF reader with import, metadata, library browsing, progress, and export. Sync and selective offline storage follow only after the local data and file boundaries are stable.

There is no application command to run yet. See the [roadmap](docs/ROADMAP.md) and [operations guide](docs/OPERATIONS.md) for the planned development workflow.

## Architecture at a glance

```text
SolidJS UI / PWA / Tauri shell
            |
     local repositories
   Dexie + IndexedDB   OPFS/filesystem
            |
       sync engine
            |
  Cloudflare Access -> Worker/Hono -> D1 + private R2
```

The application talks to a renderer abstraction rather than directly to a format engine. EPUB/PDF support is the initial baseline; MOBI/AZW3 compatibility is a validation spike. See [Architecture](docs/ARCHITECTURE.md), [Storage](docs/STORAGE.md), and [Import and Reader](docs/IMPORT-AND-READER.md).

## Documentation map

| Document | Purpose |
| --- | --- |
| [Product](docs/PRODUCT.md) | Scope, user experience, requirements, and terminology |
| [Architecture](docs/ARCHITECTURE.md) | System boundaries and technology choices |
| [Data model](docs/DATA-MODEL.md) | Entities, schema, lifecycle, and migrations |
| [Sync](docs/SYNC.md) | Offline synchronization protocol and conflict behavior |
| [Storage](docs/STORAGE.md) | Local database, files, quotas, and selective offline |
| [Backend](docs/BACKEND.md) | Cloudflare services, API, authentication, and security boundaries |
| [Import and reader](docs/IMPORT-AND-READER.md) | File ingestion, rendering, locators, and format validation |
| [Operations](docs/OPERATIONS.md) | Development, release, backup, diagnostics, and recovery |
| [Roadmap](docs/ROADMAP.md) | Phases, dependencies, and acceptance criteria |
| [Technology baseline](docs/decisions/0001-technology-baseline.md) | Initial architecture decisions |
| [Data lifecycle](docs/decisions/0002-data-lifecycle.md) | Archive, deletion, tombstones, and recoverability |
| [Archived initial requirements](docs/archive/initial-requirements.md) | Original planning document retained for history |

## Repository status

This repository intentionally starts with documentation rather than generated framework code. That keeps the storage, sync, and recovery contracts reviewable before implementation creates compatibility commitments.

When the application is scaffolded, setup instructions will be added here and to [CONTRIBUTING.md](CONTRIBUTING.md). Until then, documentation changes can be reviewed with any Markdown viewer and standard Git tooling.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. At this stage, changes should improve clarity, identify assumptions, or make an implementation contract testable. New features should update the relevant product, architecture, data-model, sync, and roadmap documents together.

## Security and privacy

This is a private library, not a public catalog. The project has no analytics or third-party tracking requirement. Security expectations and vulnerability reporting are documented in [SECURITY.md](SECURITY.md).

## License

No license has been selected yet. Until a license is added, all rights are reserved by the repository owner. A license decision should be made before accepting external code contributions.
