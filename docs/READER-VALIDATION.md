# Reader corpus and measurements

## 1. Reproducible external corpus

The original files are fetched explicitly, unmodified, into an external temporary directory.
Nothing in this corpus is committed or shipped with the application. Acquisition and every test
read verify SHA-256; changed release assets, oversized downloads and tampered cache files fail.
`npm run check` remains network-free; `corpus:fetch` is a separate network-dependent command.

```bash
export BOOK_CORPUS_DIR=/var/tmp/opencode/reader-corpus
npm run corpus:fetch
npm run test:corpus                   # all three engines, mobile-sized viewport
npm run test:corpus -- --project=chromium
```

The default cache is `book-tracking-corpus-v1` under the OS temporary directory. A cache path inside
the repository is rejected. CI uses `runner.temp`, fetches pinned originals and retains JSON
measurement artifacts, not downloaded books. Downloaded archives retain their embedded credits,
font notices and licensing; `PROVENANCE.json` beside the files records the acquisition manifest.

| Sample              | Exact upstream source                                                                                  | License / attribution                                                                                                                                  | Evidence sought                                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Moby-Dick           | IDPF EPUB Samples release `20230704`, `moby-dick.epub`                                                 | CC-BY-SA-3.0 as declared in `OPS/package.opf`; Herman Melville, markup by Dave Cramer, EPUB Samples project. Original font/copyright notices retained. | Title import, chapter-level TOC, actual text and loaded embedded font, native CFI navigation and offline resume.                     |
| SVG in Spine        | Same release, `svg-in-spine.epub`                                                                      | CC-BY-SA-3.0 overall; selected images/pages CC-BY-3.0 as declared in OPF. ePub Sample project / Takeshi Kanai; original individual credits retained.   | Visible SVG content, fixed-layout spread navigation, native CFI and offline resume.                                                  |
| Mozilla Hello World | `mozilla/pdf.js` commit `89b500f5e1d98ed89bb90211e45b28730b2d99ac`, `examples/learning/helloworld.pdf` | Apache-2.0, Mozilla pdf.js contributors; upstream learning example.                                                                                    | Actual painted text pixels, zoom/vertical-offset persistence and offline reload. A small one-page demo, not a large-document corpus. |

Upstream license evidence: [EPUB Samples README at a pinned source commit](https://github.com/IDPF/epub3-samples/blob/7651e2002b631e6577fadf7e9e0692fa6efb8746/README.md),
[sample table](https://github.com/IDPF/epub3-samples/blob/0624b513cdd6d2aaaca4ad6e106980b8d6cb2852/30/samples.html),
individual EPUB package documents, and [Mozilla license at the pinned commit](https://github.com/mozilla/pdf.js/blob/89b500f5e1d98ed89bb90211e45b28730b2d99ac/LICENSE).

| File                | SHA-256                                                            |
| ------------------- | ------------------------------------------------------------------ |
| `moby-dick.epub`    | `81bc079841a38e91a02a7776d04786a2fc311cfd300064e9fc533ce7c54cf7b4` |
| `svg-in-spine.epub` | `ed6b1b9e99245ac7747ced1a2f90bad1acab558280cffc7daed3e54ee48e49bb` |
| `helloworld.pdf`    | `c9efcaa374939ff19fc37974131f1db6d457eb942700c02a63fc9dda983e1400` |

The authoritative machine-readable manifest is `tooling/corpus-manifest.ts`. Updates need new
hashes, a provenance/license review and another actual-engine run. No sample may be silently
repacked or substituted. Corpus tests live in `tests/corpus/reader.spec.ts` and `tests/corpus/pdf.spec.ts`.

### Expanded PDF corpus

The PDF suite adds unmodified, independently hash-verified originals. OCRmyPDF is pinned at
`58048daf960472e944caf4aefec904c6f3481245`; its
[REUSE declarations](https://github.com/ocrmypdf/OCRmyPDF/blob/58048daf960472e944caf4aefec904c6f3481245/REUSE.toml)
provide per-file licensing, rather than assuming the software license covers scans.

| Sample                              | Pages / checks                                                                                                               | License and original attribution                                                                                                                                                                                       |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GNU Make 4.4.1 manual, Edition 0.77 | 229 pages recognized; first 12 checked, including intentional blanks at 2/6/12; embedded Type 1 text, page 11 offline resume | GFDL-1.3-or-later with original cover-text requirements; FSF, Richard M. Stallman, Roland McGrath, Paul D. Smith. Exact February 2023 PDF at the canonical GNU URL pinned by hash; upstream updates fail verification. |
| OCRmyPDF `multipage.pdf`            | 6-page scan/image assembly; painted pages 1/3/4/5/6, decode-limited page 2, mixed geometry and offline resume                | Public domain per upstream REUSE declaration; original credits retained.                                                                                                                                               |
| OCRmyPDF `3small.pdf`               | 3-page image assembly; painted pages 1/2, decode-limited page 3; very different page sizes                                   | CC-BY-SA-4.0 plus CC-BY-SA-3.0 component alternative; Euskaldunaa, James R. Barlow, Ellywa; original composite licensing terms retained.                                                                               |
| Mozilla `hello_world_rotated.pdf`   | All five letter pages with `/Rotate 90`; rotated raster aspect, painting and offline resume                                  | Apache-2.0, Mozilla pdf.js contributors; same pinned commit as Hello World.                                                                                                                                            |
| OCRmyPDF `invalid.pdf`              | Intentional 44-byte invalid structure: explicit open error, no canvas/locator, original retained                             | CC-BY-SA-4.0, James R. Barlow.                                                                                                                                                                                         |

| External cache filename | SHA-256                                                            |
| ----------------------- | ------------------------------------------------------------------ |
| `gnu-make.pdf`          | `a4bc06026984382815e392159e60a4bc356cac6c5b81e5ae84fa4f58f621f4d3` |
| `ocr-multipage.pdf`     | `07987c44650938fa8dcf08c0937691712fdd800669b4607c2c7e3fee21cb1f80` |
| `ocr-mixed.pdf`         | `7277728ba5990f6da8a4a850f9f7963f57740dd526b51d8b7e0171abd8381840` |
| `mozilla-rotated.pdf`   | `ab0cb700cd5e5338fd676dfca25becae800acd2be03a4e57856485b8cfd2d28b` |
| `ocr-invalid.pdf`       | `60abfda66889f7ea7721f5b25bf5c189440a988411cb5363c0f616c800f1d889` |

Source images of 81,000,000 and 11,456,000 pixels exceed the intentional 4-million-pixel decode
cap. Those pages fail visibly rather than silently becoming successful blank pages, preserve
the last usable position and permit navigation away. They are known reading limits, not passing
image-rendering claims. [ADR 0005](decisions/0005-pdf-render-errors.md) records the scoped pdf.js
stream-error bridge and upgrade requirements. The GNU manual's remaining 217 pages are not
visually certified by this slice.

## 2. Mobile-sized measurement protocol

All corpus projects use a 390×844 viewport, DPR 2 and touch capability. They still run desktop
Chromium/Firefox/Playwright WebKit engines: this is **not physical mobile hardware validation**.
Chromium additionally requests CDP CPU throttling at rate 4; Firefox/WebKit are unthrottled.
Do not compare their timings as equivalent device performance.

Each run emits `READER_MEASUREMENTS` JSON with browser version, viewport, throttle settings,
input size, workflow timings, available JS heap and long-task observations. TestInfo attachments
become the CI `reader-measurements` artifact. Timing is observational, not a flaky CI latency gate.
Correctness and resource bounds are hard assertions.

Limitations:

- Import/open workflow times include browser boot, test automation, DataTransfer materialization
  and library navigation. Interaction-and-save includes the 400 ms save debounce. They are not
  first-contentful paint, LCP, INP or isolated renderer CPU time.
- Long-task data covers only the current document since its last navigation/reload and includes
  test instrumentation. Unsupported APIs return `null`, not a claim of zero blocking work.
- Chromium's non-standard JS heap snapshot excludes worker/native/GPU allocations, is affected by
  GC and is not peak process memory. Other engines may return `null`.
- `canvas.width × canvas.height × 4` estimates RGBA canvas backing only. It excludes the original
  file, decoder buffers, caches, font allocations and GPU copies. Total process memory is uncapped.

The generated stress PDF has 240 pages sharing a real 1200×1600 Flate-compressed RGB image.
`tests/support/fixtures.ts` builds it in memory. Tests verify decoded image pixels, 12 completed page
turns, one cached canvas, the 4-million-pixel cap and no canvas after close. PDF canvases advertise
`data-render-state=ready` only after the pdf.js render task finishes, so timings cannot stop at
allocation of a blank canvas. This is a controlled image-decode/page-cache test; it does not
represent 240 distinct large images or a real publisher PDF.

### Initial local observation

On 2026-10-08, desktop Linux Chromium `156.0.8078.4`, the viewport/throttle above:

| Workload            | Import/open or first render | Interaction/page turn                      | Resource observation                                       |
| ------------------- | --------------------------- | ------------------------------------------ | ---------------------------------------------------------- |
| Moby-Dick           | 2.41 s                      | 0.93 s including progress save             | 1,628,868-byte original                                    |
| SVG in Spine        | 1.58 s                      | 1.01 s including progress save             | 687,362-byte original                                      |
| Hello World PDF     | 1.19 s                      | 1.05 s zoom/scroll/save                    | 678-byte original                                          |
| Generated image PDF | 2.49 s                      | 165 ms median / 186 ms max across 12 turns | 440,920 pixels; 1,763,680 estimated RGBA bytes; one canvas |

These are a single-run observation, not a service-level objective or a cross-device guarantee.
Use the per-run CI JSON rather than assuming these numbers reproduce on another host.

## 3. Remaining real-device work

Run the same pinned originals on an actual Android phone and an iPhone/iPad, without desktop CPU
throttling. Record model, RAM, OS/browser, orientation, renderer commit, input hashes and whether
the app shell was warm. Import once, disconnect network, navigate and close/reopen/reload.
Measure first usable content and repeated turns, use platform process/worker memory tooling,
and inspect memory after close and repeated reopen. Capture at least five repetitions and report
median/worst values, not just a favorable run. Do not upload private book data with diagnostics.

Physical devices, additional real/image-heavy PDF variants and oversized-image handling, obfuscated fonts, other EPUB layout variants,
accessibility and conformance-wide claims remain pending. EPUB/PDF stay experimental despite
these selected-file results.
