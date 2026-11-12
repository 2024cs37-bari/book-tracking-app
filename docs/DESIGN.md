# Interface design

The November 2026 redesign gives the library the character of a quiet reading room:
warm paper surfaces, restrained olive accents, generous book covers and editorial typography.
Controls have a clear hierarchy. The interface should help someone find a book and keep reading
without competing with the book itself.

## Research and decisions

Reviewed on 7 November 2026:

| Reference                                                                                                | Useful observation                                                                                                                        | Application here                                                                                                 |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| [Readwise Reader](https://readwise.io/read)                                                              | Its published product views separate reading, navigation and contextual notes, with keyboard operation as a central workflow.             | A focused reader, a dismissible sidebar and page arrows that stay reachable on a phone.                          |
| [How we redesigned the Linear UI](https://linear.app/now/how-we-redesigned-the-linear-ui)                | The designers describe reducing visual noise, aligning controls, and testing hierarchy across light/dark themes and different view types. | A consistent surface/text/accent system, quiet navigation, aligned controls, and checks across every main route. |
| [Nielsen Norman Group: Progressive Disclosure](https://www.nngroup.com/articles/progressive-disclosure/) | Show common options first and disclose specialized options when requested.                                                                | Library filters, edition metadata, reader layout options and advanced maintenance are explicitly expandable.     |

These are design references, not copied product screens, assets or endorsements. No remote
fonts, UI frameworks, analytics or image dependencies were added. The typographic cover fallbacks
are generated from the book's own metadata and remain local.

## Visual language

- **Surfaces:** warm off-white (`#faf9f6`), slightly darker recessed areas (`#f2f0ea`) and an
  elevated surface (`#fffefa`). Dark mode uses corresponding warm charcoal surfaces.
- **Type:** system sans-serif for controls and metadata; the installed Georgia/Palatino family
  for page titles and cover fallbacks. Reading typography is still controlled by reader settings
  and the publication itself.
- **Colour:** olive is the default accent. Custom accents retain contrast-adjusted text and focus
  colours through `src/ui/theme.ts`.
- **Borders:** divide meaningful sections and identify editable fields. Do not outline every
  action or wrap every paragraph in a card.
- **Motion:** short fades, smooth disclosure changes and a small cover lift. Motion is confined
  to the application shell and respects the system's reduced-motion setting; see the rules below.

## Motion and interaction

Shared motion lives in `src/styles/motion.css`: 160 ms for quick feedback and 240 ms for view
entry, filters and panels. Route entry fades in without moving link targets. Buttons keep their
hit areas fixed; only decorative icons respond to a press. Status and reader tabs reveal a short
underline, and disclosure chevrons follow their expanded state.

Library filters animate both opening and closing using a grid wrapper. Closing sets `inert` and
`aria-hidden` immediately, then hides the wrapper after its visual collapse. Escape returns focus
to **Filters**. Rapid toggles reverse the same transition; there are no timers to leave a panel
stuck. The clipping wrapper uses `overflow: clip` and leaves room for focus outlines. Do not replace
it with `overflow: hidden`: that creates a scroll container which can scroll when a field receives
focus during expansion, immediately dismissing the field's dropdown.

All choice controls use the shared `src/ui/Select.tsx` and `src/styles/select.css`: library filters
and sorting, book status, application/reader themes and speech voices. The button exposes a
labelled combobox and owns a portaled listbox, which can open above or below the control and fit
the available viewport. Long labels wrap in the menu; long lists scroll independently of the book.
Selected options have a checkmark; the keyboard preview has a separate background treatment.

Arrow keys, Home/End and typed letters preview choices. Enter/Space commits; Escape, Tab and
outside interaction cancel a preview. Focus stays on the control. A reader dropdown consumes the
first Escape, its appearance sheet consumes the next, and neither arrow navigation nor menu
scrolling should turn a page. Outside-click handlers for enclosing disclosures must recognize
the portal through `containsSelectTarget`. Keep dynamic options keyed by value so a metadata or
voice-list refresh cannot replace an in-flight click target.

Menus fade/scale in over 200 ms and out over 140 ms. Dismissal makes them inert and removes them
from the accessibility tree immediately; a short timer only removes the visual exit. Reduced
motion removes both the animation and that visual delay. Forced-colour mode retains visible
control boundaries and keyboard preview outlines.

Native disclosures retain their native keyboard and collapsed behavior. They fade in on opening;
engines that support `interpolate-size` and `::details-content` also animate the content height
in both directions. Other engines close immediately. Reader appearance uses a small sheet-entry
motion and the sidebar fades its contents. Sidebar width changes take effect immediately:
never animate the reader surface, renderer container geometry, pagination or restored positions.

Animations have a fully visible base state and no delayed fill. Do not add `transition: all`,
move interactive card anchors, or introduce exit timers that delay keyboard dismissal. Reduced
motion removes animations, transitions and decorative cover movement; expanded and selected
states still appear immediately. New shell animations must have the same reduced-motion path.

## Screen hierarchy

### Library

The header contains the library title and one primary **Add books** button. Common reading-status
filters are visible as a row of text controls. Search is directly available; **Filters** reveals
format, lifecycle, shelf, tag and the complete reading-status selector. Selected advanced filters
are counted on the disclosure button, including Abandoned status. Escape closes the filter panel
and returns focus to its button. **Reset filters** and the no-results reset clear every filter.

Book covers lead the grid. Titles, authors and reading progress are secondary. Covers with no
image receive a stable, locally generated typographic treatment; this is a fallback, not invented
publisher artwork. Cards retain persistent book IDs and stable link hit targets through incoming
repository changes and asynchronous image loading. The empty library explains import and offers
a direct first-book action; it is not populated with demonstration books.

### Book details

Cover, title, author, **Read**, **Edit details** and progress form the primary area. Notes,
collections and local-file actions follow. **Book details** reveals edition metadata and format
support caveats; **Manage book** reveals archive/restore/delete actions. The back arrow has the
accessible name **Back to library**, distinct from the main navigation.

### Reader

The top bar holds back navigation, the sidebar toggle, book title and **Reader settings**.
Previous/next arrows and position live in a quiet bottom bar. Page navigation stays accessible
when the mobile sidebar is open. Sidebar tabs use a small underline rather than filled boxes.
Appearance uses a compact sheet; less common layout options are disclosed inside it. Escape and
outside interaction dismiss the sheet; keyboard dismissal returns focus to its trigger.

The Notes, Search and Listen panels follow the same spacing and action hierarchy. Reader errors,
unsaved progress and cross-device conflicts retain visible, actionable messages.

### Settings and statistics

Settings has section links and open everyday controls. Backup and sync remain easy to find;
**Backup options & limits**, **Manage local storage** and **Advanced diagnostics** contain the
more detailed operations. The long technical dashboard no longer appears on first entry.

Statistics emphasize recorded reading time, with smaller supporting metrics, proportional
per-book time bars and a readable daily history. **About these numbers** explains time and
position semantics without crowding the overview.

## Rules for future changes

1. Decide what the person is trying to do on this screen before adding a control. Promote only
   the main action; use quiet text actions for secondary tasks.
2. Use an arrow or icon alone only when its meaning is clear, such as previous/next or close.
   Keep descriptive text for ambiguous operations. Every icon control needs an accessible name,
   a visible focus ring and a practical hit area. Do not reduce the hit area to the glyph size.
3. Prefer native buttons, links, inputs and disclosures. Expanded state, keyboard behavior and
   focus return are part of the feature, not optional decoration.
4. Keep error, recovery and data-loss information available at the point where it matters.
   Progressive disclosure must not conceal a failure or remove a recovery path.
5. Keep decorative card children out of pointer targeting so an image replacement cannot steal
   an in-flight click. Do not key an interactive card by a freshly fetched object.
6. Test long titles and 200-character collection names, empty and populated states, light/dark
   modes, custom accents, reduced motion and narrow screens. A desktop screenshot alone is
   insufficient.
7. Keep book content independent of shell typography and animation. UI refinement must not
   reset reading positions or recreate the renderer unnecessarily.
8. Use existing tokens before inventing a new colour or spacing rule. Shared tokens and base
   controls live in `src/styles/global.css`; shared motion lives in `motion.css`; view rules live in `library.css`,
   `details-refinement.css`, `reader-refinement.css`, `settings-refinement.css` and
   `stats-refinement.css`. Decorative line glyphs live in `src/ui/Icon.tsx`.

## Screenshots and validation

The screenshots use generated test EPUBs with fictional sample metadata, in an isolated local
preview. They demonstrate the actual application, not a static mockup. These books are not bundled
into a user's library.

- [Library, desktop width](validation/ui-2026-11-07/library-desktop.jpg)
- [Library, light theme](validation/ui-2026-11-07/library-light.jpg)
- [Library, phone width](validation/ui-2026-11-07/library-mobile.jpg)
- [Reader, desktop](validation/ui-2026-11-07/reader-desktop.png)
- [Reader, phone width](validation/ui-2026-11-07/reader-mobile.png)
- [Native Settings](validation/ui-2026-11-07/native-settings.png)
- [Custom menus, light desktop](validation/ui-2026-11-07/custom-select-desktop.png)
- [Custom menus, dark desktop](validation/ui-2026-11-07/custom-select-dark.png)
- [Custom menus, phone width](validation/ui-2026-11-07/custom-select-mobile.png)
- [Custom reader menu, native Linux](validation/ui-2026-11-07/custom-select-native.png)

The [accessibility guide](ACCESSIBILITY.md) documents keyboard and automated contrast/overflow
checks. The [user guide](USER-GUIDE.md) explains where controls moved. The prior
[reader corpus report](validation/2026-11-07-reader.json) is a **pre-redesign baseline**; it does not
certify the redesigned layout. The [post-redesign validation report](validation/2026-11-07-ui.json) records 165 passing browser
cases and 27 unique corpus cases with the PDF test correction disclosed.
See the [development record](DEVELOPMENT.md) for client, accessibility and native checks.

The subsequent [custom-control and motion report](validation/2026-11-07-motion.json) records
189 passing application browser cases, including 24 focused dropdown cases, 4 accessibility
cases and a focused check of the rebuilt Linux package. Its screenshots and source hashes describe
this follow-up; the external reader corpus was not rerun for these control changes.

## Advanced reading space

The reader settings sheet leads with three illustrated, mutually exclusive page modes. PDF controls
use fit, zoom and rotation; EPUB controls use typeface and text size. Less frequent spacing, cover
pairing and page-order settings sit in a secondary disclosure. Fixed-layout publications explain
which options their geometry prevents. Theme choices use reader-oriented labels Paper, Sepia and
Night while preserving the underlying saved values.

A direct page/section jump complements the navigation controls. Focus mode removes shell chrome
and retains a small, labelled exit control with explicit focus return. Full screen keeps custom
menus in the active full-screen subtree. Facing pages adapt to the available reading area;
continuous PDF pages load near the reading position. Reader geometry changes do not animate.
The settings sheet and custom controls retain the existing reduced-motion behavior.

The implementation is in `ReaderSettingsMenu.tsx`, `reader-advanced.css` and the renderer adapters.
The mode workflows, offline restoration and actual page-selection checks live in
`tests/browser/reader-modes.spec.ts`; the user guide describes format-specific limits.

Final advanced-reader evidence: [PDF settings](validation/reader-modes-2026-11-07/pdf-facing-settings.png),
[phone settings](validation/reader-modes-2026-11-07/pdf-settings-mobile.png),
[EPUB typography](validation/reader-modes-2026-11-07/epub-typography.png) and
[native Linux](validation/reader-modes-2026-11-07/native-pdf.png).
The [validation report](validation/2026-11-07-reader-modes.json) records the 210 browser cases,
27 corpus cases, expanded accessibility audit and rebuilt-package checks for this implementation.
