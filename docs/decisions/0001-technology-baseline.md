# ADR 0001: Technology baseline

- **Status:** Accepted as initial implementation baseline; all third-party capabilities remain subject to validation.
- **Reader refinement:** [ADR 0003](0003-reader-engines.md) pins engine provenance and the CSP boundary.
- **Date:** 2026-10-07
- **Decision owners:** Project maintainer

## Context

The project is a single-user, offline-first reader for web/PWA and later desktop. It needs a small UI bundle, durable local mutations, replaceable storage, private cloud sync, and rendering engines that should not leak through the app's domain layer. No application code exists yet, so this is the point to set a coherent baseline before implementation.

## Decisions

1. Use **SolidJS + Vite + TypeScript** for the shared client.
2. Use **Dexie over IndexedDB** for the first browser metadata database. Put all database access behind repository interfaces and version all schema migrations.
3. Use a **file-store interface** with OPFS as the preferred browser implementation where verified and a narrow platform-specific fallback; use the Tauri app data directory for desktop.
4. Ship **PWA first**. Add a thin **Tauri desktop** wrapper after browser boundaries stabilize. Defer native mobile packaging until PWA limitations are demonstrated.
5. Use **Cloudflare Pages, Workers/Hono, D1, private R2, and Cloudflare Access** for the planned remote service, subject to verifying current platform capabilities, security configuration, quotas, and costs.
6. Keep format engines behind a `Renderer` interface. Target EPUB and PDF first; treat MOBI/AZW3 as experimental until regression-tested.
7. Defer client-side encryption. Private authenticated storage is the baseline, but it is not end-to-end encryption.

## Rationale

- Dexie reduces initial browser complexity and matches an offline PWA without requiring a WASM binary/OPFS database capability. Repository boundaries preserve the option to reconsider storage.
- A shared web UI minimizes platform-specific implementation and is compatible with PWA and Tauri.
- Cloudflare components cover static delivery, authenticated APIs, relational metadata, and object storage with a small service count.
- An engine abstraction prevents format support and version changes from spreading through UI and data logic.
- PWA-first avoids native-store overhead until there is evidence it is necessary.

## Consequences

- IndexedDB is not identical to D1 SQL; the logical schema is shared, but query implementations and migrations are platform-specific.
- Browser storage may be evicted and varies by platform. The app must request persistence, expose availability, and support re-download/rebuild.
- Tauri integration needs platform review and may require separate file adapters.
- Cloudflare Access must be verified on all Worker routes; a front-end gate alone is insufficient.
- Real service pricing and browser/library compatibility must be checked before launch.
- User files are not encrypted against the storage provider. If that privacy requirement changes, encryption and key recovery need a new ADR.

## Revisit when

- IndexedDB transactions/performance or query needs demonstrate that SQLite WASM is materially better.
- Required browser support cannot provide acceptable OPFS/file handling.
- Tauri platform behavior creates material divergence.
- Cloudflare service constraints or cost no longer fit the single-user use case.
- Format corpus testing reveals that an engine cannot satisfy reader requirements.
