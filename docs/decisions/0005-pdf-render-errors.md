# ADR 0005: PDF render failures and resource limits

- **Status:** Accepted
- **Date:** 2026-10-08

## Context

The real PDF corpus contains pages with 9000×9000 and 4000×2864 source images, exceeding
the existing 4,000,000-pixel decode cap. pdf.js normally skips them with a warning, which can
produce an apparently successful blank page. `stopAtErrors: true` rejects the operator stream,
but pdf.js 5.4.624's display layer completes a partial operator list before rejecting an already
settled capability. `RenderTask.promise` can still resolve despite the error.

## Decision

Retain the canvas and source-image pixel limits. Set `stopAtErrors` and intercept only the current
document's `GetOperatorList` streams in `src/reader/pdf-stream-errors.ts`, before the display layer
handles a rejection. Cancel the active render and propagate its original error to the reader shell.
Do not globally modify pdf.js or change originals to make them render.

This uses the private `_transport.messageHandler.sendWithStream` bridge of the exactly pinned
pdf.js version. Missing compatibility hooks fail explicitly. On SDK upgrades review this hook,
run the rejection/cancellation tests and real oversized-image corpus, and remove the shim only
if errors propagate correctly without it.

Persist progress only for successfully rendered canvases and use the rendered page index, not a
queued navigation target. Failed canvases are released; resize failures use the same visible error
path. Expected stream cancellation is not a new failure. Navigation to other usable pages remains
available and previously saved progress/original bytes stay intact.

## Consequences and evidence

- OCRmyPDF `multipage.pdf` page 2 and `3small.pdf` page 3 are explicitly decode-limited, not claimed
  readable. Tests verify the visible error, unchanged successful position and recovery/navigation.
- The long-text, rotated, mixed-size and invalid PDF cases provide selected-file evidence, not
  format-wide support. PDFs remain experimental; physical-device total-memory measurements and
  adaptive/tiled oversized-image decoding remain future work.
- Unit tests cover stream rejection, normal cancellation, unsupported bridge shapes and renderer
  recovery; corpus cases exercise actual engines. No metadata or binary schema changes are needed.
