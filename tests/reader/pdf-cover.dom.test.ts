// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { renderPdfCover, PDF_COVER_MAX_EDGE, PDF_COVER_MAX_PIXELS } from '~/reader/pdf-cover';
import { PDF_MAX_SOURCE_IMAGE_PIXELS } from '~/reader/pdf-limits';

const engine = vi.hoisted(() => {
  const viewports: Array<{ width: number; height: number }> = [];
  const getPage = vi.fn(async () => ({
    getViewport: ({ scale }: { scale: number }) => {
      const viewport = { width: 1200 * scale, height: 1800 * scale };
      if (scale !== 1) viewports.push(viewport);
      return viewport;
    },
    render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }),
    cleanup: vi.fn(),
  }));
  const getDocument = vi.fn((_options: unknown) => ({
    promise: Promise.resolve({ numPages: 3, getPage, cleanup: vi.fn() }),
    destroy: vi.fn(async () => {}),
  }));
  return { getDocument, getPage, viewports };
});

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {},
  getDocument: engine.getDocument,
}));

beforeEach(() => {
  vi.clearAllMocks();
  engine.viewports.length = 0;
  vi.stubGlobal('Blob', NodeBlob);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubCanvas(withToBlob: boolean): void {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    {} as unknown as CanvasRenderingContext2D,
  );
  (HTMLCanvasElement.prototype as unknown as { toBlob?: unknown }).toBlob = withToBlob
    ? function (this: HTMLCanvasElement, callback: (blob: Blob | null) => void) {
        callback(new NodeBlob([new Uint8Array([1, 2, 3, 4])]) as unknown as Blob);
      }
    : undefined;
}

it('renders the first page to a bounded JPEG cover', async () => {
  stubCanvas(true);
  const cover = await renderPdfCover(new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])]));

  expect(cover).not.toBeNull();
  expect(cover!.contentType).toBe('image/jpeg');
  expect(cover!.extension).toBe('jpg');
  expect(cover!.bytes.byteLength).toBeGreaterThan(0);
  expect(engine.getPage).toHaveBeenCalledWith(1);
  const options = engine.getDocument.mock.calls[0]![0];
  expect(options).toMatchObject({
    maxImageSize: PDF_MAX_SOURCE_IMAGE_PIXELS,
    canvasMaxAreaInBytes: PDF_COVER_MAX_PIXELS * 4,
    stopAtErrors: false,
    isImageDecoderSupported: false,
  });
  expect(options).not.toHaveProperty('isOffscreenCanvasSupported');

  const rendered = engine.viewports.at(-1)!;
  expect(rendered.width * rendered.height).toBeLessThanOrEqual(PDF_COVER_MAX_PIXELS);
  expect(Math.max(rendered.width, rendered.height)).toBeLessThanOrEqual(PDF_COVER_MAX_EDGE + 1);
});

it('contains oversized source-image failures as a best-effort cover', async () => {
  stubCanvas(true);
  engine.getPage.mockRejectedValueOnce(new Error('Image exceeded maximum allowed size'));
  expect(await renderPdfCover(new Blob(['%PDF']))).toBeNull();
  const loading = engine.getDocument.mock.results[0]!.value;
  expect(loading.destroy).toHaveBeenCalledOnce();
});

it('returns null when the canvas cannot produce a blob', async () => {
  stubCanvas(false);
  const cover = await renderPdfCover(new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])]));
  expect(cover).toBeNull();
});

it('returns null when no 2D context is available', async () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  const cover = await renderPdfCover(new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])]));
  expect(cover).toBeNull();
  expect(engine.getPage).not.toHaveBeenCalled();
});
