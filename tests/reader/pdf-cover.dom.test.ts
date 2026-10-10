// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { renderPdfCover, PDF_COVER_MAX_EDGE } from '~/reader/pdf-cover';

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
  return { getPage, viewports };
});

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {},
  getDocument: () => ({
    promise: Promise.resolve({ numPages: 3, getPage: engine.getPage, cleanup: vi.fn() }),
    destroy: vi.fn(async () => {}),
  }),
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

  const rendered = engine.viewports.at(-1)!;
  expect(Math.max(rendered.width, rendered.height)).toBeLessThanOrEqual(PDF_COVER_MAX_EDGE + 1);
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
