# Personal Book Reader

A private, single-user book library and EPUB/PDF reader that works offline. Import original books,
organize them, resume reading, and keep annotations and reading history on your devices.

**Status:** active development and hardening. The local library and reader, collections, annotations,
backup/recovery, sync client and Cloudflare backend are implemented. Production deployment and
physical mobile-device validation are separate release prerequisites. EPUB/PDF support remains
experimental against the documented corpus; importing another format does not make it readable.
See [Development record](docs/DEVELOPMENT.md) for current evidence and remaining work.

## Capabilities

- Import EPUB, PDF, MOBI, AZW3, FB2 and CBZ; detect content rather than trusting extensions.
- Preserve original bytes under SHA-256 identities, deduplicate imports, and repair missing or
  corrupted local originals by re-importing the same file without replacing your metadata.
- Extract available metadata and covers; edit details; search, sort and filter by status, format,
  shelf or tag; rename collections; archive and restore books; retain recoverable tombstones for metadata deletion.
- Read EPUB/PDF with contents, search, stable progress, themes, font sizing/PDF zoom, keyboard
  navigation and a resizable sidebar. Add bookmarks, notes and text-selection highlights, with
  visible feedback when the current renderer cannot resolve a saved annotation anchor.
- Use read-aloud controls where browser speech is available. Optional online English definitions
  require consent and send only the selected word to dictionaryapi.dev.
- View reading time, books finished, daily activity/last positions and streaks derived from saved sessions.
- Pin verified originals locally, save individual originals, and free eligible cached copies in
  least-recently-used order after verifying a remote copy. Open/pinned books remain protected.
- Export metadata as JSON and annotations as Markdown. Portable ZIP backups include verified
  original files; recovery validates a preview before adding missing data and preserves existing
  records. See [Backup and recovery](docs/BACKUP.md) for size limits and exact merge rules.
- Run metadata sync and file transfers in the background when a server is configured, with visible
  state, bounded work, retries, pause/resume, progress conflicts and recoverable queues.
- Cache the production app shell for offline reload. PWA updates wait for existing windows to
  close rather than interrupting an active reader.

## Run locally

Requires Node.js 20.19+; CI uses Node 22. Use a current supported Node LTS for development.

```bash
npm ci
npm run dev
```

Open Vite's printed URL. No account or server is needed for local reading. The production service
worker is available with `npm run build` followed by `npm run preview`; complete one online load
before testing an offline reload.

```bash
npm run check          # frontend typecheck, lint, formatting, unit tests, build
npm ci --prefix server
npm run check:server   # server typecheck and tests, including local Worker bindings
npm run check:all      # both gates
npm run test:browser   # production browser regressions
npm run test:sync-browser # isolated browser + Worker/D1/R2 convergence
npm run corpus:fetch   # explicitly fetch hash-pinned licensed files outside the repo
npm run test:corpus    # selected real-file correctness and measurements
npm run test:accessibility # populated views, keyboard focus and contrast
npm run test:native    # Rust native storage/exports (requires Rust)
npm run check:desktop  # Tauri compile check (requires Linux native dependencies)
```

Install browser binaries with `npx playwright install chromium firefox webkit`. On supported Linux
hosts use `--with-deps` for native libraries. A targeted check uses
`npm run test:browser -- --project=chromium`. See [Runbook](docs/RUNBOOK.md) for complete workflows.

## Optional private sync

The browser remains the immediate source for the interface. With `VITE_SYNC_URL` configured, it
synchronizes metadata to a Cloudflare Worker and original files to private R2. D1 stores the
idempotent sequenced change history; Access verifies identity. No credentials go into the client.

Set the API **base ending in `/api`**, for example `https://reader.example.com/api`. The build
validates this public URL and scopes its connection policy to the selected origin. HTTPS is required
except for loopback development. Server CORS must explicitly allow a separate client origin.
The default build has no configured sync server.

Production setup, limits and auth configuration are in [server/README.md](server/README.md) and
[API contract](docs/API.md). Local tests do not certify a deployed Access policy or cloud account.

## Data and practical limits

- Metadata uses Dexie/IndexedDB. Originals prefer OPFS with a tested IndexedDB fallback; memory is
  the visibly non-durable last resort. Browser site-data clearing/eviction can remove either store.
- A pin protects against application cache cleanup; it cannot prevent the browser clearing site
  data. Keep an external backup. JSON exports contain metadata, **not original book bytes**.
- Imports are bounded to 256 MiB per file. Transfers and portable backups have separate documented
  bounds. Current transfers restart a failed whole-file upload rather than resume multipart bytes.
- PDF rendering bounds canvas and image decoding, not total process memory. Oversized source
  images fail visibly without replacing the last usable saved position.
- MOBI/AZW3/FB2/CBZ have no registered reading adapter. DRM-protected books are unsupported.
- An experimental Linux Tauri desktop foundation adds app-owned native originals, OS Save dialogs
  and guarded close/restart. Desktop sync is not available: native Access authentication remains
  unfinished and desktop builds reject `VITE_SYNC_URL`. Signed/installer releases, native mobile,
  multipart transfer, history compaction and broader device certification remain future work.
- Private cloud storage is not end-to-end encryption. No analytics is included.

## Code and documentation

`src/domain` holds pure types/rules; `data` repositories and `storage` adapters hold persistence;
`reader` isolates foliate-js/pdf.js; `services` orchestrates use cases; `sync` and `transfer` handle
network work; `app` wires services; `ui` renders them. `server/` is independently deployable.

| Document                                       | Purpose                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------- |
| [Desktop](docs/DESKTOP.md)                     | Linux native storage, save dialogs, verification and release limits |
| [Interface design](docs/DESIGN.md)             | Design research, visual system and future interface rules           |
| [User guide](docs/USER-GUIDE.md)               | Import, reading, offline use, sync and recovery                     |
| [Accessibility](docs/ACCESSIBILITY.md)         | Keyboard/contrast checks and assistive-technology scope             |
| [Product](docs/PRODUCT.md)                     | User needs, scope and intended acceptance criteria                  |
| [Architecture](docs/ARCHITECTURE.md)           | Current boundaries, invariants and future extension points          |
| [Data model](docs/DATA-MODEL.md)               | Persisted entities, versions, identity and migration rules          |
| [Sync](docs/SYNC.md)                           | Conflict/delivery contract and operational limits                   |
| [Storage](docs/STORAGE.md)                     | Original integrity, pins, cleanup and quotas                        |
| [Backup](docs/BACKUP.md)                       | Portable format, validation, recovery and limits                    |
| [Diagnostics](docs/DIAGNOSTICS.md)             | Shareable aggregate report and privacy exclusions                   |
| [Offline app](docs/OFFLINE-APP.md)             | Installability, offline cache and safe updates                      |
| [Backend](docs/BACKEND.md)                     | Cloud responsibilities and implemented transfer lifecycle           |
| [API](docs/API.md)                             | Executable request/response behavior and error codes                |
| [Import and reader](docs/IMPORT-AND-READER.md) | Format policy, navigation, annotations and rendering bounds         |
| [Reader validation](docs/READER-VALIDATION.md) | Corpus provenance, evidence and physical-device protocol            |
| [Runbook](docs/RUNBOOK.md)                     | Local setup, verification and troubleshooting                       |
| [Operations](docs/OPERATIONS.md)               | Release, deployment, backup and incident procedures                 |
| [Roadmap](docs/ROADMAP.md)                     | Remaining work, dependencies and future application design          |
| [Development record](docs/DEVELOPMENT.md)      | Completed slices and actual verification results                    |

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md) before changes. Keep code,
contracts and documentation aligned; never edit released database versions in place. Generated
fixtures are committed as source; original corpus files and personal books are not.

No project license has been selected. Rights remain with the owner until a license is added;
third-party components retain the notices in `vendor/` and their packages.
