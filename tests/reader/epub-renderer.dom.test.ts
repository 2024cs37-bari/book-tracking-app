// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { EpubRenderer, BOOK_CSP } from '~/reader/epub-renderer';
import { buildEpubFixture } from '../support/fixtures';

interface TestBook {
  sections: { load(): Promise<string>; createDocument(): Promise<Document>; cfi: string }[];
  resolveHref(value: string): { index: number; anchor: (doc: Document) => unknown } | undefined;
  resolveCFI(value: string): { index: number; anchor: (doc: Document) => Range };
  destroy(): void;
}

const urls = new Map<string, Blob>();
let cfi: { joinIndir(base: string, anchor: string): string; fromRange(range: Range): string };
// jsdom has no layout; only the view's pagination is replaced. Parsing, book
// transforms and object URL creation use the real pinned EPUB implementation.
class TestView extends HTMLElement {
  book!: TestBook;
  renderer = {
    setStyles: vi.fn(),
    setAttribute: vi.fn(),
    goTo: async ({ index }: { index: number }) => {
      const url = await this.book.sections[index]!.load();
      this.textContent = await urls.get(url)!.text();
      this.dispatchEvent(
        new CustomEvent('relocate', {
          detail: {
            cfi: this.book.sections[index]!.cfi,
            fraction: index / this.book.sections.length,
          },
        }),
      );
    },
  };
  async open(book: TestBook) {
    this.book = book;
  }
  close = vi.fn();
  resolveNavigation(value: string) {
    return value.startsWith('epubcfi(')
      ? this.book.resolveCFI(value)
      : this.book.resolveHref(value);
  }
  async goTo(index: number) {
    await this.renderer.goTo({ index });
  }
  async goToFraction(fraction: number) {
    await this.renderer.goTo({ index: Math.floor(fraction * this.book.sections.length) });
  }
  getCFI(index: number, range?: Range) {
    const base = this.book.sections[index]!.cfi;
    return range ? cfi.joinIndir(base, cfi.fromRange(range)) : base;
  }
  async prev() {
    await this.goTo(0);
  }
  async next() {
    await this.goTo(1);
  }
}

beforeAll(() => {
  customElements.define('foliate-view', TestView);
});
afterEach(() => {
  vi.unstubAllGlobals();
  urls.clear();
  document.body.replaceChildren();
});

async function adapter() {
  // jsdom lacks CSS.escape; these fixtures use simple identifiers/quoted attributes.
  vi.stubGlobal('CSS', {
    escape: (value: string) => value.replaceAll('\\', '\\\\').replaceAll('"', '\\"'),
  });
  cfi = (await import('../../vendor/foliate-js/epubcfi.js' as string)) as typeof cfi;
  vi.stubGlobal('Blob', NodeBlob);
  vi.stubGlobal(
    'URL',
    class extends URL {
      static override createObjectURL(blob: Blob) {
        const url = `blob:test-${urls.size}`;
        urls.set(url, blob);
        return url;
      }
      static override revokeObjectURL(url: string) {
        urls.delete(url);
      }
    },
  );
  const module = (await import('../../vendor/foliate-js/epub.js' as string)) as Record<
    string,
    unknown
  >;
  const renderer = new EpubRenderer(async (name) => (name === 'epub' ? module : {}));
  const host = document.createElement('div');
  document.body.append(host);
  renderer.mount(host);
  return { renderer, host };
}

it('opens generated EPUB through the custom element, applies CSP before URLs, translates CFI and releases resources', async () => {
  const { renderer, host } = await adapter();
  const positions: string[] = [];
  renderer.onRelocate((locator) => positions.push(locator.value));
  await renderer.open(new Blob([buildEpubFixture({ chapters: 2, hostileScript: true })]));
  expect(host.querySelector('foliate-view')).toBeInstanceOf(TestView);
  expect(host.textContent).toContain(BOOK_CSP);
  expect(host.textContent).toContain('Content.');
  expect(positions[0]).toMatch(/^epubcfi\(/);
  expect(await renderer.getToc()).toMatchObject([
    { label: 'Chapter 1', locator: { kind: 'cfi' } },
    { label: 'Chapter 2', locator: { kind: 'cfi' } },
  ]);
  const unsubscribe = renderer.onRelocate(vi.fn());
  unsubscribe();
  const view = host.querySelector('foliate-view') as TestView;
  renderer.applySettings({ fontSizePx: 22, lineHeight: 1.8, marginPx: 32, theme: 'dark' });
  expect(view.renderer.setStyles).toHaveBeenCalledWith(expect.stringContaining('22px'));
  renderer.destroy();
  expect(view.close).toHaveBeenCalled();
  expect(host.children.length).toBe(0);
  expect(urls.size).toBe(0);
});

it('restores native CFI and reports fraction fallback for an unresolved locator', async () => {
  const { renderer, host } = await adapter();
  const report = vi.fn();
  host.addEventListener('reader-message', report);
  const relocated = vi.fn();
  renderer.onRelocate(relocated);
  await renderer.open(new Blob([buildEpubFixture({ chapters: 2 })]), {
    kind: 'cfi',
    value: 'invalid',
    fraction: 0.5,
  });
  expect(report).toHaveBeenCalledOnce();
  expect(relocated).toHaveBeenLastCalledWith(
    expect.objectContaining({ kind: 'cfi', fraction: 0.5 }),
    0.5,
  );
  renderer.destroy();
});

it('rejects malformed archives without leaving a mounted view', async () => {
  const { renderer, host } = await adapter();
  await expect(
    renderer.open(new Blob([buildEpubFixture({ omitContainer: true })])),
  ).rejects.toThrow();
  renderer.destroy();
  expect(host.children.length).toBe(0);
});

it('translates nested fragment entries with real CFI round-trips, disables missing targets and caches section parsing', async () => {
  const { renderer, host } = await adapter();
  await renderer.open(
    new Blob([
      buildEpubFixture({
        paragraphs: 10,
        toc: [
          {
            label: 'Chapter 1',
            href: 'chapter1.xhtml',
            children: [
              { label: 'Earlier', href: 'chapter1.xhtml#paragraph-2' },
              { label: 'Later', href: 'chapter1.xhtml#paragraph-4' },
              { label: 'Missing fragment', href: 'chapter1.xhtml#missing' },
              { label: 'Missing chapter', href: 'missing.xhtml' },
              { label: 'External', href: 'https://example.invalid/' },
            ],
          },
        ],
      }),
    ]),
  );
  const view = host.querySelector('foliate-view') as TestView;
  const parse = vi.spyOn(view.book.sections[0]!, 'createDocument');
  const toc = await renderer.getToc();
  expect(toc[0]?.label).toBe('Chapter 1');
  expect(parse).toHaveBeenCalledOnce();
  expect(await renderer.getToc()).toBe(toc);
  expect(parse).toHaveBeenCalledOnce();
  const children = toc[0]!.children!;
  const target = view.book.resolveCFI(children[1]!.locator!.value);
  const doc = await view.book.sections[target.index]!.createDocument();
  const range = target.anchor(doc);
  const element =
    range.startContainer instanceof Element
      ? range.startContainer
      : range.startContainer.parentElement;
  expect(element?.closest('p')?.id).toBe('paragraph-4');
  expect(children.slice(2).every((item) => item.locator === undefined)).toBe(true);
  renderer.destroy();
});
