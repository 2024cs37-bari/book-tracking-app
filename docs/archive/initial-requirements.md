# Personal Book Reader: Architecture & Requirements

Offline-first, cross-device reading app and library tracker. Single user, near-zero cost, Cloudflare backend.

---

## 1. Goals and Non-Goals

### Goals

- One library, one reading state, across mobile, web, and desktop (Linux, Windows, macOS).
- Offline-first: every core feature works with no network. The server is a sync target, not a dependency.
- Formats: **EPUB, MOBI, AZW3 (KF8), PDF**. Bonus: FB2, CBZ.
- Operating cost at or near $0 (Cloudflare free tiers, no paid app-store fees unless chosen).
- One shared codebase; platform wrappers stay thin.

### Optional-Goals
- Server-side format conversion (If 0 cost possible, otherwise client-side).

### Non-Goals
- Multi-user collaboration, public sharing, social features.
- Writing a custom rendering engine.

---

## 2. Functional Requirements

| ID | Requirement |
| --- | --- |
| F1 | Import books (EPUB/MOBI/AZW3/PDF) by file picker or drag and drop |
| F2 | Extract metadata (title, author, language, cover) on import |
| F3 | Library view: grid/list, search, sort, filter by shelf/tag/status/format, foldering |
| F4 | Reader: pagination or scroll, font/theme/margin settings (reflowable), zoom (PDF) |
| F5 | Reading progress saved automatically and resumed on any device |
| F6 | Highlights, notes, and bookmarks |
| F7 | Shelves and tags (e.g. to-read, reading, finished, custom) |
| F8 | Reading stats: time read, pages/day, streaks, finished count |
| F9 | Table of contents navigation and in-book search |
| F10 | Selective offline: pin books per device; lazy download from cloud; dedicated "make available offline" |
| F11 | Sync of metadata, progress, annotations, and files across devices |
| F12 | Export/backup of library data (JSON) and annotations (Markdown) |

## 3. Non-Functional Requirements

| ID | Requirement |
| --- | --- |
| N1 | **Offline-first:** all reads and writes hit local storage first; sync is asynchronous; make all books available offline lazily on wifi and download icons on those not available as well |
| N2 | **Cost:** stay within Cloudflare free tier for a single user |
| N3 | **Performance:** open a cached book in under 1 s; page turn under 100 ms; better native performance for offline available books; |
| N4 | **Durability:** server copy is always recoverable; local data treated as a cache |
| N5 | **Security:** single-user auth, all traffic over HTTPS, private R2 bucket |
| N6 | **Portability:** originals stored unmodified; data exportable at any time |
| N7 | **Resilience:** sync is idempotent and resumable; interrupted uploads continue |

---

## 4. System Overview

```
┌──────────────────────────── Client (all platforms) ────────────────────────────┐
│                                                                                │
│  UI (shared web app)                                                           │
│    │                                                                           │
│    ├── Renderer interface ──► foliate-js (EPUB/MOBI/AZW3/FB2/CBZ)              │
│    │                      └─► pdf.js (PDF)                                     │
│    │                                                                           │
│    ├── Local DB (SQLite WASM on OPFS, or Dexie/IndexedDB)  ◄─ source of truth  │
│    ├── Local file store (OPFS in browser/PWA, filesystem in Tauri)             │
│    └── Sync engine (change log, push/pull, upload queue)                       │
│                                                                                │
└───────────────────────────────────────┬────────────────────────────────────────┘
                                        │ HTTPS
┌───────────────────────────────────────▼────────────────────────────────────────┐
│ Cloudflare                                                                     │
│   Pages   ─ hosts the web app / PWA                                            │
│   Workers ─ API (Hono): auth, /sync/push, /sync/pull, presigned URLs           │
│   D1      ─ metadata, progress, annotations, change log                        │
│   R2      ─ book files and covers (private)                                    │
│   GDrive  ─ for backup (of d1 and r2)                                          │
│   Access  ─ optional auth gate (free up to 50 users)                           │
└────────────────────────────────────────────────────────────────────────────────┘
```

## 5. Platform Strategy

| Platform | Delivery | Notes |
| --- | --- | --- |
| Web | Cloudflare Pages | Same codebase |
| Mobile (Android/iOS) | Installable PWA | No store fees. Android APK sideloading is free. iOS may evict storage, so server remains source of truth |
| Desktop (Linux/Windows/macOS) | Tauri wrapper | Light (system webview), one config builds all three |
| Mobile native (optional) | Tauri 2 mobile targets | Only if PWA limits hurt. App Store costs $99/yr |

Tauri gives real filesystem access, so the desktop app stores books as plain files and is the most robust offline target.

---

## 6. Reader Layer

### 6.1 Format support

| Format | Engine | Locator |
| --- | --- | --- |
| EPUB | foliate-js | EPUB CFI + progress fraction |
| MOBI / AZW3 | foliate-js | CFI-like location + progress fraction |
| PDF | pdf.js (used directly) | page + y-offset + progress fraction |
| FB2 / CBZ | foliate-js | format-specific + fraction |

### 6.2 Renderer abstraction

```ts
interface Renderer {
  open(file: Blob, startAt?: Locator): Promise<void>;
  goTo(locator: Locator): void;
  getToc(): Promise<TocItem[]>;
  onRelocate(cb: (loc: Locator, fraction: number) => void): void;
  search(query: string): AsyncIterable<SearchHit>;
  applySettings(s: ReaderSettings): void;
  destroy(): void;
}

type Locator = {
  kind: 'cfi' | 'pdf';
  value: string;            // CFI string, or "page:yOffset" for PDF
  fraction: number;         // 0..1, always stored for cross-format percentage
};
```

The rest of the app only talks to `Renderer`. Format selection happens once, at open time, by sniffing the file.

### 6.3 Reader rules

- Always persist `fraction` alongside the native locator.
- Reflowable positions must resolve on different screen sizes. CFI handles this; page numbers do not.
- PDFs: render visible pages only, use range requests against the local file, and cap the page cache for mobile memory.

---

## 7. Local Storage (Offline-First Core)

### 7.1 Principles

- **Local DB is the source of truth for the UI.** The UI never waits on the network.
- Every mutation writes to the local DB **and** appends to a local `changes` log in one transaction.
- Files are **content-addressed**: key = SHA-256 of file bytes.

### 7.2 Options

| Layer | Preferred | Alternative |
| --- | --- | --- |
| Metadata DB | SQLite WASM on OPFS (same schema as D1) | Dexie on IndexedDB |
| Files (web/PWA) | OPFS | IndexedDB blobs |
| Files (Tauri) | App data directory on disk | n/a |

Call `navigator.storage.persist()` on the PWA at first run.

### 7.3 Selective offline

- Each device tracks `pinned_offline` and `last_opened_at` per book.
- Always keep: the currently open book, pinned books, and recently read books up to a configurable storage budget.
- Everything else is cloud-only (metadata and cover local, file downloaded on demand).
- Evict least-recently-used unpinned files when over budget.

---

## 8. Data Model

Shared logical schema (local SQLite and D1).

```sql
CREATE TABLE book (
  id            TEXT PRIMARY KEY,       -- uuid
  sha256        TEXT NOT NULL UNIQUE,   -- content hash, also the R2 key
  title         TEXT NOT NULL,
  author        TEXT,
  language      TEXT,
  format        TEXT NOT NULL,          -- epub | mobi | azw3 | pdf | fb2 | cbz
  size_bytes    INTEGER NOT NULL,
  cover_key     TEXT,                   -- R2 key of cover thumbnail
  added_at      INTEGER NOT NULL,
  deleted_at    INTEGER                 -- tombstone
);

CREATE TABLE progress (
  book_id       TEXT PRIMARY KEY REFERENCES book(id),
  locator_kind  TEXT NOT NULL,          -- cfi | pdf
  locator_value TEXT NOT NULL,
  fraction      REAL NOT NULL,
  status        TEXT NOT NULL,          -- to_read | reading | finished | abandoned
  updated_hlc   TEXT NOT NULL,
  device_id     TEXT NOT NULL
);

CREATE TABLE annotation (
  id            TEXT PRIMARY KEY,       -- uuid
  book_id       TEXT NOT NULL REFERENCES book(id),
  kind          TEXT NOT NULL,          -- highlight | note | bookmark
  locator_value TEXT NOT NULL,
  text_excerpt  TEXT,
  note          TEXT,
  color         TEXT,
  created_hlc   TEXT NOT NULL,
  updated_hlc   TEXT NOT NULL,
  deleted       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE shelf (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, updated_hlc TEXT NOT NULL, deleted INTEGER DEFAULT 0
);

CREATE TABLE shelf_book (
  shelf_id TEXT, book_id TEXT, added_hlc TEXT NOT NULL, removed INTEGER DEFAULT 0,
  PRIMARY KEY (shelf_id, book_id)
);

CREATE TABLE reading_session (
  id TEXT PRIMARY KEY, book_id TEXT NOT NULL,
  started_at INTEGER NOT NULL, duration_s INTEGER NOT NULL,
  start_fraction REAL, end_fraction REAL, device_id TEXT NOT NULL
);

-- Local only
CREATE TABLE changes (
  id          TEXT PRIMARY KEY,         -- uuid, idempotency key
  entity      TEXT NOT NULL,            -- book | progress | annotation | shelf | shelf_book | session
  entity_id   TEXT NOT NULL,
  op          TEXT NOT NULL,            -- upsert | delete
  payload     TEXT NOT NULL,            -- JSON
  hlc         TEXT NOT NULL,
  device_id   TEXT NOT NULL,
  pushed      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE device_state (
  book_id TEXT PRIMARY KEY, file_present INTEGER, pinned_offline INTEGER,
  last_opened_at INTEGER
);

CREATE TABLE sync_meta (key TEXT PRIMARY KEY, value TEXT);  -- pull cursor, device_id, HLC state
```

Server adds a monotonically increasing `seq` to its stored change log, which is the pull cursor.

---

## 9. Sync Design

### 9.1 Clocks

Use a **Hybrid Logical Clock (HLC)** per device: `(wall_ms, counter, device_id)`. It orders events consistently even with clock drift between devices.

### 9.2 Flow

1. User action writes local DB row + `changes` row (`pushed = 0`).
2. Sync engine batches unpushed changes: `POST /sync/push { device_id, changes[] }`.
3. Worker applies each change idempotently (keyed by `changes.id`), updates D1, appends to the server change log with a new `seq`.
4. Client calls `GET /sync/pull?since=<seq>`; Worker returns changes from other devices.
5. Client applies them with the conflict rules below and stores the new cursor.

### 9.3 Conflict resolution

| Entity | Rule |
| --- | --- |
| Progress | Last-write-wins by HLC. Optional prompt if another device is far ahead (e.g. >5% difference) |
| Annotations | Create is append-only; edits are LWW per annotation; delete is a tombstone |
| Shelves | LWW on name; membership uses add/remove with HLC (re-add after remove wins if newer) |
| Books | Dedupe by `sha256`; delete is a tombstone; file removal is a separate, explicit action; no delete option by default only archive; for complete removal the setup is book -> archive -> delete |
| Sessions | Append-only, never conflict |

### 9.4 Triggers

- App launch, network regained, app foregrounded.
- Debounced \~30 s while reading, plus on book close.
- Background Sync API where supported. Do not rely on it (poor iOS support).

### 9.5 File sync

- Upload: Worker issues a **presigned PUT** (multipart for large files); the file never streams through the Worker. Resumable; part state is tracked locally.
- Download: Worker issues a presigned GET or streams from R2 via a Worker with auth.
- Verify SHA-256 after download.
- Upload queue and download queue are persisted so they survive restarts.

### 9.6 Failure handling

- All endpoints idempotent; retry with exponential backoff.
- A failed push leaves `pushed = 0`; nothing is lost.
- Pull is cursor-based and safe to repeat.
- If local data is wiped (e.g. iOS eviction), a fresh device bootstraps by pulling from `seq = 0`.

---

## 10. Backend (Cloudflare)

### 10.1 Components

| Service | Use | Free-tier note |
| --- | --- | --- |
| Pages | Static frontend | Generous |
| Workers | API (Hono) | 100k requests/day |
| D1 | SQLite metadata + change log | Plenty for single-user metadata |
| R2 | Book files, covers | 10 GB storage, no egress fees |
| Access | Auth gate | Free up to 50 users |

Check current limits on Cloudflare's pricing pages before committing, since free tiers change.

### 10.2 API

| Endpoint | Purpose |
| --- | --- |
| `POST /sync/push` | Submit local changes |
| `GET /sync/pull?since=` | Fetch remote changes |
| `POST /files/upload-url` | Presigned PUT (or multipart init) for `sha256` |
| `POST /files/upload-complete` | Confirm and register upload |
| `GET /files/:sha256` | Presigned GET / authenticated download |
| `GET /export` | Full JSON export |

### 10.3 Auth

- Simplest: Cloudflare Access in front of the Worker and Pages (identity via email OTP or GitHub).
- Alternative: a long random API token stored on each device, sent as a bearer token. Rotate by regenerating it.
- R2 bucket stays private; access only through presigned URLs or the Worker.

### 10.4 Cost guardrails

- Avoid Workers KV for frequent writes (low free write limit); use D1.
- Debounce progress writes; batch changes per push.
- Keep annotations and progress as small rows; no per-keystroke syncing.
- Covers are small thumbnails (e.g. 300 px WebP).

---

## 11. Import Pipeline (Client-Side)

1. User selects file(s).
2. Compute SHA-256 (streamed).
3. If hash exists locally or remotely: link and skip.
4. Sniff format; open with foliate-js or pdf.js.
5. Extract title, author, language, cover; generate thumbnail.
6. If possible enrich via Open Library (ISBN/title lookup) when online.
7. Save file to local store, write `book` row + `changes` entry in one transaction.
8. Queue background upload to R2.

Bad or unparseable files are imported with filename-derived metadata and a "metadata incomplete" flag, not rejected.

---

## 12. Reading Stats

- A **session** starts on book open and ends on close, idle timeout (e.g. 2 min), or backgrounding.
- Track `duration_s`, `start_fraction`, `end_fraction`, and `device_id`.
- Derived locally: total time, daily time, streaks, pages/percent per day, books finished per period, per-book time.
- Stats are computed from sessions, so they merge cleanly across devices.

---

## 13. Security and Privacy

- Private R2 bucket; no public URLs.
- HTTPS only; HSTS via Cloudflare.
- Auth required on every API route.
- Library is personal; no analytics or third-party trackers.
- Optional later: client-side encryption of files before upload (key held on devices), at the cost of server-side features like thumbnails.
- Regular export (JSON + originals) for backup independent of Cloudflare.

---

## 14. Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| iOS PWA storage eviction | Server is source of truth; re-download on demand; `storage.persist()` |
| Inconsistent MOBI/AZW3 parsing | Maintain a regression corpus of 10-20 real files; test early |
| Large PDFs on mobile | Visible-page-only rendering, capped cache, range reads |
| Stale service worker bundles | Versioned app-shell caching, update prompt on new version |
| Clock drift breaking LWW | HLC instead of wall time |
| Free-tier changes | Keep storage layer behind an interface; exports always available |
| Foliate-js API changes | Pin the version; isolate behind `Renderer` |
| Lost data from sync bugs | Append-only changes log; tombstones instead of hard deletes |

---

## 15. Tech Stack Summary

| Concern | Choice |
| --- | --- |
| Frontend | TBD (SvelteKit / React / other) |
| Reflowable rendering | foliate-js |
| PDF rendering | pdf.js |
| Local DB | SQLite WASM (OPFS) or Dexie |
| Desktop | Tauri |
| Mobile | PWA (Tauri mobile optional) |
| API | Cloudflare Workers + Hono |
| Metadata DB | D1 |
| File storage | R2 |
| Auth | Cloudflare Access or bearer token |
| Metadata enrichment | Open Library API |

---

## 16. Build Roadmap

**Phase 1: Local reader MVP**

- Import, hash, metadata and cover extraction
- Renderer interface with foliate-js and pdf.js
- Local DB, library view, progress, TOC

**Phase 2: Sync backend**

- Workers + D1 + R2, auth
- `changes` log, HLC, push/pull
- File upload/download with presigned URLs

**Phase 3: Offline and PWA**

- Service worker, app-shell caching, OPFS persistence
- Pinning, LRU eviction, storage budget

**Phase 4: Desktop**

- Tauri wrapper, filesystem storage, auto-update

**Phase 5: Reading features**

- Highlights, notes, bookmarks
- Shelves, tags, search
- Sessions and stats dashboard

**Phase 6: Polish**

- Export/import, backup
- Conflict prompts, error UX, performance tuning

---

## 17. Open Decisions

- Frontend framework. (User: SolidJS woould be preffered for its lightwieghtness and robust reactive system)
- Local DB: SQLite WASM vs Dexie. (User: The agent can decide itself)
- Auth: Cloudflare Access vs bearer token. (User: Whatever is simplet yet good)
- Whether to ship native mobile or stay PWA-only. (User: for now pwa, in v2 native)
- Whether to encrypt files client-side before upload. (User: not required yet, its simple a book tracker we might later add.)
- Whether to prompt on large progress divergence between devices. (User: yeah prompt it, for me it might often happen that i read a lot on one device as compared to other)
