# Details and reading statistics refinement

Reviewed on 2026-11-07 with Chromium using an isolated browser context and generated EPUB content. These images use synthetic library/session data; they are not the user's reading history.

## Implemented

- Cover-led book details with serif title, author, primary Read action, quiet Edit action, reading status and progress.
- Book details and Manage book disclosures retain metadata, original identity and archive/delete controls without placing them in the main reading flow.
- Notes, collections and device-file controls retain their existing behavior, labels and form IDs. Editing focuses the title; saving or cancelling returns focus to Edit details.
- Reading statistics use an emphasized total, six secondary metrics, proportional per-book time bars and recent-day history. Measurement explanations remain under About these numbers.
- Route-specific h1 titles and sequential section headings; light/dark styles and narrow-screen layouts.

## Executed checks

- Existing metadata, book-notes and library browser regressions: 6 passed in Chromium.
- Interaction smoke: edit/save metadata, add shelf/tag, change status, archive/restore and populated statistics; no page errors.
- Focus checked on metadata edit and save.
- No horizontal overflow at 390 pixels, including a long title.
- Axe: no violations on populated details/stats at desktop light and mobile dark sizes.
- TypeScript, targeted ESLint and Prettier checks passed.

## Images

- `book-details-wide.png`, `book-details-mobile.png`: normal title, primary flow and collections.
- `book-details-long-mobile.png`, `book-details-dark-mobile.png`: long title, all retained controls and dark palette.
- `book-stats-wide.png`, `book-stats-mobile.png`, `book-stats-dark-mobile.png`: populated metrics and history.

Images were visually inspected, including complete mobile pages, long title wrapping, cover typography and dark text contrast. Desktop images use a 1280 × 1000 viewport; mobile images use 390 × 844. Screenshots capture full pages. This check supplements the coordinated application browser/accessibility gates; it is not physical-device or screen-reader certification.
