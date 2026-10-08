# Import and reader

## 1. Format policy

| Format    | Initial status                | Engine / approach                     | Required validation                                                                 |
| --------- | ----------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------- |
| EPUB      | MVP target                    | foliate-js adapter, pinned version    | EPUB 2/3, metadata variants, large images, fonts, RTL, navigation.                  |
| PDF       | MVP target                    | pdf.js adapter                        | Large documents, rotation, varied page sizes, range/cache behavior.                 |
| MOBI      | Experimental validation spike | foliate-js capability to be confirmed | DRM-free corpus across legacy variants; import behavior independent from rendering. |
| AZW3/KF8  | Experimental validation spike | foliate-js capability to be confirmed | DRM-free corpus and webview compatibility; do not advertise until pass.             |
| FB2 / CBZ | Deferred                      | Candidate foliate-js support          | Explicit feature decision and fixture coverage required.                            |

DRM-protected inputs are unsupported. Never bypass DRM. An extension alone is not proof of format; sniff content and report mismatches.

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
  open(file: Blob, startAt?: Locator): Promise<void>;
  goTo(locator: Locator): void;
  getToc(): Promise<TocItem[]>;
  onRelocate(callback: (locator: Locator, fraction: number) => void): () => void;
  search(query: string, signal?: AbortSignal): AsyncIterable<SearchHit>;
  applySettings(settings: ReaderSettings): void;
  destroy(): void;
}
```

Adapters own engine lifecycle, event translation, settings mapping, search cancellation, and locator serialization. `destroy()` must release listeners, workers, object URLs, and page resources. Opening a different format selects one adapter based on validated content, not repeated UI checks.

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
- MOBI/AZW3 locator behavior is engine-specific and must be validated.
- PDF stores page and vertical offset plus fraction; page alone is inadequate for different layouts/zoom.
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

## 6. PDF performance and safety

Render visible pages first, cap canvas and decoded image memory, release pages outside the viewport, and avoid loading a whole large document into UI state. Use range reads only if the local storage/engine path supports them correctly; a Blob-backed file may not provide network-style ranges. Measure on representative mobile hardware.

PDFs and archives are untrusted. Keep parser dependencies current, isolate workers as supported, apply size and resource limits, and handle parser errors without corrupting the library.

## 7. Regression corpus

Maintain test fixtures that are legally distributable or generated for testing. Include:

- EPUB 2 and EPUB 3, absent/partial metadata, cover variants, large image, embedded fonts, RTL content, malformed container.
- PDF with many pages, varying page dimensions, rotation, large images, malformed content, and text/no-text cases.
- DRM-free MOBI and AZW3 variants only if support is being evaluated.
- Wrong extension, duplicate bytes, truncated file, and oversized file cases.

For each supported fixture, test import metadata, open, TOC, locator round-trip, search where claimed, memory behavior, and error cleanup. Record engine version and expected results. Do not check copyrighted books into the repository.

## 8. Metadata enrichment

Automatic enrichment is optional and later. It must not overwrite user edits, must disclose network use, must have sensible rate limits, and must work as an optional enhancement rather than import dependency. Use identifiers such as ISBN when available; title-only matches need user confirmation if ambiguity is material.
