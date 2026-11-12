# Vendored source

`foliate-js/`: https://github.com/johnfactotum/foliate-js,
commit `78914aef4466eb960965702401634c2cb348e9b1`, fetched using the GitHub Git tree/blob
API. Root JavaScript modules, README, LICENSE, vendor/zip.js and vendor/fflate.js are
byte-identical to upstream except `paginator.js` and `fixed-layout.js`, which have the local patches below.
See ADR 0003 for scope and license information.

Bundled-dependency license notices were added from their respective upstream
LICENSE files (gildas-lormeau/zip.js and 101arrowz/fflate); they are not source patches.

## Local patch: paginator lifecycle guards

`paginator.js`: avoid rendering/expanding a frame with no live document/body, and guard deferred
animation-frame/font-ready callbacks after renderer teardown. Browser regression
`late font-ready callbacks cannot render replaced or closed chapter frames` reproduces the
unpatched TypeErrors and verifies cleanup. The base remains the SHA above; on upgrade compare
this file against upstream and retire the guards only when the regression passes without them.
Queued scroll/resize relocation also skips ranges when the frame has no body, preventing the
CI-observed `createTreeWalker` null-root error during reload/teardown.

## Local patch: explicit fixed-layout page mode

`fixed-layout.js` observes `page-mode` and rerenders when it changes. `single` forces one page;
`double` enables the publisher spread at reading-area widths of at least 700 CSS pixels, otherwise
falling back to one. Missing attributes retain upstream automatic orientation. Publisher
centered/single-page metadata and logical page grouping remain authoritative. The adapter always
uses fit-page for this format. The mode browser regression covers both controls and the licensed
SVG-in-Spine corpus continues to cover fixed-layout navigation/offline resume. Review this patch
against a new upstream snapshot before upgrading.
