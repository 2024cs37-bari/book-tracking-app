# Architecture

## 1. Status and decision principles

This is the initial architecture baseline for a single-user application. Decisions favor understandable local behavior, small operational footprint, replaceable adapters, and recoverability. Details that depend on browser or library behavior remain validation tasks rather than assumed guarantees.

See [ADR 0001](decisions/0001-technology-baseline.md) for technology choices and [ADR 0002](decisions/0002-data-lifecycle.md) for data lifecycle rules.

## 2. System context

```text
┌──────────────────────────── Client ────────────────────────────┐
│ SolidJS UI (Vite)                                               │
│  ├─ Library, settings, reader shell                              │
│  ├─ Renderer adapters: EPUB / PDF                                │
│  ├─ Domain services and repositories                              │
│  ├─ Local metadata DB: Dexie + IndexedDB                         │
│  ├─ Local files: OPFS (web) / app filesystem (Tauri)              │
│  └─ Sync and transfer queues (later phase)                       │
└──────────────────────────────┬─────────────────────────────────┘
                               │ HTTPS; asynchronous sync
┌──────────────────────────────▼─────────────────────────────────┐
│ Cloudflare Access → Worker API (Hono) → D1 + private R2         │
└────────────────────────────────────────────────────────────────┘
```

The local application can import, browse, read locally present books, change metadata, and save progress with no server. Server unavailability affects cross-device sync and remote-only files, not local reading or mutations.

## 3. Technology baseline

| Concern | Baseline | Boundary / caveat |
| --- | --- | --- |
| UI and app | SolidJS + Vite + TypeScript | UI depends on domain/repository interfaces, not storage implementation. |
| Local metadata | Dexie over IndexedDB | Start with transactions and explicit schema versions; hide behind repositories. |
| Web files | OPFS where supported | Capability-detect and provide a tested fallback; browser quotas and eviction vary. |
| Desktop files | Tauri app data directory | Native file access is isolated behind a file-store interface. |
| Web delivery | PWA | Service worker caches app shell, not the entire library by default. |
| Desktop | Tauri | Add after core UI and storage contracts stabilize. |
| EPUB | foliate-js adapter, subject to validation | Pin a version and keep it behind `Renderer`. |
| PDF | pdf.js adapter | Render visible pages and cap memory/cache. |
| API | Cloudflare Worker + Hono | Validate identity at the trust boundary and validate request schemas. |
| Metadata DB | Cloudflare D1 | Migrations are checked in and applied deliberately. |
| Files | Private Cloudflare R2 | Never expose public object URLs. |
| Authentication | Cloudflare Access | Worker verifies Access identity; deployment must ensure no bypass route exists. |

Cloudflare and library limits change. Recheck pricing, quotas, browser compatibility, and package licenses before production deployment.

## 4. Client layers

### Presentation

SolidJS components render library, reader, settings, transfer status, and conflict decisions. Components call application services and observe local state. They must not contain SQL/IndexedDB logic or make the UI wait for network calls.

### Domain and application services

Use cases own import, progress update, annotation, export, archive/delete, and sync orchestration. These services define atomic boundaries and should be testable without DOM or Cloudflare bindings.

### Repositories and adapters

- `BookRepository`, `ProgressRepository`, `AnnotationRepository`, collection repositories, `SessionRepository`, and sync/change repositories manage metadata.
- `BookFileStore` manages local file bytes and integrity operations.
- `Renderer` abstracts display engines.
- `SyncTransport` abstracts HTTP and authentication.

Dexie, OPFS, filesystem access, renderer engines, and network fetches are replaceable adapters. The repository boundary is intended to permit a future database change; it does not promise that arbitrary SQL compatibility with D1 will be automatic.

### Renderer contract

Conceptual interface:

```ts
interface Renderer {
  open(file: Blob, startAt?: Locator): Promise<void>;
  goTo(locator: Locator): void;
  getToc(): Promise<TocItem[]>;
  onRelocate(callback: (locator: Locator, fraction: number) => void): () => void;
  search(query: string, signal?: AbortSignal): AsyncIterable<SearchHit>;
  applySettings(settings: ReaderSettings): void;
  destroy(): void;
}
```

Adapter-specific APIs and locator conversion stay inside implementations. All locators include a normalized fraction for fallback and progress comparison. See [Import and reader](IMPORT-AND-READER.md).

## 5. Data flow and invariants

1. A user mutation is validated and committed to the local database first.
2. Replicated mutations and their local change-log entries commit in one local transaction.
3. The UI reflects committed local state immediately.
4. A background sync worker batches changes and records durable transfer state.
5. The server applies each idempotently, then makes the mutation visible in its change log.
6. Pull application updates local replicated state and cursor atomically.

Required invariants:

- The client never treats a network response as a replacement for unpushed local data.
- Content hashes are computed over original bytes and verified after transfer.
- A cursor never advances past a remote event that was not applied locally.
- A destructive metadata action does not implicitly remove an original file.
- Local-only device choices (pinning, cache presence) do not overwrite another device's state.

## 6. Platform strategy

### Web and PWA

A single Vite build is served as a static application. Service-worker caching is versioned and limited to app assets. The app requests persistent storage where available but must handle denial and eviction. A PWA cannot promise filesystem durability on every browser, especially iOS.

### Desktop

Tauri provides a thin native container, filesystem access, and later OS-level integration. The UI remains the shared web application. Native commands are narrow and validated; application domain rules remain in shared TypeScript code where possible.

### Mobile

PWA is the initial mobile strategy. Native mobile packaging is deferred until real PWA limitations (storage, background work, file access) are demonstrated to block required workflows.

## 7. Backend boundaries

Cloudflare Access authenticates the user; the Worker enforces identity and validates all requests. D1 stores replicated metadata and the server change log. R2 stores original book bytes and generated covers in a private bucket. Large files move directly between client and R2 through short-lived authorized URLs rather than through the Worker body.

The server is a durable replica, not the UI's source of truth. API contracts and security details are in [Backend](BACKEND.md); conflict and recovery details are in [Sync](SYNC.md).

## 8. Security and privacy boundaries

- No public bucket or unauthenticated metadata endpoints.
- The Worker validates the Access assertion and authorization on every route.
- Upload authorization is bound to the authenticated user, expected content hash, and allowed operation.
- Avoid logging book titles, annotation contents, tokens, signed URLs, or raw file bytes.
- Secrets and local environment files are never committed.
- Client-side file encryption is deferred; until adopted, server-side storage is private but not end-to-end encrypted.

## 9. Deployment environments

Use separate development and production Cloudflare resources and credentials. Local development should work without production secrets. Schema migrations, bucket bindings, Access policy, and Pages/Worker routes are deployed as explicit reviewed changes. A deploy must not silently change data retention or remove stored objects.

## 10. Architecture evolution

A change to a baseline decision should update its ADR status and consequences. Changes to replicated schema require forward migration and compatibility planning for stale clients. Renderer changes require the format regression corpus. Sync changes require invariant tests and a documented compatibility/version strategy.
