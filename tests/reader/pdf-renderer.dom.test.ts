// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PdfRenderer, PDF_MAX_CANVAS_PIXELS } from '~/reader/pdf-renderer';
import { buildPdfFixture } from '../support/fixtures';

const engine = vi.hoisted(() => {
  const cleanupPage = vi.fn();
  const render = vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() }));
  const getPage = vi.fn(async (_page: number) => ({
    getViewport: ({ scale }: { scale: number }) => ({
      width: 10000 * scale,
      height: 20000 * scale,
    }),
    render,
    cleanup: cleanupPage,
  }));
  const destroy = vi.fn(async () => {});
  const cleanupDocument = vi.fn(async () => {});
  return { getPage, render, cleanupPage, cleanupDocument, destroy };
});

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {},
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: 100,
      getPage: engine.getPage,
      cleanup: engine.cleanupDocument,
      _transport: { messageHandler: { sendWithStream: () => new ReadableStream() } },
    }),
    destroy: engine.destroy,
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('Blob', NodeBlob);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it('only requests the visible page, caps raster pixels and releases the previous canvas/page on navigation', async () => {
  const renderer = new PdfRenderer();
  const host = document.createElement('div');
  document.body.append(host);
  renderer.mount(host);
  await renderer.open(new Blob([buildPdfFixture({ pageCount: 100 })]));
  expect(engine.getPage).toHaveBeenCalledExactlyOnceWith(1);
  const first = host.querySelector('canvas')!;
  expect(first.width * first.height).toBeLessThanOrEqual(PDF_MAX_CANVAS_PIXELS);
  renderer.next();
  await vi.waitFor(() => expect(engine.getPage).toHaveBeenLastCalledWith(2));
  await vi.waitFor(() =>
    expect(host.querySelector('canvas')?.getAttribute('aria-label')).toBe('Page 2 of 100'),
  );
  expect(first.width).toBe(0);
  expect(first.height).toBe(0);
  expect(engine.cleanupPage).toHaveBeenCalledOnce();
  expect(host.querySelectorAll('canvas')).toHaveLength(1);
  renderer.destroy();
  await vi.waitFor(() => expect(engine.destroy).toHaveBeenCalledOnce());
  expect(host.children.length).toBe(0);
});

it('skips queued hidden pages on rapid navigation and captures/restores PDF-point vertical offsets', async () => {
  const renderer = new PdfRenderer();
  const host = document.createElement('div');
  renderer.mount(host);
  const callback = vi.fn();
  renderer.onRelocate(callback);
  await renderer.open(new Blob([buildPdfFixture()]), {
    kind: 'pdf',
    value: '4:200',
    fraction: 0.04,
  });
  expect(engine.getPage).toHaveBeenLastCalledWith(5);
  expect(callback).toHaveBeenLastCalledWith(
    expect.objectContaining({ value: '4:200', fraction: 0.0401 }),
    0.0401,
  );
  renderer.next();
  renderer.next();
  renderer.next();
  // A queued turn has selected page 8, but a scroll on the old visible canvas
  // must still describe page 5 rather than inventing progress for the target.
  host.querySelector('.pdf-scroll')!.dispatchEvent(new Event('scroll'));
  expect(callback.mock.calls.at(-1)![0].value).toMatch(/^4:/);
  await vi.waitFor(() => expect(engine.getPage).toHaveBeenLastCalledWith(8));
  expect(engine.getPage.mock.calls.map(([page]) => page)).toEqual([5, 8]);
  renderer.destroy();
  await vi.waitFor(() => expect(engine.destroy).toHaveBeenCalledOnce());
});

it('reports a rejected render, retains the last successful relocation and can recover', async () => {
  const renderer = new PdfRenderer();
  const host = document.createElement('div');
  renderer.mount(host);
  const relocated = vi.fn();
  renderer.onRelocate(relocated);
  const message = vi.fn();
  host.addEventListener('reader-message', message);
  await renderer.open(new Blob([buildPdfFixture()]));
  engine.render.mockImplementationOnce(() => ({
    promise: Promise.reject(new Error('Image exceeded maximum allowed size')),
    cancel: vi.fn(),
  }));
  renderer.next();
  await vi.waitFor(() => expect(message).toHaveBeenCalled());
  expect((message.mock.calls[0]![0] as CustomEvent<string>).detail).toContain(
    'Image exceeded maximum allowed size',
  );
  expect(host.querySelectorAll('canvas')).toHaveLength(0);
  expect(relocated).toHaveBeenCalledOnce();
  expect(relocated.mock.calls[0]![0].value).toBe('0:0');
  renderer.prev();
  await vi.waitFor(() => expect(relocated).toHaveBeenCalledTimes(2));
  expect(host.querySelector('canvas')?.dataset.renderState).toBe('ready');
  renderer.destroy();
  await vi.waitFor(() => expect(engine.destroy).toHaveBeenCalledOnce());
});
