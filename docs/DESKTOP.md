# Native desktop foundation

The Linux-first Tauri 2 shell runs the same local library and readers with an app-owned original-file store. The desktop build is **local-only**: native account sign-in and cross-device synchronization are unfinished. `VITE_SYNC_URL` is rejected for desktop builds until that authentication boundary is implemented and verified. Browser synchronization remains available as described in [SYNC.md](SYNC.md).

This is a development foundation, not a signed desktop release. Linux runtime, debug packaging, and optimized release packaging checks are recorded below. Windows, macOS, installed-package upgrades, OS distribution compatibility, and physical-device testing remain release work. Format support and import limits still follow [IMPORT-AND-READER.md](IMPORT-AND-READER.md); a native window does not imply broader document compatibility.

## Build and run

Use Node.js compatible with the root `package.json` (CI uses Node 22), npm, Rust **1.90 or later**, and the platform build libraries. On Ubuntu 24.04:

```sh
sudo apt-get update
sudo apt-get install -y libwebkit2gtk-4.1-dev build-essential libssl-dev librsvg2-dev patchelf
npm ci
npm run desktop:dev
```

`desktop:dev` starts Vite in desktop mode and Tauri together. A graphical desktop session is required. Build and validate without installing anything:

```sh
npm run build:desktop
CARGO_BUILD_JOBS=2 npm run test:native
CARGO_BUILD_JOBS=2 npm run check:desktop
cargo fmt --manifest-path src-tauri/Cargo.toml --check
CARGO_BUILD_JOBS=2 npm run desktop:build -- --debug
```

The local package checks run on Arch Linux x86-64 with WebKitGTK 2.54.2. A package built on a rolling distribution is not evidence of compatibility with older Debian/Ubuntu runtime libraries; produce distribution packages on the intended minimum supported distribution (CI uses Ubuntu 24.04).

The last command builds a development `.deb` at `src-tauri/target/debug/bundle/deb/Book Reader_0.1.0_amd64.deb` on Linux x86-64. It was successfully executed locally; the package was not installed. The optimized package was also built with:

```sh
CARGO_BUILD_JOBS=2 npm run desktop:build -- -- --locked
```

It writes `src-tauri/target/release/bundle/deb/Book Reader_0.1.0_amd64.deb`. The earlier 6,208,384-byte redesign archive included the refined library, Settings and reader UI, the heading/navigation labels, and the thumbnail pointer-gesture fix. It was inspected directly: its executable had mode 0755 and matched the bundler's staged executable; its desktop entry and both icons were present. The executable extracted from that archive was launched and tested without installing the package. Its SHA-256 was `9b979e74f4b2a92fc69ee0e4f9e708d352b0cfb8ff263b41e81386bd02150b94`.

The current **6,221,288-byte** package adds smooth shell transitions and shared custom dropdowns.
Its SHA-256 is `fba5af61a62ddf712a0b4b3d1dfb74193ac199171bf85ec70106ebae40b64132`.
The executable extracted from this archive passed a focused Linux Wry 0.57.1/WebKitWebDriver
check in a fresh isolated profile: library dropdown keyboard preview/commit, generated PDF import
and page navigation, portaled reader-theme selection, nested Escape dismissal, and retaining
page 2 of 3 through those settings interactions. The [native menu screenshot](validation/ui-2026-11-07/custom-select-native.png)
shows that running build. This was a focused follow-up, not a repeat of every historical native
check below. Signing, installation and distribution compatibility remain unverified. These hashes
identify individual builds, not reproducibility guarantees.

To compile a directly runnable bundled-asset binary without packaging:

```sh
CARGO_BUILD_JOBS=2 cargo build --manifest-path src-tauri/Cargo.toml --features custom-protocol --locked
```

The binary is `src-tauri/target/debug/book-reader`. A plain `cargo build` selects development assets; use `custom-protocol` for the bundled offline application. CI builds a Linux debug `.deb` with the lockfile enforced and runs the native storage tests. It does not currently run a desktop GUI or install a package.

## Data and durability

Metadata, reading progress, annotations, collections, and the change log remain in the WebView's IndexedDB profile. Native storage replaces only the `BookFileStore` boundary. It does not migrate an existing browser profile automatically. Use a portable backup to move an existing library into the desktop app.

On Linux, originals and derived covers live under `${XDG_DATA_HOME:-$HOME/.local/share}/app.bookreader.desktop/book-files-v1/`. The stable application identifier is part of the persistence contract; changing it creates a different profile. Do not rename it as an upgrade shortcut. Back up the complete desktop profile while the app is closed if making a raw filesystem copy; copying only `book-files-v1` omits metadata. Portable backups are the supported cross-runtime recovery format; their independent limits and behavior are documented in [BACKUP.md](BACKUP.md).

Native file commands accept validated logical keys, never arbitrary paths:

- `books/<64 lowercase hexadecimal SHA-256 characters>.bin`, at most 256 MiB.
- `covers/<bounded safe identifier>.<extension>`, at most 16 MiB.
- Binary IPC chunks are at most 256 KiB; reads and writes validate offsets and sizes.
- Four staged original/cover writes are allowed at once. Listings stop at 100,000 entries.
- A staged original is published only after length and SHA-256 verification, file flush, and filesystem synchronization. Atomic replacement preserves the previous original on an incomplete or corrupt write.
- Reads of originals verify SHA-256 before returning a Blob to a reader. Corruption is surfaced for repair, not silently accepted.
- A process-held exclusive lock rejects a second native instance for the same original store. After acquiring this lock at startup, only regular staging files bearing the app's own temporary prefix are removed. Unknown files and symlinks are left alone.
- Linux app-owned original directories have mode 0700; temporary files and the lock are private. Symlink and special-file entries are rejected. This is a boundary against invalid application inputs, not isolation from another process running as the same OS account.

A native store startup error is fatal rather than silently switching to a separate browser store. Native files are outside browser storage eviction, but the WebView metadata profile still matters. Files are not encrypted at rest. Device loss, account compromise, filesystem corruption, and manual profile deletion still require independent backups.

## Exports and closing

Originals, portable ZIP backups, JSON backups, diagnostics, and Markdown notes use the shared save provider. Browser builds retain normal downloads. Desktop builds use a native Save dialog; Rust retains the chosen destination and returns only an opaque write token to JavaScript. There is no general filesystem-write or native HTTP-proxy capability.

Exports are bounded to 256 MiB, sent in 256 KiB chunks, and checked against their complete SHA-256 digest. A temporary file in the selected directory is synchronized and atomically published only after verification. Cancelling the chooser writes nothing; failed or incomplete exports preserve an existing destination. The dialog handles the user's replacement decision. A forced OS termination can leave a hidden `.book-reader-export-*` temporary file in the chosen directory; it is not a completed backup and may be removed after the app has closed. The application does not scan arbitrary export directories to clean them up.

Normal native close requests wait for registered reader position, reading-time, clock, and export operations. After a failure or a 10-second timeout, a native dialog offers **Keep open** or **Close anyway**. The force-close choice can lose pending reading time or interrupt an export. Position recovery uses the existing bounded local journal, whose limits are described in [IMPORT-AND-READER.md](IMPORT-AND-READER.md). OS kill, power loss, and a WebView crash cannot be intercepted reliably.

## Security and offline assets

Capabilities apply only to the local `main` window: validated original-file commands, dialog-selected exports, local close confirmation, close-event listeners, and window close/destroy. Generic filesystem, shell, external navigation, and credential-proxy APIs are not granted to the page. Book content remains subject to the reader's sandbox and content policy.

`tauri.conf.json` leaves Tauri's additional CSP rewriting disabled (`csp: null`), while the bundled `index.html` carries the tested application CSP generated by `tooling/network-policy.ts`. The desktop policy adds only Tauri IPC sources (`ipc:` and `http://ipc.localhost`); scripts remain same-origin and book frames retain their stricter policy. The policy was inspected in the running packaged WebView. Do not remove the HTML policy or substitute an unrestricted remote frontend. The ordinary dictionary privacy opt-in and build switch still apply.

The native shell uses its bundled assets and does not register a service worker. Native upgrades therefore require a new application package; they cannot be applied by a website service-worker update. Production signing, update provenance, rollback testing, and platform installer behavior must be designed before distribution.

## Native dependency audit

Run the same native lockfile audit as CI with:

```sh
cargo install cargo-audit --locked --version 0.22.2
cargo audit --file src-tauri/Cargo.lock
```

On 2026-11-07, cargo-audit 0.22.2 checked all 416 locked Rust dependencies against the 1,422-advisory RustSec database at revision `309392b18f6b17022f82c701f300433126901068` (2026-11-06 15:34:32 UTC). It reported **zero vulnerability-class findings and two informational warnings**. No advisory ignores or target filters were used. CI fails on vulnerability-class findings and reports informational warnings; the two known warnings are not hidden or treated as resolved:

| Advisory                                                                   | Dependency and impact                                                                                                                                    | Current disposition                                                                                                                                                                                                     |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [RUSTSEC-2024-0370](https://rustsec.org/advisories/RUSTSEC-2024-0370.html) | `proc-macro-error 1.0.4` is unmaintained. It enters through the compile-time `glib-macros 0.18.5` and `gtk3-macros 0.18.2` dependencies.                 | No patched version is listed. Revisit when the Tauri/GTK dependency stack migrates to maintained macros; this is a build dependency maintenance risk.                                                                   |
| [RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html) | `glib 0.18.5` has an unsound `VariantStrIter` implementation that can dereference a null pointer under optimization. The fixed bound is `glib >=0.20.0`. | Tauri 2.12.5 / Wry 0.57.1 use GTK 0.18.2 and WebKit2GTK 2.0.2, which require GLib 0.18. Upgrading GLib alone is incompatible. Keep this warning visible and re-evaluate when the stack supports a patched GLib version. |

A source search of this application and the downloaded native dependencies found `VariantStrIter` / `array_iter_str` only inside GLib's own implementation, documentation, and tests. No application or downstream call sites were found. This is a bounded source inspection, not a proof of universal unreachability or a fix for the upstream unsoundness. No local GLib fork was introduced. The native shell remains a development baseline with this unresolved dependency constraint; audit again after dependency changes and before distributing a release. Cargo audit covers known Rust advisories at the recorded database revision; system WebKitGTK/GTK libraries, JavaScript dependencies, and future advisories need their own ongoing checks.

## Native synchronization still required

A future native sync implementation must preserve the same private account identity as the web client and define an explicit Access authentication flow. It needs browser-to-app return handling, validated state/nonces, token/session lifetimes, sign-out/revocation behavior, secure OS credential storage where credentials are retained, and narrowly scoped server-origin configuration. Do not solve CORS by adding a general native request proxy, placing account tokens in public Vite variables, or disabling Access validation. The deployed Access flow and actual platform credential behavior need their own end-to-end verification.

## Verification evidence and remaining checks

Local checks on 2026-11-07:

- Rust native core: 11 tests passed for storage bounds, ordering, integrity, atomic replacement, locks, interrupted staging cleanup, invalid keys, export cancellation cleanup, and symlink rejection.
- Native file adapter, native export adapter, close lifecycle, and offline-storage focused JavaScript tests: 23 passed. Root TypeScript checking passed after integration.
- Native `cargo check`, bundled-asset binary build, debug `.deb` packaging, and optimized release `.deb` packaging passed with two Cargo jobs and the lockfile enforced.
- Complete native Rust lockfile audit: zero vulnerability-class findings and the two informational dependency warnings documented above; no advisory ignores.
- Actual Linux Wry 0.57.1 / WebKitWebDriver session with an isolated XDG profile: packaged app starts, native IPC responds, EPUB import stores the original in the native directory, generated EPUB content renders, and a restart retains the library.
- Native GTK Save dialog: exported original matched all 1,705 source bytes; portable backup contained the expected original, metadata, and manifest, with valid ZIP CRCs and saved progress/activity metadata.
- Normal native close request immediately after a chapter navigation, while the position journal was still present: the process exited, and reopening retained the exact chapter-2 CFI and 50% fraction. The journal had cleared after commit and reading sessions were retained.
- A second, empty XDG profile restored the portable backup through the application preview/apply flow. The native original matched the source bytes; reading position and activity were recovered, and the restored EPUB opened at its saved position.
- Actual native binary IPC round trip with 524,295 generated bytes across three chunks matched completely. Invalid path keys and ungranted general filesystem commands were rejected.
- Native collection workflow: created a shelf and tag from a book, renamed both inline in Settings, verified focus enters the form and returns to its originating button, and confirmed tag identity and book memberships were preserved.
- Optimized package executable before the visual refinement: launched into the previous native profile, upgraded local database v3 to v4, and retained both books, reading positions, renamed collections, and normalized tag names. A real permission-denied read on a generated test original displayed the underlying filesystem explanation; restoring permission reopened the PDF at its saved page. The final redesigned archive also launched this migrated profile and retained its library and PDF position.
- Basic generated two-page PDF: native import, visible cover thumbnail, page-one rendering, and next-page navigation to a visibly rendered page two passed. Screenshots were inspected; this does not establish complex-font/corpus coverage.
- Final rebuilt archive, deterministic native WebKit thumbnail regression: held the pointer down on the second-page placeholder, released the delayed real thumbnail encoding so the placeholder became an image, and then released the pointer. The stable button received the gesture, page two became current, and the reader rendered `Page 2 of 2`. Decorative thumbnail image and label elements had the expected `pointer-events: none` style.
- Final redesigned archive: library, light/dark Settings and PDF reader screenshots were inspected. Settings opened Advanced diagnostics and Backup options correctly; native durable storage and local schema 4 were shown. Renaming a generated tag focused its input, and cancelling returned focus to its original button. The final reader had its page heading and the book breadcrumb retained its distinct accessible name.
- The final archive exported JSON through **Backup options & limits → Export library as JSON** and the actual native Save dialog. The resulting file parsed and contained both generated books. Re-importing the generated PDF through the WebDriver file input retained the two-book library; this checks the input/import pipeline, not the native HTML file-picker dialog, which was not exposed during the attached WebDriver session.

The Linux local-only desktop baseline slice is complete with the evidence above. These checks do not establish full desktop release readiness. Broader format and PDF corpus behavior must also be tested in the native WebView. Distribution still requires installed-package upgrade checks, accessibility, desktop integration, signing, and OS-matrix checks. Native account authentication and sync remain gated on the separate design and verification described above. The in-place metadata migration check is not an installer test. The actual GUI checks used a locally installed `tauri-driver` with the system `WebKitWebDriver`, isolated `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, and `XDG_CACHE_HOME` directories, and GTK AT-SPI for native Save dialogs. They were ad hoc runtime verification, not a checked-in automated GUI regression suite. The normal browser suites do not launch the native binary.
