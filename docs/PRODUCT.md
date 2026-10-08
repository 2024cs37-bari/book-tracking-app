# Product requirements

## 1. Purpose

Personal Book Reader is a private, single-user library and reading application. It imports books from the user's devices, organizes the collection, reads supported files, records progress and annotations, and eventually synchronizes that state across the user's web, mobile, and desktop clients.

The system must remain useful without a network connection. Cloud services make data durable and cross-device; they must not be required for opening a locally available book or recording a local change.

## 2. User and primary outcomes

### Target user

One person with a personal collection who reads on more than one device and wants the same library and reading state everywhere. The user may spend long periods offline and may alternate between devices frequently.

### Core outcomes

1. Import DRM-free books without losing the original bytes.
2. Find books using metadata, query, status, format, shelf, and tag.
3. Open a locally available supported book promptly and resume at a stable reading position.
4. Record progress, annotations, and reading sessions locally, then synchronize them safely.
5. Decide which files are pinned for offline use and understand which files must be downloaded.
6. Export metadata and annotations, and recover the original book files independently of the application.

## 3. Product principles

- **Local first:** reads and writes go to local storage before any network operation.
- **Recoverable by default:** no silent permanent deletion; export and restore are first-class concerns.
- **Honest format support:** importing a format does not imply that rendering it is reliable.
- **Private by default:** no public book URLs, social features, or analytics tracking.
- **Understandable sync:** pending work, errors, last sync, and conflicts are visible to the user.
- **Incremental delivery:** prove local reading and data durability before adding sync complexity.

## 4. Scope and terminology

These concepts are deliberately distinct:

- **Shelf:** a named, user-managed collection, such as “To read” or “Favorites.” A book may belong to multiple shelves.
- **Tag:** a lightweight label for cross-cutting classification, such as “history” or “reference.” A book may have multiple tags. Tag names may be normalized for duplicate detection, but remain user-editable.
- **Folder:** a hierarchy for organizing the library. It is deferred until a concrete user need is validated; shelves and tags cover the initial scope. A folder must not be represented implicitly by a path that breaks when syncing.
- **Status:** the reading lifecycle state (`to_read`, `reading`, `finished`, `abandoned`) stored with progress, not a shelf or tag.
- **Archive:** hide a book from normal library views while retaining metadata and file availability for recovery. Archiving is reversible and is the default removal action.
- **Delete:** a separately confirmed operation. Metadata deletion creates a synchronized tombstone. Removing the remote original file is a further explicit operation, not an automatic consequence of hiding or deleting a metadata row.

DRM-protected books are unsupported. The application will not bypass DRM or claim compatibility with protected files.

## 5. Functional requirements

Priority labels: **MVP** is required for the first local-reader milestone; **Later** follows after its dependencies are stable; **Deferred** is not committed to the initial product.

| ID   | Priority | Requirement                                                                                         | Acceptance intent                                                                                      |
| ---- | -------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| F-01 | MVP      | Import one or more files using a picker; desktop drag-and-drop can follow with the desktop shell.   | Unsupported or malformed input produces a clear result and does not corrupt existing library data.     |
| F-02 | MVP      | Compute a SHA-256 content hash and preserve original bytes.                                         | Re-importing identical bytes does not create a duplicate file entry.                                   |
| F-03 | MVP      | Extract title, author, language, and cover when available.                                          | Missing metadata is allowed; filename-derived title and an incomplete-metadata indicator are provided. |
| F-04 | MVP      | Browse a library with search, sort, and reading-status filters.                                     | Core browsing works offline against local data.                                                        |
| F-05 | MVP      | Read EPUB and PDF files through isolated renderer adapters.                                         | Opening and progress restoration work without a network connection when the file is local.             |
| F-06 | MVP      | Persist and restore reading progress automatically.                                                 | Reflowable content uses a durable locator plus fraction; PDF uses page and offset plus fraction.       |
| F-07 | MVP      | Export library metadata as JSON and annotations as Markdown.                                        | Export is usable without a server request and identifies files by hash.                                |
| F-08 | Later    | Synchronize library metadata, progress, annotations, shelves, tags, sessions, and files.            | Retries are idempotent; local writes are never blocked by network failure.                             |
| F-09 | Later    | Pin a book for offline access; show remote-only, queued, downloading, available, and failed states. | Pinned files are not evicted automatically.                                                            |
| F-10 | Later    | Add highlights, notes, and bookmarks.                                                               | Annotation locators can be resolved or reported as orphaned after a file/version mismatch.             |
| F-11 | Later    | Add shelves and tags.                                                                               | Membership and renames have defined cross-device conflict behavior.                                    |
| F-12 | Later    | Add table of contents and in-book search.                                                           | Search is cancellable and does not freeze library navigation.                                          |
| F-13 | Later    | Show reading time, reading days/streaks, progress per day, and finished-book counts.                | Statistics are derived from mergeable reading sessions.                                                |
| F-14 | Later    | Prompt on substantial cross-device progress divergence.                                             | The user can choose a position; neither candidate is silently discarded before resolution.             |
| F-15 | Deferred | Support nested folders.                                                                             | Requires an explicit data-model and UX decision first.                                                 |
| F-16 | Deferred | Automated third-party cloud backup.                                                                 | Manual export and restore must exist first.                                                            |
| F-17 | Deferred | Client-side encryption of files.                                                                    | Requires a key recovery design and a documented trade-off with server-side processing.                 |

## 6. Non-functional requirements

| ID    | Requirement   | Initial measurable intent                                                                                                           |
| ----- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| NF-01 | Offline-first | Every core read and mutation uses local repositories; sync is asynchronous.                                                         |
| NF-02 | Performance   | Cached-book open target under 1 second and page-turn target under 100 ms on a documented reference device; measure before claiming. |
| NF-03 | Durability    | Server storage becomes a recoverable copy after sync; local storage may be evicted and must be rebuildable.                         |
| NF-04 | Integrity     | Verify file content hashes after import and after download.                                                                         |
| NF-05 | Security      | HTTPS, authenticated API routes, private object storage, and no public book URLs.                                                   |
| NF-06 | Portability   | Original files remain byte-for-byte unchanged; metadata and annotations are exportable.                                             |
| NF-07 | Resilience    | Sync operations are idempotent, cursor-based, retryable, and survive application restarts.                                          |
| NF-08 | Cost          | Design for one user and current free tiers, but verify service quotas and pricing at deployment time.                               |
| NF-09 | Accessibility | Keyboard operation, visible focus, semantic controls, contrast, and scalable text are required for app UI.                          |
| NF-10 | Privacy       | No analytics or telemetry by default; any future diagnostics must be opt-in and documented.                                         |

Performance targets apply only after profiling on declared hardware and representative files. They are goals, not guarantees across every platform.

## 7. Platforms and formats

- **Web/PWA:** first delivery target; installable where supported, subject to browser storage quotas and iOS eviction behavior.
- **Desktop:** Tauri wrapper after web storage, rendering, and repository boundaries are stable; native filesystem support improves offline durability.
- **Mobile native:** deferred to a later version unless PWA limitations prevent core use cases.
- **Initial rendering commitment:** EPUB and PDF.
- **Validation spike:** DRM-free MOBI and AZW3; support is committed only after corpus testing on target browsers/webviews.
- **Bonus formats:** FB2 and CBZ are deferred pending evidence and explicit acceptance criteria.

## 8. UX and failure behavior

- The library remains navigable while sync or file transfer runs.
- The user can see last successful sync, pending changes, transfer queues, storage use, and actionable errors.
- A remote-only book clearly indicates that opening requires download; download status is not represented only by a disabled button.
- Low storage does not evict pinned or currently open content. Unpinned eviction explains what was removed and retains cloud metadata.
- A failed import does not silently discard the selected file; provide an error and a path to retry or inspect incomplete metadata.
- Destructive actions explain whether they affect local files, cloud metadata, or remote originals.

## 9. Out of scope

Multi-user accounts, shared libraries, public sharing, social feeds, book sales, DRM circumvention, custom rendering engines, recommendation profiles, and mandatory online metadata services are not part of the product baseline.

## 10. Open validation items

- Confirm exact foliate-js capabilities and license/maintenance fit for target formats and runtimes.
- Establish a representative, legally distributable regression corpus; do not commit copyrighted test books.
- Measure IndexedDB/OPFS quota behavior and persistence options on target browsers.
- Verify Cloudflare service limits, Access integration, and presigned upload constraints at implementation time.
