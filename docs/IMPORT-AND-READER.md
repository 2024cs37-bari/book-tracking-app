# Import and reader

## 1. Format policy

| Format    | Initial status                | Engine / approach                     | Required validation                                                                                                                                                                                                                               |
| --------- | ----------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EPUB      | Implemented, experimental     | foliate-js snapshot `78914aef`        | Generated EPUB 2/3/RTL/assets/CSP/offline checks plus pinned Moby-Dick and SVG in Spine samples. Selected TOC/font/SVG-spread navigation and mobile-sized measurements; broader layouts, obfuscated fonts and physical-device validation pending. |
| PDF       | Implemented, experimental     | direct pdf.js `5.4.624`               | Generated text/rotation/page-size checks, 240-page shared-image raster stress, and pinned Hello World PDF paint/zoom/offline checks. One canvas/pixel bounds measured; diverse real/image-heavy PDFs and physical-device profiling pending.       |
| MOBI      | Experimental validation spike | foliate-js capability to be confirmed | DRM-free corpus across legacy variants; import behavior independent from rendering.                                                                                                                                                               |
| AZW3/KF8  | Experimental validation spike | foliate-js capability to be confirmed | DRM-free corpus and webview compatibility; do not advertise until pass.                                                                                                                                                                           |
| FB2 / CBZ | Deferred                      | Candidate foliate-js support          | Explicit feature decision and fixture coverage required.                                                                                                                                                                                          |

DRM-protected inputs are unsupported. Never bypass DRM. An extension alone is not proof of format; sniff content and report mismatches.

Evidence is reproducible in `tests/reader/*.dom.test.ts` and `tests/browser/reader.spec.ts`,
using in-memory generators in `tests/support/fixtures.ts`. Selected upstream Moby-Dick, SVG in Spine
and Mozilla Hello World originals are also pinned and checked by the external corpus suite; see
[Reader validation](READER-VALIDATION.md) for provenance, hashes and precise scope. EPUB/PDF Read
actions are enabled because their adapters are implemented and basic reading is verified; the UI
explicitly labels their wider support experimental.
MOBI/AZW3 have no registered adapters; FB2/CBZ reading remains unimplemented.
See [ADR 0003](decisions/0003-reader-engines.md) for the full upstream SHA and npm provenance decision.

All 39 browser checks (13 cases × 3 engines) passed in
[CI run 37742014444](https://github.com/2024cs37-bari/book-tracking-app/actions/runs/37742014444).
These are generated-fixture results on the CI runner, not real-file conformance or Safari/iOS
hardware certification. Durable offline originals use the probed OPFS/IndexedDB selection in
[ADR 0004](decisions/0004-durable-file-fallback.md).

## 2. Import pipeline

1. User selects a file or supported drop target.
2. Validate file size and inspect content signature/container safely.
3. Stream bytes to a temporary local file while computing SHA-256 when possible.
4. Detect duplicate hash locally; later optionally query remote availability after authentication.
5. Extract metadata and cover using bounded parsing. Treat all embedded content as untrusted input.
6. Use filename-derived title and set `metadata_incomplete` when extraction is partial; do not reject otherwise readable books solely for missing metadata.
7. Verify stored bytes hash and finalize local file-store entry using a crash-recoverable import journal.
8. Commit book metadata and outbox change atomically in the local database.
9. Queue remote upload when sync is configured; do not block user from reading locally.
10. Report imported, duplicate, unsupported, incomplete, or failed outcomes per file.

Never call external metadata services without user-visible disclosure and an opt-in or clear product policy. Open Library enrichment is deferred; if added, send only necessary query fields and allow local-only operation.

### Duplicate metadata policy

Byte-identical files map to one `sha256` identity. Re-import must not replace useful metadata with empty or lower-quality extracted values. User-edited values should be distinguished from machine-extracted values before implementing automatic enrichment merges.

## 3. Renderer boundary

The application reader shell depends on a renderer interface rather than format-specific library APIs:

```ts
interface Renderer {
  mount(host: HTMLElement): void;
  open(file: Blob, startAt?: Locator): Promise<void>;
  prev(): void;
  next(): void;
  goTo(locator: Locator): void;
  getToc(): Promise<TocItem[]>;
  onRelocate(callback: (locator: Locator, fraction: number) => void): () => void;
  search(query: string, signal?: AbortSignal): AsyncIterable<SearchHit>;
  applySettings(settings: ReaderSettings): void;
  destroy(): void;
}
```

Adapters own engine lifecycle, event translation, settings mapping, search cancellation, and locator serialization. `destroy()` must release listeners, workers, object URLs, and page resources. Opening a different format selects one adapter based on validated content, not repeated UI checks.

Each session owns a fresh adapter: mount once, open once, destroy on close. `prev()`/`next()`
are explicit contract additions for the reader toolbar. Adapters dispatch `reader-message` on
the mount host to report asynchronous navigation errors or approximate restoration; the shell
displays these messages. EPUB exposes engine TOC as CFI locators, rendered as nested lists with
native buttons and a collapsible contents panel. EPUB 2 NCX and EPUB 3 navigation documents,
including fragment anchors, are verified with generated fixtures. Keyboard activation returns focus
to the panel summary, and navigation persists/restores through the existing progress pipeline.
Missing chapters/fragments and external links have no locator and are disabled; labels are rendered
as text. TOC conversion is cached per session, sequential and retains at most one parsed section.
Contents errors are reported separately and do not prevent reading. PDF returns an empty TOC,
shown as unavailable rather than a fabricated outline. Both `search()` implementations reject iteration because
in-book search is deferred.

### Untrusted book content

`index.html` installs CSP before app scripts: `script-src 'self'`, `object-src 'none'`,
`base-uri 'none'`, bounded resource origins and no form submissions. Blob frames inherit it.
The EPUB adapter additionally inserts `script-src 'none'` and `connect-src 'none'` before
foliate creates content URLs, strips active embedding/base/refresh elements, and removes SVG
scripts/foreignObject. Inline styles are allowed for book layout and user settings; inline scripts
are never allowed. Upstream iframe sandbox flags are not relied on for security.
Blob stylesheets are allowed by both app and book policies so embedded CSS can apply; scripts
remain restricted to self at app level and none in book documents. Decoded PNG pixels and a
successfully loaded synthetic font are asserted, rather than inferring support from URLs or CSS
font-family strings. Fixed-layout frames also exercise inline-script blocking.
EPUB input/expanded content is capped at 256 MiB and each archive entry at 64 MiB.
Chromium verifies the hostile script stays unexecuted while actual book text renders.

## 4. Locator model and progress

Conceptual locator:

```ts
type Locator = {
  kind: 'cfi' | 'pdf';
  value: string;
  fraction: number; // normalized 0..1 fallback across screens/formats
};
```

- EPUB positions use CFI or the engine's stable equivalent plus fraction.
- Package-only CFIs (no `!` content path), used by chapter-level TOC entries and fixed-layout pages,
  restore the spine item at anchor zero. They must not be passed to a document-range resolver or
  silently replaced by a percentage approximation.
- MOBI/AZW3 locator behavior is engine-specific and must be validated.
- PDF stores page and vertical offset plus fraction; page alone is inadequate for different layouts/zoom.
- PDF page is zero-based; vertical offset is rounded PDF viewport points at scale 1 (after rotation),
  independent of display zoom. Fraction is `(page + offset/pageHeight) / pageCount`.
- Persist fractions with every native locator and validate finite `[0, 1]` values.
- If a locator cannot resolve after a file mismatch or renderer upgrade, fall back to fraction and tell the user when restoration is approximate.
- A content hash change creates a different original; annotations/progress are not silently attached to it.

## 5. Reading features

### MVP

- Open supported locally available EPUB/PDF.
- Restore progress on open and persist relocation locally with a debounce appropriate to avoid excessive writes.
- Table of contents may be included only if the selected library provides reliable access; it is not allowed to delay basic open/progress delivery.
- Provide font size/theme/margins for reflowable content and zoom for PDF, with defaults that remain usable.

### Later

- Highlights, notes, bookmarks with kind, quote excerpt when available, color, timestamps/HLC, and locator.
- In-book search must be cancellable, asynchronous, and bounded in memory.
- Settings should be per-user defaults with a future option for per-book overrides; do not persist screen-specific pagination as a stable locator.

Current saves debounce 400 ms, serialize repository writes and flush pending positions on reader
close, pagehide and visibility hide. Close starts a durable write; abrupt process termination can
still interrupt a browser transaction. Save errors are displayed rather than treated as success.
Settings are localStorage device defaults (font size, line height, margin, theme); font size maps to
PDF zoom, and PDF page typography remains fixed.

Fixed-layout EPUB currently preserves publisher typography and page geometry, fits each page to
the reader surface and applies theme to the backdrop. The reader displays this limitation; font
size, line height and margins do not reflow those pages. Generated validation uses
`rendition:spread=none` with 600×800 XHTML pages; multi-page spreads and SVG spine items remain
separate validation work. Missing/malformed image/font resources are checked for usable text and
chapter navigation; this is graceful degradation, not a claim to repair damaged books.

## 6. PDF performance and safety

Render visible pages first, cap canvas and decoded image memory, release pages outside the viewport, and avoid loading a whole large document into UI state. Use range reads only if the local storage/engine path supports them correctly; a Blob-backed file may not provide network-style ranges. Measure on representative mobile hardware.

PDFs and archives are untrusted. Keep parser dependencies current, isolate workers as supported, apply size and resource limits, and handle parser errors without corrupting the library.

The implemented PDF UI paginates one page at a time. It requests only that visible page, keeps one
page/canvas in the adapter, cancels superseded renders, zeroes old canvases and calls page/document
cleanup on navigation. Rasterization is capped at 4,000,000 pixels, device pixel ratio at 2 and
decoded-image size at 4,000,000 pixels. Worker and font/CMap/decoder assets are bundled locally.
pdf.js still holds original document bytes and parser structures; this is not a hard cap on total
process memory. Blob-backed loading uses a whole-file byte buffer, not range reads. Large-image
PDFs, WASM-based decoders under the strict CSP, text selection, forms and mobile performance are
not yet validated or claimed. `isEvalSupported` is disabled.

## 7. Regression corpus

Maintain test fixtures that are legally distributable or generated for testing. Include:

- EPUB 2 and EPUB 3, absent/partial metadata, cover variants, large image, embedded fonts, RTL content, malformed container.
- PDF with many pages, varying page dimensions, rotation, large images, malformed content, and text/no-text cases.
- DRM-free MOBI and AZW3 variants only if support is being evaluated.
- Wrong extension, duplicate bytes, truncated file, and oversized file cases.

For each supported fixture, test import metadata, open, TOC, locator round-trip, search where claimed, memory behavior, and error cleanup. Record engine version and expected results. Do not check copyrighted books into the repository.

The separate `corpus:fetch` command downloads unmodified, checksum-pinned originals outside the
workspace; `test:corpus` runs small-viewport cross-browser checks and emits measurement JSON.
This adds selected-file evidence, including actual SVG spine content and Moby-Dick fonts; it is
not broad conformance or physical-mobile certification. The 240-page image PDF stress workload is
generated, while the real PDF corpus is currently only a small upstream demo.

## 8. Metadata enrichment

Automatic enrichment is optional and later. It must not overwrite user edits, must disclose network use, must have sensible rate limits, and must work as an optional enhancement rather than import dependency. Use identifiers such as ISBN when available; title-only matches need user confirmation if ambiguity is material.
