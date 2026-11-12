# Installing and updating the offline app

The application is an installable web app for EPUB and PDF reading. Its shell,
reader engines, fonts, and PDF support assets are cached locally after the first
successful online load of a production build. Original books use the separate
file store and must be saved on each device before offline reading.

## Install and verify

Open the deployed HTTPS application and wait for the footer to say **App ready
offline**. Chromium-based browsers offer an install action in the address bar or
browser menu. On iOS/iPadOS Safari, use Share → Add to Home Screen. Installation
availability and exact labels depend on the browser. Firefox desktop can use the
offline site without offering the same standalone install control.

A manifest, 192/512 PNG maskable icons, a scalable SVG icon, and a touch icon are
included. Installation is a browser-managed convenience, not native desktop
packaging or a guarantee against local storage eviction.

Import or download a book, open it successfully, then test it with the device
offline. A library entry synced from another device does not imply its original
file is present locally. Keep independent original files and metadata backups;
clearing browser/site data can remove both the shell and the local library.

## Updates protect active reading

Each build has a separate cache containing its complete app shell. Installation
verifies SHA-256 integrity for every asset before accepting that build. A partial
or inconsistent deployment cannot replace the current working cache.

When a new build is ready, the footer asks you to finish reading and close all
app tabs/windows. The new service worker waits until no page is using the old
worker. It never calls `skipWaiting`, forces a reload, or mixes new reader-engine
assets into the old reader. On the next opening the new worker serves its own
shell and removes obsolete shell caches.

A reload while an old controlled tab remains open intentionally keeps that
version. Closing only one of several tabs may not activate the update. Books,
annotations, and reading progress are not stored in these shell caches and are
not removed during a shell update.

Long-lived tabs check for updates when brought back into view, at most once an
hour, in addition to normal browser navigation checks. Failed update checks
leave the existing shell usable. If initial shell caching fails, the footer says
so; successful local book storage alone does not establish offline app readiness.

## Privacy and deployment requirements

- The shell cache contains a fixed, build-generated list of static assets.
  Private API requests, `/api/*` navigation, Cloudflare Access endpoints, and
  arbitrary fetched content never enter it. API responses remain non-cacheable.
- All production assets and `sw.js` must be reachable at the frontend origin.
  Serve JavaScript, manifests, fonts, WASM, and icons with appropriate content
  types. Deploy the complete build together; integrity checks intentionally
  reject a build whose assets are unavailable or from a different version.
- Serve `sw.js` with revalidation/no-cache headers at the hosting layer. The
  registration uses `updateViaCache: 'none'`. Do not place a CDN rule in front of
  it that ignores revalidation and permanently freezes one build.
- HTTPS is required except loopback development/testing. Development Vite does
  not install the production shell, so it cannot establish offline deployment
  behavior. Use `npm run build && npm run preview` for local production checks.
- Host the application at the origin root. Subpath hosting needs coordinated
  Vite base, router base, asset paths, manifest scope, and API routing changes;
  it is not currently a supported deployment mode.

## Maintaining the shell

`tooling/reader-assets.ts` emits PDF support assets and files from `public/`, then
builds the integrity list and worker. `vendor/` remains Vite's public directory
for pinned reader-engine files. `tooling/service-worker.ts` owns the worker
behavior; its source also contributes to the cache version. PNG icons can be
regenerated from the code-native design with `python3 tooling/generate-icons.py`
without third-party tools.

`tests/browser/pwa.spec.ts` exercises the actual generated worker in a browser:
an old reader stays usable offline while an update waits, the new build activates
after old clients close, a corrupt subsequent build preserves the working cache,
and API requests/navigation bypass shell caching. It also checks the production
manifest and decoded icon dimensions. Run with `npx playwright test
 tests/browser/pwa.spec.ts` after installing the selected browsers.

These browser tests do not establish operating-system install prompts, physical
mobile storage behavior, or long-term background retention. Include those checks
on the intended devices before calling a deployment fully validated.
