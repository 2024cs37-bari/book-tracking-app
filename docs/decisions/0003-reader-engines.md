# ADR 0003: Reader engines and untrusted content

- **Status:** Accepted
- **Date:** 2026-10-08

## Decision

Vendor native ES modules from https://github.com/johnfactotum/foliate-js at commit
`78914aef4466eb960965702401634c2cb348e9b1` (MIT) in `vendor/foliate-js`.
This is a source snapshot, served locally, with no runtime CDN dependency. Upstream has
no official release and recommends a git submodule; a checked-in snapshot makes clean
checkouts and offline builds independent of submodule initialization.

Reject npm `foliate-js@1.0.1`: it is a third-party republish maintained by `shmandadi`
(saiprakash.mandadi@skillsoft.com), despite its repository field pointing to upstream.
It is not an upstream release or provenance guarantee.

The snapshot contains upstream root JavaScript modules, README, LICENSE, and bundled
zip.js (BSD-3-Clause) / fflate (MIT). Upstream's PDF.js assets (Apache-2.0), demo HTML,
tests, and tooling/package manifests are omitted. Its proof-of-concept PDF adapter is
never selected. PDF uses the official `pdfjs-dist@5.4.624` package (Apache-2.0) directly instead,
pinned exactly in package.json/lockfile and compatible with the project's Node baseline.
Retain upstream source verbatim except narrowly scoped, documented compatibility patches;
keep integration code in `src/reader`. `vendor/PROVENANCE.md` records the paginator lifecycle
guards required after asset tests reproduced deferred font-ready callbacks touching closed frames.
Updates must
record a new full SHA, review upstream changes, and rerun security and fixture checks.

## Security and consequences

Install app CSP before any renderer. Blob frames inherit it; the EPUB adapter adds a
stricter book policy (`script-src 'none'`, no connections, no objects or forms) before
content receives a URL. Upstream's `allow-same-origin allow-scripts` sandbox is not a
security boundary. Inline styles are needed for layout and reader settings.

foliate-js is unstable and targets latest Chromium/Firefox/WebKitGTK; Firefox ESR and
older engines are unsupported upstream. It stays behind `Renderer`; neither UI nor
services import it. Generated fixtures are evidence for basic reading, not proof of
full EPUB/PDF conformance. Real-file corpus/browser/mobile validation remains pending.
