# Architecture

## Current system

Personal Book Reader is a single-user, offline-first web application. All core library reads and
mutations use local repositories. Network availability affects synchronization and remote originals,
not locally stored books, annotations or progress.

```text
SolidJS UI → application services → Dexie/IndexedDB + atomic outbox
                            ├── original file store: OPFS → IndexedDB → memory
                            ├── EPUB adapter: vendored foliate-js
                            └── PDF adapter: pinned pdf.js + local worker/assets

Background scheduler → metadata push/pull → Access → Worker/Hono → D1 change log
                     → verified file transfer → Access → Worker → private R2
```

Vite builds the TypeScript/Solid client. The production service worker caches application assets,
not library metadata or books. The server is a separate package with its own tests, dependencies,
D1 migration and deployment configuration. Resource IDs and Access policies are deployment inputs.

## Boundaries

| Layer              | Responsibilities                                                              | Dependencies                            |
| ------------------ | ----------------------------------------------------------------------------- | --------------------------------------- |
| `domain`           | Books, locators, clocks, collections, activity and pure validation            | No UI/storage/network                   |
| `data`             | Versioned Dexie tables, transactional repositories, durable outbox            | Domain; narrowly shared pure sync rules |
| `storage`          | Original bytes, hashes, capability probes, file leases, reconciliation        | Domain                                  |
| `reader`           | Format sniffing, engine lifecycle, rendering, search, selection and speech    | Domain and isolated engine code         |
| `services`         | Import, reader sessions, portable backup/recovery, offline policy, dictionary | Repositories and adapters               |
| `sync`, `transfer` | Validated transport, convergence, scheduling and durable work queues          | Domain, data, file-store interfaces     |
| `app`              | Construction, configuration, startup clock recovery, app-shell registration   | All implementations                     |
| `ui`               | Local views, navigation, settings, progress and user decisions                | App service facade                      |

The UI receives services through context. Repository-change subscriptions refresh library/details,
settings and statistics after background or other-tab commits. A local database write is never
conditional on an HTTP request succeeding.

## Identity, clocks and transactions

Original identity is lowercase SHA-256 of the exact original bytes. Metadata has opaque IDs; when
independent devices imported the same original with different IDs, sync deterministically selects
a canonical ID and moves references atomically. Local aliases keep old references resolvable.
Already-created outbox messages and their idempotency IDs are immutable.

Each replicated mutation commits its entity and outbox row in one transaction. Pull applies a
validated page, identity reconciliation, cursor and clock checkpoint together. Applying remote
changes does not create an outgoing echo. Startup recovers the clock from durable rows/outbox as
well as its saved checkpoint, protecting against abrupt termination before pagehide.

Metadata merges retain per-field HLC provenance, including explicit user-cleared optional fields.
Membership merges preserve add/remove order. Sessions are append-only facts. Substantial remote
progress divergence is retained for a user decision instead of replacing the current position.
See [Data model](DATA-MODEL.md), [Sync](SYNC.md) and [Sync implementation](SYNC-IMPLEMENTATION.md).

## Original durability and recovery

Originals are written and verified before metadata commits; they cannot share a transaction with
IndexedDB. A crash can leave an unreferenced original, which reconciliation reports. Re-import of
identical bytes repairs an absent or corrupt local copy while preserving metadata.

Shared Web Locks protect originals during import, backup, transfer and reading. Cache removal needs
an exclusive lease, an unpinned state and a currently verified remote original. Browsers without
cross-tab locking refuse automatic cache removal. Tombstoned originals remain referenced.

Portable backup/recovery uses bounded, validated archives and a preview. Recovery adds missing data
with fresh local events, preserves current records, and leaves staged files recoverable if the
metadata transaction fails. [Backup](BACKUP.md) specifies exactly what is and is not restored.

## Renderer isolation

Only adapters import the underlying engines. A reader session owns one renderer, native locator,
settings and serialized progress writes. EPUB locators are CFI plus fraction; PDF locators retain
page/vertical offset plus fraction. Annotations use the same stable locator model.

The PDF adapter bounds canvas size and releases rendering resources. The EPUB adapter strips active
content and supplies a no-script/no-network book policy before creating content URLs. Neither a
file extension nor an upstream feature list establishes application support. Only EPUB/PDF adapters
are registered, and they remain experimental pending broader validation.

## Security and optional network use

The app policy permits local assets, a validated configured sync origin and the optional dictionary
origin. EPUB documents receive a stricter isolated policy. Dictionary requests require user consent;
they send a selected word only. Read-aloud uses the browser/platform speech engine; availability and
voice behavior vary by platform.

Worker routes validate Access identity, request bounds and protocol envelopes; private R2 keys are
scoped to the verified user. CORS is an exact origin policy, not authentication. The local identity
bypass is accepted only on loopback development hosts. Original upload integrity is verified before
trusted availability; downloads are independently hash-checked before local publication.

Originals are private, not end-to-end encrypted. App logs and diagnostic output must avoid book
content, authentication assertions and private URLs. See [Security](../SECURITY.md).

## Platform and future extension points

The web application remains the shared product surface. The experimental Linux Tauri shell selects
a narrow native file-store adapter only in its native runtime. Rust commands accept validated
logical original/cover keys, use bounded IPC chunks, verify original SHA-256, stage atomic writes
and keep a process lock. Metadata remains in the WebView's versioned IndexedDB. Native exports use
an OS Save dialog and atomic destination writes; native window close waits for registered local
save guards before closing or offering an explicit failure choice. Desktop assets ship in the
application and do not install the web service worker.

This foundation is not a complete cross-device desktop release. Cloudflare Access's browser cookie
flow and allowed origins do not work unchanged from a native origin. Desktop builds therefore reject
configured sync URLs until a native authentication/credential lifecycle is designed and verified.
The web client keeps its existing private sync. Installer/signing, update/uninstall and other OS
verification remain separate release gates. [Desktop](DESKTOP.md) records actual native evidence.
Native mobile is deferred until measured PWA limitations justify it.

Large-file transfer can add multipart/resumable protocols behind `FileTransport`; backups can add a
streamed format behind versioned manifests. Server compaction requires a complete snapshot plus a
replay cursor, not merely dropping old log rows. Encryption requires a key-recovery design before
implementation. These changes must preserve original identity and backward compatibility rather
than forking the domain model. [Roadmap](ROADMAP.md) records their acceptance gates.
