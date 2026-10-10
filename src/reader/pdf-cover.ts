import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { ExtractedCover } from '~/services/metadata/types';

/** Longest edge of a generated cover thumbnail, in CSS pixels. */
export const PDF_COVER_MAX_EDGE = 600;
/** Hard ceiling on the raster, mirroring the reader's canvas-area guard. */
export const PDF_COVER_MAX_PIXELS = 2_000_000;

/**
 * Renders the first page of a PDF to a JPEG thumbnail for use as a cover.
 *
 * Returns `null` whenever a cover cannot be produced — no DOM, no 2D canvas,
 * an unreadable PDF, or a browser without `toBlob`. A cover is cosmetic, so
 * every failure is a quiet `null` rather than a thrown error, and callers
 * import this module lazily so the pdf.js graph never loads during a
 * headless import.
 */
export async function renderPdfCover(file: Blob): Promise<ExtractedCover | null> {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  if (typeof canvas.getContext !== 'function' || canvas.getContext('2d') === null) return null;

  const { getDocument, GlobalWorkerOptions } = await import('pdfjs-dist');
  GlobalWorkerOptions.workerSrc = workerUrl;
  const base = `${import.meta.env.BASE_URL}pdf-assets/`;
  const loading = getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    isEvalSupported: false,
    // A cover is best-effort: tolerate the broken content a strict reader
    // would stop on, so a slightly damaged PDF still gets a thumbnail.
    stopAtErrors: false,
    cMapUrl: `${base}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${base}standard_fonts/`,
    wasmUrl: `${base}wasm/`,
    maxImageSize: PDF_COVER_MAX_PIXELS,
  });

  try {
    const pdf = await loading.promise;
    try {
      const page = await pdf.getPage(1);
      try {
        const natural = page.getViewport({ scale: 1 });
        const scale = Math.min(
          1,
          PDF_COVER_MAX_EDGE / Math.max(natural.width, natural.height),
          Math.sqrt(PDF_COVER_MAX_PIXELS / (natural.width * natural.height)),
        );
        const viewport = page.getViewport({ scale });
        canvas.width = Math.max(1, Math.floor(viewport.width));
        canvas.height = Math.max(1, Math.floor(viewport.height));
        await page.render({ canvas, viewport }).promise;
        const blob = await canvasToJpeg(canvas);
        if (blob === null) return null;
        const bytes = new Uint8Array(await blob.arrayBuffer()) as Uint8Array<ArrayBuffer>;
        return { bytes, contentType: 'image/jpeg', extension: 'jpg' };
      } finally {
        // Teardown must never clobber a produced cover or throw out of here.
        try {
          page.cleanup();
        } catch {
          /* already torn down */
        }
      }
    } finally {
      try {
        await pdf.cleanup();
      } catch {
        /* already torn down */
      }
    }
  } catch {
    return null;
  } finally {
    try {
      await loading.destroy();
    } catch {
      /* already torn down */
    }
  }
}

function canvasToJpeg(canvas: HTMLCanvasElement): Promise<Blob | null> {
  if (typeof canvas.toBlob !== 'function') return Promise.resolve(null);
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.82));
}
