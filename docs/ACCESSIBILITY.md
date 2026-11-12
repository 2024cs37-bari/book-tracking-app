# Accessibility and responsive verification

The application includes an automated accessibility regression suite and keyboard checks. These tests provide specific engineering evidence; they are not assistive-technology certification or a claim of complete WCAG conformance.

## Running the checks

```sh
npm ci
npx playwright install chromium
npm run test:accessibility
```

The dedicated configuration starts an isolated development server on `127.0.0.1:4195`, with sync and external dictionary lookup disabled. `ACCESSIBILITY_TEST_PORT` overrides that port. It does not modify a production build or use personal books. Output and failure traces live in ignored `.accessibility-test-results/`, separate from other Playwright suites.

`tests/accessibility-browser/views.spec.ts` imports a generated three-chapter EPUB, creates a shelf and a maximum-length unbroken tag through the UI, and seeds an explicit generated reading-session fixture to populate the daily statistics table. At both 1280 px and 390 px widths it checks:

- Book details and the open metadata edit form.
- The populated library, Settings and populated reading statistics.
- The collection rename form, initial input focus and focus return after cancellation.
- Reader controls with the sidebar open and closed.
- Document-level horizontal overflow.

Axe-core runs rules tagged WCAG 2 A, WCAG 2 AA and WCAG 2.1 AA. The regression gate rejects serious and critical violations. The reader's `.reader-surface` subtree is explicitly excluded: arbitrary imported publication content and the third-party renderer inside it are outside this chrome-focused audit. Application toolbar, sidebar, tab panels, settings and navigation remain included. No application-control rule is disabled.

The keyboard case checks that the first Tab reaches the skip link, activating it moves focus into main content, reader panel tabs support Left/Right/Home/End with roving focus, the sidebar separator can resize using the keyboard, and closing the sidebar restores focus to its toggle. Theme coverage checks dark mode and the Amber preset; separate unit tests verify all accent presets plus boundary custom colors against the light/dark surface palettes.

## Improvements made by this audit

- The skip link explicitly focuses the main landmark. The router's hash navigation only scrolled and left focus on the link, even when the target had a negative tabindex.
- The sidebar close button sits outside the ARIA tablist. Tabs have connected IDs, selected state, one keyboard tab stop and a labelled tab panel. Arrow/Home/End keys select and focus tabs without also turning a book page.
- Sidebar resizing exposes its current/minimum/maximum width and keyboard controls. Closing it returns focus to the opener.
- Long tags wrap in book details and collection management; library selectors stay inside the viewport even with maximum-length labels. Renaming uses an inline form with explicit focus rather than a browser-only prompt.
- Accent button text uses WCAG relative luminance instead of a brightness heuristic. The previous Amber background with white text had a 3.34:1 contrast ratio; a suitable dark foreground now meets 4.5:1. Some midtone colors require pure black rather than near-black.
- Accent-colored text and focus outlines use a separate contrast-adjusted `--accent-ink` token. The requested accent still colors button backgrounds. Ink is recomputed against all application surfaces when theme/accent changes, including operating-system theme changes while following the system preference.

## Refined navigation and settings

Each main view has a descriptive page heading. The shared header keeps the application identity
and labelled main navigation separate from that heading. In Library, **Add books** is a native
button that opens the file picker. Its backing multiple-file input retains the **Import books**
label and stays outside the keyboard tab sequence, avoiding two consecutive stops for the same
action. Keyboard users activate the visible button; the browser or operating system owns the
picker's interaction and cancellation.

Settings uses a page heading, ordered section headings and a labelled **Settings sections**
navigation. The section links wrap above the content on smaller screens. They are ordinary anchor
links and scroll to the requested section; they do not act as tabs or hide the other sections.
Collection rename still moves focus to its labelled input and returns focus to the original
rename button after saving or cancelling.

Technical information is grouped in native `details`/`summary` disclosures:

- **Advanced diagnostics** contains diagnostic export, queue details, file-store information,
  orphan cleanup and schema history.
- **Backup options & limits** contains the portable archive limits and metadata-only JSON export.
- **Manage local storage** contains the storage target and safe cleanup action.

These controls expose expanded/collapsed state and use the browser's standard keyboard behavior.
Everyday appearance, privacy, collection, backup and sync controls remain visible. Theme uses a
labelled custom combobox; the privacy toggle retains native checkbox semantics. Decorative icons are hidden
from assistive technology, text labels name actions, and focus outlines remain visible. Toggle and
disclosure motion respects reduced-motion preferences; the privacy input uses native rendering in
forced-colour mode.

## Custom choice controls

Library filters/sort, book status, application and reader themes, and speech voices share a
select-only combobox. Focus stays on its labelled button while `aria-activedescendant` identifies
the keyboard preview in a portaled listbox. Arrow keys and Home/End move the preview, typed text
finds a matching label, and repeated initial letters cycle matching choices. Enter/Space saves
the choice. Escape and Tab cancel the preview; Tab continues the normal focus order. Clicking
elsewhere cancels without moving focus back to the old control.

Closing immediately makes the exiting menu inert and hidden to assistive technology. Reduced
motion removes the visual exit entirely. The menu fits the viewport, flips above its anchor when
needed, wraps long labels and scrolls the active option into its own scroll area. Dynamic voice
updates retain valid option identities. In the reader, dropdown keys cannot turn pages; Escape
closes the dropdown before the appearance sheet.

`tests/browser/custom-select.spec.ts` exercises these behaviors in Chromium, Firefox and WebKit,
including 320×420 and 390×844 viewports, late speech-voice updates and reduced motion. The axe
suite includes the open library menu and waits for finite UI animations to settle before
measuring contrast. It keeps normal motion enabled while navigating and opening disclosures.
These automated checks do not replace screen-reader or physical touch-device testing.

## Evidence and limitations

The Chromium suite passed on November 7, 2026 with the generated populated views at the two specified widths, with no serious/critical axe findings in the audited application UI and no document horizontal overflow. The keyboard/focus and dark/Amber cases also passed. `tests/ui/theme.test.ts` verifies numerical foreground contrast for preset and custom colors on light and dark surfaces.

During the subsequent visual refinement, focused Chromium checks of Settings at 1440 px and
390 px found no serious/critical axe findings or horizontal document overflow in light and dark
themes, including the expanded disclosures. The backup section link scrolled to its target, and
keyboard Enter opened **Backup options & limits** and exposed the JSON export action. Desktop and
mobile screenshots were inspected. These targeted checks are separate from the full regression
suite above; they do not establish that every redesigned view or native operating-system file
picker has been tested with assistive technology.

Axe's reader scans can trigger Chromium ResizeObserver-loop diagnostics from the vendored EPUB paginator as the scanner measures layout. These diagnostics are not suppressed globally and are not treated as proof of an accessibility violation. Reader rendering and navigation require their separate functional/browser corpus checks.

Automated testing does not establish reading order, speech quality, focus behavior or usability with every screen reader, switch device, magnifier, operating system or publication. This suite currently runs Chromium only. It does not audit arbitrary EPUB/PDF document semantics, every high-contrast setting, all zoom levels, configured authentication screens, or all empty/error dialogs. A release accessibility review should include manual keyboard and screen-reader testing on supported desktop/mobile platforms and representative real publications.

When changing controls, preserve semantic labels, visible focus, panel relationships and predictable keyboard order. Add the changed state to the regression suite instead of broadly excluding a failing application subtree. Use generated, nonprivate fixtures in traces and screenshots.

## Advanced reader controls

The page-mode group uses native buttons with explicit names and `aria-pressed` state. Unsupported
continuous mode is disabled for fixed-layout EPUBs with an adjacent explanation. Format-specific
sliders and custom comboboxes remain labelled; the direct page/section jump is a bounded number
input in a form. Focus mode moves focus to its visible exit and returns it to the opener when
closed. Full-screen dropdowns mount inside the full-screen subtree.

The populated-view audit now opens the EPUB typography disclosure and scans focus mode at both
widths, including focus return and overflow. Mode browser tests cover keyboard page turns,
shortcuts originating inside EPUB documents, narrow PDF facing fallback, full screen and persistent
positions. These checks retain the publication-content exclusion described above.
