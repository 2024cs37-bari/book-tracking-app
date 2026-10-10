// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PdfRenderer } from '~/reader/pdf-renderer';
import { parsePdfLocator } from '~/domain/locator';
import type { SearchHit } from '~/reader/renderer';
import { buildPdfFixture } from '../support/fixtures';

// Each page is a list of text runs, as pdf.js getTextContent returns them.
const PAGE_ITEMS = [
  ['the quick brown', 'fox'],
  ['lazy dog jumps', 'over the fence'],
  ['nothing to see'],
];

const engine = vi.hoisted(() => {
  const getPage = vi.fn(async (page: number) => ({
    getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
    render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }),
    getTextContent: async () => ({
      items: (PAGE_ITEMS[page - 1] ?? []).map((str) => ({ str })),
    }),
    cleanup: vi.fn(),
  }));
  return { getPage };
});

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {},
  TextLayer: class {
    render() {
      return Promise.resolve();
    }
  },
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: PAGE_ITEMS.length,
      getPage: engine.getPage,
      cleanup: vi.fn(async () => {}),
      _transport: { messageHandler: { sendWithStream: () => new ReadableStream() } },
    }),
    destroy: vi.fn(async () => {}),
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

async function collect(iterable: AsyncIterable<SearchHit>): Promise<SearchHit[]> {
  const hits: SearchHit[] = [];
  for await (const hit of iterable) hits.push(hit);
  return hits;
}

async function openRenderer(): Promise<PdfRenderer> {
  const renderer = new PdfRenderer();
  const host = document.createElement('div');
  document.body.append(host);
  renderer.mount(host);
  await renderer.open(new Blob([buildPdfFixture({ pageCount: PAGE_ITEMS.length })]));
  return renderer;
}

it('yields a hit per match with a page locator and excerpt', async () => {
  const renderer = await openRenderer();
  const hits = await collect(renderer.search('the'));

  // "the" appears on page 1 and page 2 (0-indexed 0 and 1), not page 3.
  expect(hits).toHaveLength(2);
  expect(parsePdfLocator(hits[0]!.locator.value)?.page).toBe(0);
  expect(parsePdfLocator(hits[1]!.locator.value)?.page).toBe(1);
  expect(hits[0]!.excerpt.toLowerCase()).toContain('the');
  renderer.destroy();
});

it('matches a phrase that spans two text runs on a page', async () => {
  const renderer = await openRenderer();
  // "brown fox" is split across the two runs of page 1; "jumps over" across page 2.
  expect(await collect(renderer.search('brown fox'))).toHaveLength(1);
  expect(await collect(renderer.search('jumps over'))).toHaveLength(1);
  renderer.destroy();
});

it('is case-insensitive and finds every occurrence', async () => {
  const renderer = await openRenderer();
  const hits = await collect(renderer.search('THE'));
  expect(hits.length).toBe(2);
  renderer.destroy();
});

it('yields nothing for a blank query', async () => {
  const renderer = await openRenderer();
  expect(await collect(renderer.search('   '))).toHaveLength(0);
  renderer.destroy();
});

it('lists every page with a page locator for the sidebar Pages view', async () => {
  const renderer = await openRenderer();
  expect(renderer.supportsThumbnails).toBe(true);
  const pages = await renderer.listPages();
  expect(pages).toHaveLength(PAGE_ITEMS.length);
  expect(pages[0]!.label).toBe('1');
  expect(pages[0]!.locator.value).toBe('0:0');
  expect(pages.at(-1)!.locator.value).toBe(`${PAGE_ITEMS.length - 1}:0`);
  renderer.destroy();
});

it('stops early when the search is aborted', async () => {
  const renderer = await openRenderer();
  const controller = new AbortController();
  controller.abort();
  expect(await collect(renderer.search('the', controller.signal))).toHaveLength(0);
  renderer.destroy();
});
