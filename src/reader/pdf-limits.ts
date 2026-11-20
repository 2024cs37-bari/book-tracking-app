/** Source-image ceiling, applied by pdf.js before its canvas downsampling. */
export const PDF_MAX_SOURCE_IMAGE_PIXELS = 40_000_000;

/** Explain the source-image guard without discarding the original decode error. */
export function friendlyPdfError(error: unknown): unknown {
  const message =
    error && typeof error === 'object' && 'message' in error
      ? String(error.message)
      : String(error);
  if (!/Image exceeded maximum allowed size/i.test(message)) return error;
  return new Error(
    'This PDF contains a source image larger than the 40 million pixel safety limit. ' +
      'Reduce the scan resolution and try again.',
    { cause: error },
  );
}
