// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PdfRenderer, PDF_MAX_CANVAS_PIXELS } from '~/reader/pdf-renderer';
import { DEFAULT_READER_SETTINGS } from '~/reader/settings';
import { PDF_CONTINUOUS_CACHE_LIMIT, PDF_TOTAL_CANVAS_PIXELS } from '~/reader/pdf-layout';
import type { AnnotationAnchorStatus } from '~/reader/renderer';
import { buildPdfFixture } from '../support/fixtures';

/** A pointer event jsdom can dispatch; carries pointerId plus client coords. */
function pointer(type: string, id: number, x: number, y: number): Event {
  const event = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true });
  Object.defineProperty(event, 'pointerId', { value: id });
  return event;
}

const engine = vi.hoisted(() => {
  const cleanupPage = vi.fn();
  const render = vi.fn((_options: { canvas: HTMLCanvasElement }) => ({
    promise: Promise.resolve(),
    cancel: vi.fn(),
  }));
  const getPage = vi.fn(async (_page: number) => ({
    getViewport: ({ scale }: { scale: number }) => ({
      width: 10000 * scale,
      height: 20000 * scale,
    }),
    render,
    streamTextContent: () => new ReadableStream(),
    cleanup: cleanupPage,
  }));
  const destroy = vi.fn(async () => {});
  const cleanupDocument = vi.fn(async () => {});
  const messageHandler = {
    sendWithStream: (_action: string, _data: { pageIndex: number }): ReadableStream<unknown> =>
      new ReadableStream(),
  };
  return { getPage, render, cleanupPage, cleanupDocument, destroy, messageHandler };
});

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {},
  TextLayer: class {
    constructor(private readonly options: { container: HTMLElement }) {}
    render() {
      this.options.container.textContent = 'Known visible page text';
      return Promise.resolve();
    }
  },
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: 100,
      getPage: engine.getPage,
      cleanup: engine.cleanupDocument,
      _transport: { messageHandler: engine.messageHandler },
    }),
    destroy: engine.destroy,
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  engine.messageHandler.sendWithStream = () => new ReadableStream();
  vi.stubGlobal('Blob', NodeBlob);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
});

it('reports impossible PDF annotation anchors while leaving offscreen text ranges unchecked', async () => {
  const renderer = new PdfRenderer();
  const host = document.createElement('div');
  document.body.append(host);
  renderer.mount(host);
  await renderer.open(new Blob([buildPdfFixture()]));
  await vi.waitFor(() =>
    expect(host.querySelector('.textLayer')?.textContent).toContain('Known visible'),
  );
  let statuses: readonly AnnotationAnchorStatus[] = [];
  const stop = renderer.onAnnotationStatus((value) => {
    statuses = value;
  });
  renderer.setAnnotationAnchors([
    { id: 'valid-note', kind: 'note', locator: { kind: 'pdf', value: '0:0', fraction: 0 } },
    {
      id: 'valid-highlight',
      kind: 'highlight',
      locator: { kind: 'pdf', value: '0:0:0:5', fraction: 0 },
    },
    { id: 'missing-page', kind: 'bookmark', locator: { kind: 'pdf', value: '500:0', fraction: 1 } },
    {
      id: 'missing-text',
      kind: 'highlight',
      locator: { kind: 'pdf', value: '0:0:500:510', fraction: 0 },
    },
    {
      id: 'offscreen',
      kind: 'highlight',
      locator: { kind: 'pdf', value: '1:0:500:510', fraction: 0.01 },
    },
  ]);
  expect(Object.fromEntries(statuses.map((status) => [status.id, status.state]))).toEqual({
    'valid-note': 'resolved',
    'valid-highlight': 'resolved',
    'missing-page': 'unresolved',
    'missing-text': 'unresolved',
    offscreen: 'unchecked',
  });
  expect(engine.getPage).toHaveBeenCalledExactlyOnceWith(1);
  renderer.setAnnotationAnchors([
    {
      id: 'missing-text',
      kind: 'highlight',
      locator: { kind: 'pdf', value: '0:0:0:5', fraction: 0 },
    },
  ]);
  expect(statuses).toEqual([{ id: 'missing-text', state: 'resolved', reason: undefined }]);
  stop();
  renderer.destroy();
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
  // A rejected render now keeps the last good page on screen instead of
  // blanking the view (the previous page is only released once a new one is
  // painted and swapped in).
  expect(host.querySelectorAll('canvas')).toHaveLength(1);
  expect(host.querySelector('canvas')?.getAttribute('aria-label')).toBe('Page 1 of 100');
  expect(host.querySelector('canvas')?.dataset.renderState).toBe('ready');
  expect(relocated).toHaveBeenCalledOnce();
  expect(relocated.mock.calls[0]![0].value).toBe('0:0');
  renderer.prev();
  await vi.waitFor(() => expect(relocated).toHaveBeenCalledTimes(2));
  expect(host.querySelector('canvas')?.dataset.renderState).toBe('ready');
  renderer.destroy();
  await vi.waitFor(() => expect(engine.destroy).toHaveBeenCalledOnce());
});

it('pinch-out re-renders the page at a larger, still-bounded scale once the gesture ends', async () => {
  const renderer = new PdfRenderer();
  const host = document.createElement('div');
  document.body.append(host);
  renderer.mount(host);
  await renderer.open(new Blob([buildPdfFixture()]));
  const beforeWidth = host.querySelector('canvas')!.width;
  const beforeCssWidth = parseFloat(host.querySelector('canvas')!.style.width);
  // Two fingers 100px apart, then spread to 200px — a 2x pinch.
  host.dispatchEvent(pointer('pointerdown', 1, 0, 0));
  host.dispatchEvent(pointer('pointerdown', 2, 100, 0));
  host.dispatchEvent(pointer('pointermove', 2, 200, 0));
  // No re-raster happens mid-gesture: still the original canvas.
  expect(host.querySelector('canvas')!.width).toBe(beforeWidth);
  host.dispatchEvent(pointer('pointerup', 1, 0, 0));
  host.dispatchEvent(pointer('pointerup', 2, 200, 0));
  await vi.waitFor(() => expect(host.querySelector('canvas')!.width).toBeGreaterThan(beforeWidth));
  const after = host.querySelector('canvas')!;
  expect(parseFloat(after.style.width)).toBe(beforeCssWidth * 2);
  expect(after.width * after.height).toBeLessThanOrEqual(PDF_MAX_CANVAS_PIXELS);
  expect(host.querySelectorAll('canvas')).toHaveLength(1);
  renderer.destroy();
  await vi.waitFor(() => expect(engine.destroy).toHaveBeenCalledOnce());
});

it('disposes a cancelled pending canvas while retaining and eventually releasing the displayed canvas', async () => {
  const renderer = new PdfRenderer();
  const host = document.createElement('div');
  renderer.mount(host);
  await renderer.open(new Blob([buildPdfFixture()]));
  const first = host.querySelector('canvas')!;
  let pending: HTMLCanvasElement | undefined;
  engine.render.mockImplementationOnce(({ canvas }) => {
    pending = canvas;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((_resolve, fail) => {
      reject = fail;
    });
    return { promise, cancel: vi.fn(() => reject(new Error('cancelled'))) };
  });
  renderer.next();
  await vi.waitFor(() => expect(pending).toBeDefined());
  expect(host.querySelector('canvas')).toBe(first);
  expect(first.width).toBeGreaterThan(0);
  renderer.next();
  await vi.waitFor(() =>
    expect(host.querySelector('canvas')?.getAttribute('aria-label')).toBe('Page 3 of 100'),
  );
  expect(pending!.width).toBe(0);
  expect(pending!.height).toBe(0);
  expect(first.width).toBe(0);
  expect(first.height).toBe(0);
  expect(engine.cleanupDocument).not.toHaveBeenCalled();
  renderer.destroy();
  await vi.waitFor(() => expect(engine.destroy).toHaveBeenCalledOnce());
});

it('rejects oversized originals before reading their bytes', async () => {
  const renderer = new PdfRenderer();
  renderer.mount(document.createElement('div'));
  const file = new Blob(['x']);
  Object.defineProperty(file, 'size', { value: 256 * 1024 * 1024 + 1 });
  const read = vi.spyOn(file, 'arrayBuffer');
  await expect(renderer.open(file)).rejects.toThrow(/256 MiB/);
  expect(read).not.toHaveBeenCalled();
  renderer.destroy();
});

it('keeps thumbnail render failures contained and rejects invalid thumbnail sizes', async () => {
  const renderer = new PdfRenderer();
  renderer.mount(document.createElement('div'));
  await renderer.open(new Blob([buildPdfFixture()]));
  expect(await renderer.renderThumbnail(0, Infinity)).toBeNull();
  engine.getPage.mockRejectedValueOnce(new Error('destroyed page'));
  expect(await renderer.renderThumbnail(2, 180)).toBeNull();
  renderer.destroy();
  await vi.waitFor(() => expect(engine.destroy).toHaveBeenCalledOnce());
});

it('does not create an object URL if destroyed while thumbnail encoding finishes', async () => {
  const renderer = new PdfRenderer();
  renderer.mount(document.createElement('div'));
  await renderer.open(new Blob([buildPdfFixture()]));
  let finish: BlobCallback | undefined;
  const encode = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => {
    finish = callback;
  });
  const thumbnail = renderer.renderThumbnail(2, 180);
  await vi.waitFor(() => expect(finish).toBeDefined());
  renderer.destroy();
  finish!(new Blob(['thumbnail']));
  expect(await thumbnail).toBeNull();
  encode.mockRestore();
  await vi.waitFor(() => expect(engine.destroy).toHaveBeenCalledOnce());
});

it('retains a thumbnail operator-stream failure when the foreground later opens its cached partial page', async () => {
  const error = new Error('Image exceeded maximum allowed size');
  engine.messageHandler.sendWithStream = () =>
    new ReadableStream({
      start(controller) {
        controller.error(error);
      },
    });
  const renderer = new PdfRenderer();
  const host = document.createElement('div');
  renderer.mount(host);
  const relocated = vi.fn();
  renderer.onRelocate(relocated);
  const message = vi.fn();
  host.addEventListener('reader-message', message);
  await renderer.open(new Blob([buildPdfFixture()]));
  const firstCanvas = host.querySelector('canvas');
  const encode = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob');
  // Match the SDK failure mode: it resolves RenderTask with a partial operator
  // list after the stream fails. The thumbnail starts while page 1 is current.
  engine.render.mockImplementationOnce(() => ({
    promise: engine.messageHandler
      .sendWithStream('GetOperatorList', { pageIndex: 1 })
      .getReader()
      .read()
      .then(
        () => {},
        () => {},
      ),
    cancel: vi.fn(),
  }));
  expect(await renderer.renderThumbnail(1, 180)).toBeNull();
  expect(encode).not.toHaveBeenCalled();
  expect(message).not.toHaveBeenCalled();
  renderer.next();
  await vi.waitFor(() => expect(message).toHaveBeenCalledOnce());
  expect((message.mock.calls[0]![0] as CustomEvent<string>).detail).toContain(error.message);
  expect(host.querySelector('canvas')).toBe(firstCanvas);
  expect(relocated).toHaveBeenCalledOnce();
  renderer.next();
  await vi.waitFor(() =>
    expect(host.querySelector('canvas')?.getAttribute('aria-label')).toBe('Page 3 of 100'),
  );
  encode.mockRestore();
  renderer.destroy();
  await vi.waitFor(() => expect(engine.destroy).toHaveBeenCalledOnce());
});

it('preserves a restored PDF-point anchor across pixel rounding until the user scrolls', async () => {
  const renderer = new PdfRenderer();
  const host = document.createElement('div');
  renderer.mount(host);
  const scroller = host.querySelector<HTMLDivElement>('.pdf-scroll')!;
  let actualTop = 0;
  Object.defineProperty(scroller, 'scrollTop', {
    get: () => actualTop,
    set: (value: number) => {
      actualTop = Math.floor(value);
    },
  });
  const relocated = vi.fn();
  renderer.onRelocate(relocated);
  await renderer.open(new Blob([buildPdfFixture()]), { kind: 'pdf', value: '0:52', fraction: 0 });
  expect(relocated.mock.calls.at(-1)![0].value).toBe('0:52');
  scroller.dispatchEvent(new Event('scroll'));
  expect(relocated.mock.calls.at(-1)![0].value).toBe('0:52');
  scroller.scrollTop += 1;
  scroller.dispatchEvent(new Event('scroll'));
  const displayScale = parseFloat(host.querySelector('canvas')!.style.height) / 20000;
  expect(relocated.mock.calls.at(-1)![0].value).toBe(
    `0:${Math.round((actualTop - 24) / displayScale)}`,
  );
  renderer.destroy();
  await vi.waitFor(() => expect(engine.destroy).toHaveBeenCalledOnce());
});

it('pairs pages, advances by a spread and preserves the selected page across mode changes', async () => {
  const renderer = new PdfRenderer();
  const host = document.createElement('div');
  renderer.mount(host);
  renderer.applySettings({ ...DEFAULT_READER_SETTINGS, mode: 'double' });
  await renderer.open(new Blob([buildPdfFixture()]), {
    kind: 'pdf',
    value: '2:200',
    fraction: 0.02,
  });
  expect([...host.querySelectorAll('canvas')].map((c) => c.getAttribute('aria-label'))).toEqual([
    'Page 2 of 100',
    'Page 3 of 100',
  ]);
  const relocated = vi.fn();
  renderer.onRelocate(relocated);
  renderer.applySettings({ ...DEFAULT_READER_SETTINGS, mode: 'single' });
  await vi.waitFor(() => expect(host.querySelectorAll('canvas')).toHaveLength(1));
  expect(relocated.mock.calls.at(-1)![0].value).toBe('2:200');
  renderer.applySettings({ ...DEFAULT_READER_SETTINGS, mode: 'double' });
  await vi.waitFor(() => expect(host.querySelectorAll('canvas')).toHaveLength(2));
  renderer.next();
  await vi.waitFor(() =>
    expect(host.querySelector('canvas')?.getAttribute('aria-label')).toBe('Page 4 of 100'),
  );
  renderer.destroy();
  await vi.waitFor(() => expect(engine.destroy).toHaveBeenCalledOnce());
});

it('bounds continuous decoded surfaces and releases distant pages on a jump', async () => {
  const renderer = new PdfRenderer();
  const host = document.createElement('div');
  renderer.mount(host);
  renderer.applySettings({ ...DEFAULT_READER_SETTINGS, mode: 'continuous' });
  await renderer.open(new Blob([buildPdfFixture()]));
  const previous = [...host.querySelectorAll('canvas')];
  expect(host.querySelectorAll('.pdf-slot')).toHaveLength(100);
  expect(previous.length).toBeLessThanOrEqual(PDF_CONTINUOUS_CACHE_LIMIT);
  expect(previous.reduce((sum, c) => sum + c.width * c.height, 0)).toBeLessThanOrEqual(
    PDF_TOTAL_CANVAS_PIXELS,
  );
  renderer.goTo({ kind: 'pdf', value: '90:0', fraction: 0.9 });
  await vi.waitFor(() =>
    expect(host.querySelector('[aria-label="Page 91 of 100"]')).not.toBeNull(),
  );
  await vi.waitFor(() => expect(previous.every((c) => c.width === 0)).toBe(true));
  expect(host.querySelectorAll('canvas').length).toBeLessThanOrEqual(PDF_CONTINUOUS_CACHE_LIMIT);
  renderer.destroy();
  await vi.waitFor(() => expect(engine.destroy).toHaveBeenCalledOnce());
});

it('keeps the last good mode and anchor when a new spread fails to paint', async () => {
  const renderer = new PdfRenderer();
  const host = document.createElement('div');
  renderer.mount(host);
  await renderer.open(new Blob([buildPdfFixture()]), {
    kind: 'pdf',
    value: '2:200',
    fraction: 0.02,
  });
  const old = host.querySelector('canvas');
  const relocated = vi.fn();
  const message = vi.fn();
  renderer.onRelocate(relocated);
  host.addEventListener('reader-message', message);
  engine.render.mockImplementationOnce(() => ({
    promise: Promise.reject(new Error('bad spread')),
    cancel: vi.fn(),
  }));
  renderer.applySettings({ ...DEFAULT_READER_SETTINGS, mode: 'double', marginPx: 80 });
  await vi.waitFor(() => expect(message).toHaveBeenCalledOnce());
  expect(host.querySelector('canvas')).toBe(old);
  expect(host.querySelector('.pdf-scroll')?.getAttribute('data-mode')).toBe('single');
  host.querySelector('.pdf-scroll')!.dispatchEvent(new Event('scroll'));
  expect(relocated.mock.calls.at(-1)![0].value).toBe('2:200');
  renderer.destroy();
  await vi.waitFor(() => expect(engine.destroy).toHaveBeenCalledOnce());
});

it('a delayed resize preserves an in-flight page turn instead of restoring the old visible page', async () => {
  let resize!: () => void;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  let width = 800;
  const renderer = new PdfRenderer();
  const host = document.createElement('div');
  Object.defineProperty(host, 'clientWidth', { get: () => width });
  renderer.mount(host);
  await renderer.open(new Blob([buildPdfFixture()]));
  engine.render.mockImplementationOnce(() => {
    let resolve!: () => void;
    return {
      promise: new Promise<void>((done) => {
        resolve = done;
      }),
      cancel: vi.fn(() => resolve()),
    };
  });
  renderer.next();
  await vi.waitFor(() => expect(engine.render).toHaveBeenCalledTimes(2));
  width = 1000;
  resize();
  await vi.waitFor(() =>
    expect(host.querySelector('canvas')?.getAttribute('aria-label')).toBe('Page 2 of 100'),
  );
  expect(engine.getPage.mock.calls.map(([page]) => page)).toEqual([1, 2, 2]);
  renderer.destroy();
  await vi.waitFor(() => expect(engine.destroy).toHaveBeenCalledOnce());
});

it('supersedes pending inversion, retains the old page until painted and restores original pixels by re-rendering', async () => {
  const putImageData = vi.fn();
  const context = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    getImageData: () => ({ data: new Uint8ClampedArray([255, 255, 255, 255]) }),
    putImageData,
  } as unknown as CanvasRenderingContext2D);
  const renderer = new PdfRenderer();
  try {
    const host = document.createElement('div');
    renderer.mount(host);
    await renderer.open(new Blob([buildPdfFixture()]), {
      kind: 'pdf',
      value: '2:200',
      fraction: 0.02,
    });
    const original = host.querySelector('canvas')!;
    const relocated = vi.fn();
    renderer.onRelocate(relocated);
    const cancelled = vi.fn();
    engine.render.mockImplementationOnce(() => {
      let resolve!: () => void;
      return {
        promise: new Promise<void>((done) => {
          resolve = done;
        }),
        cancel: vi.fn(() => {
          cancelled();
          resolve();
        }),
      };
    });
    renderer.applySettings({ ...DEFAULT_READER_SETTINGS, pdfInvert: true });
    await vi.waitFor(() => expect(engine.render).toHaveBeenCalledTimes(2));
    expect(host.querySelector('canvas')).toBe(original);
    renderer.applySettings(DEFAULT_READER_SETTINGS);
    await vi.waitFor(() => expect(host.querySelector('canvas')).not.toBe(original));
    expect(cancelled).toHaveBeenCalledOnce();
    expect(putImageData).not.toHaveBeenCalled();
    expect(host.querySelector('canvas')?.dataset.colorMode).toBe('original');

    renderer.applySettings({ ...DEFAULT_READER_SETTINGS, pdfInvert: true });
    await vi.waitFor(() =>
      expect(host.querySelector('canvas')?.dataset.colorMode).toBe('inverted'),
    );
    expect(putImageData).toHaveBeenCalled();
    const inverted = host.querySelector('canvas')!;
    const renderCount = engine.render.mock.calls.length;
    renderer.applySettings(DEFAULT_READER_SETTINGS);
    await vi.waitFor(() =>
      expect(host.querySelector('canvas')?.dataset.colorMode).toBe('original'),
    );
    expect(engine.render).toHaveBeenCalledTimes(renderCount + 1);
    expect(inverted.width).toBe(0);
    expect(relocated.mock.calls.at(-1)![0].value).toBe('2:200');
  } finally {
    renderer.destroy();
    context.mockRestore();
  }
});
