# Import and reader

## Format support

| Format              | Import                                                       | Reading                          |
| ------------------- | ------------------------------------------------------------ | -------------------------------- |
| EPUB                | Content detection, OPF metadata and embedded cover           | Experimental, pinned foliate-js  |
| PDF                 | Content detection, best-effort metadata and first-page cover | Experimental, pinned pdf.js      |
| MOBI / AZW3         | Content detection including KF8 discrimination               | No registered adapter            |
| FB2 / CBZ           | Recognized/importable                                        | No registered adapter            |
| DRM-protected books | Unsupported                                                  | No bypass or compatibility claim |

The authoritative engine provenance is [ADR 0003](decisions/0003-reader-engines.md) and
`vendor/PROVENANCE.md`. Package names are not evidence of application support. Generated fixtures
exercise known behavior; the selected real-file corpus and its remaining gaps are documented in
[Reader validation](READER-VALIDATION.md).

## Import transaction and repair

1. Reject empty/oversized input before expensive work (256 MiB per original).
2. Compute streaming SHA-256 and acquire a shared file lease.
3. For existing content, verify local bytes and repair from the selected original if needed;
   preserve the user's metadata and return a duplicate result.
4. Detect content, extract available metadata and use filename/title fallback if incomplete.
5. Store original bytes and verify them after storage; generate/store a bounded cover if possible.
6. Commit metadata, default progress and outbox atomically; update local presence.
7. Report a result per file; background sync discovers new originals after metadata acceptance.

Files are imported sequentially to bound concurrent memory. Original storage and metadata cannot
share a transaction, so failed imports may leave an orphan that diagnostics reports. Reconciliation
must not delete an original currently held by an importer. Missing cover generation is cosmetic;
missing/corrupt original verification is not silently accepted.

## Reader contract and navigation

Adapters own engine mounting/opening/teardown, previous/next navigation, contents, search, settings,
selection, highlight drawing, visible text and optional thumbnails. UI uses the contract rather than
calling foliate/pdf.js directly. A renderer session is unique to an open book and releases its
listeners, workers, canvases and object URLs on close.

EPUB contents support EPUB 2 NCX and EPUB 3 navigation, nested chapters and fragment links. PDF
outlines resolve destinations to page locators. Unresolvable destinations remain disabled. Search is
asynchronous/cancellable for both registered formats. PDF text selection uses the engine text layer;
EPUB selection is forwarded from isolated content frames.

Reflowable EPUB supports font size, margins, line height and themes. Fixed-layout EPUB retains
publisher geometry/typography and fits the reading surface; those controls cannot reflow it. PDF
font-size control acts as zoom. Reader settings and sidebar preferences are device-local.

## Locators, progress and failed saves

EPUB positions use native CFI plus normalized fraction. Chapter/package-only CFIs restore the spine
item at its start. PDF uses zero-based `page:yOffset`, with offset in scale-1 rotated page points;
highlights add page-text start/end indices. Fractions remain finite in [0,1] for fallback/comparison.
Approximate restoration must be reported, not silently presented as an exact anchor.

Progress normally debounces 400 ms, serializes writes and flushes on hide/close. Before that delay,
a pending locator intent is journaled synchronously in localStorage under a database/content-scoped
key: `book-reader:unsaved-position:v1:<encodeURIComponent(databaseName)>:sha256:<originalHash>`.
The journal contains a locator, intent token, timestamp and original hash, never selected text.
Only the matching intent is cleared after durable progress/clock success, so an older completion
cannot erase a newer position. Failed saves remain visible and retryable.

On prepare, matching recent intent can be replayed for the same original; expired (>30 days),
mismatched or superseded intent is dropped. New sessions use the immutable original hash even if
sync replaces the book UUID while the reader is open. Legacy UUID keys migrate when their route
is opened or when a bounded scan (at most 10,000 localStorage keys) finds a matching original in
this database namespace. The newest valid timestamp wins. A failed target-key write retains the
durable source journal for retry. A newer other-tab stored intent takes precedence over an older
memory copy; a failed localStorage write retains its in-memory intent. If
localStorage is unavailable, intent stays in memory for this app session. Neither memory nor a
pending browser transaction guarantees recovery from process termination when persistent stores
fail. Never promise a save that did not commit.

## Annotations and activity

Bookmarks, notes and text highlights use stable locators, original identity and creation/update
clocks. Highlights are redrawn after section/page changes; supported colors can be changed.
Markdown export includes human-readable excerpts/notes and locator context. An unresolved anchor
must not silently attach to unrelated text or another original.

The reader's Notes panel reports **Anchor unavailable** when an EPUB chapter/range or PDF
page/text range cannot resolve. This is evidence from the current renderer session: it never
changes the annotation, queues a sync mutation, or adds diagnostic fields to backups/exports.
Notes remain editable and exportable. Invalid page/spine references can be reported immediately;
text anchors in unloaded chapters/pages remain unchecked until that content is visited. Checking
does not parse the entire book or eagerly load PDF pages. Confirmed results stay visible during
this session even when their page moves offscreen and reset when the book is reopened.

Reading activity records foreground spans, checkpoints long sessions and resumes on foreground
return. Time is an estimate of visible reading activity, not attention. Statistics derive totals,
finished-book status, reading days/streaks and daily time in the current device timezone. Failed
activity writes are reported/retryable; they must not block reading.

## Optional speech and dictionary

Read-aloud uses platform Web Speech capabilities, selected voice/rate and visible text. Some
platforms do not support it, and voice availability can depend on OS/browser services; gracefully
show the unsupported state. Do not label all voices guaranteed offline.

Online English definitions use dictionaryapi.dev only after consent. The selected word is disclosed
before enabling lookups; Settings can revoke consent. A build can disable dictionary networking
entirely. App CSP permits the configured service, but EPUB documents themselves cannot make network
requests. A missing/offline definition never blocks reading or changes library data.

## Untrusted content and memory

App CSP is installed before scripts. EPUB documents receive a stricter no-script/no-network policy;
active embedding/base/refresh/script elements are removed. Inline book styles and local asset blobs
are permitted for publisher layout. Hostile generated EPUB browser tests must remain green.

The PDF renderer uses bounded visible canvases, cancels superseded renders and protects the last
successfully rendered locator from failed pages. Source-image decoding is capped at 4,000,000 pixels; total process memory is not capped because original buffers, fonts, worker data and GPU
allocations also exist. Oversized source images fail visibly; usable pages remain navigable.
The pinned pdf.js stream-error compatibility bridge must be re-reviewed on engine upgrades.

Thumbnails and retained pages need explicit resource limits and cancellation. No large-file or
mobile-memory claim follows merely from a canvas cap. Expand/test real image-heavy PDFs and EPUB
layouts before promoting support. See [ADR 0005](decisions/0005-pdf-render-errors.md).

## Reading modes and preferences

`src/reader/settings.ts` is the device-local preference schema. The existing `reader-settings-v1`
key upgrades field by field: valid old theme, typography and margins survive, and the former
font-size-based PDF zoom migrates to the separate percentage. New enums/numbers are validated
before they reach CSS or renderer math. Reset affects preferences only. Gestures publish their
committed setting back to the shell for persistence and control synchronization.

PDF single/facing/continuous modes share one document and worker. Facing mode pairs pages with an
optional separate cover and falls back to single below 700 CSS pixels of reading-area width.
The page order option changes visual spread order, not canonical page numbers. Width/page/actual
fit and explicit zoom compose once; rotation includes the PDF's own page rotation. Text and
highlights use the matching viewport. Saved vertical offsets stay in canonical page coordinates;
rotation maps their proportional vertical position into the current viewport.

Working content remains mounted until replacement pages finish painting. Superseded tasks cancel;
failed replacements retain the prior page and relocation. Pending page navigation survives delayed
resize work, including focus/full-screen transitions. Continuous mode uses lightweight placeholders
for page geometry, correcting estimates while keeping the current page anchored. A binary search
finds the current slot. It retains at most six decoded page surfaces after each navigation settles,
with an aggregate 8,000,000-pixel bitmap budget; single/facing pages each have a 4,000,000-pixel cap.
Detached replacement canvases and sidebar thumbnail work may overlap that steady display budget.
Page-colour inversion is applied to the capped raster before display, in strips of at most 256 KiB
of temporary RGBA data. It does not apply CSS filters to enlarged canvases. Toggling colours uses
the cancellable render queue and keeps the working page/anchor until the replacement is ready;
disabling inversion re-renders the original PDF to avoid cumulative colour loss.
All placeholder nodes, source buffers, PDF worker/font caches and GPU allocations are outside it;
this is not a total-memory ceiling. Neighbor failures are remembered to avoid repeated background
render attempts; an explicit navigation can retry non-stream failures. Stream errors remain final
for the immutable document session, as specified by ADR 0005.

EPUB uses foliate's native paginated/scrolled flows and CFI anchors. Single mode caps columns at one;
facing mode permits two with a narrower column measure and upstream portrait fallback. Scrolled
flow retains one section at a time. Wheel gestures at section boundaries turn sections; accessible
Next/Previous remain the touch and keyboard path. Fixed-layout EPUBs use the documented local
`page-mode` patch, preserve publisher spread metadata, and disable unsupported reflow controls.
Shell shortcuts are forwarded from book documents without changing the book's script policy.

## Evidence and future work

Generated browser regressions exercise actual engines, text/painted pixels, highlights, keyboard
navigation, CSP and offline resume. DOM tests validate adapter lifecycle and race handling but cannot
prove browser layout/CSP enforcement. Corpus runs use checksum-pinned licensed originals outside the
repository and record exact tested pages and known failures.

Remaining certification includes real Android/Safari hardware, broader EPUB spreads/fonts/RTL and
PDF variants, accessibility/assistive technology, and process-memory measurements. Future additional
format adapters must pass the same import/navigation/locator/annotation/recovery gates.
