// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { EpubRenderer } from '~/reader/epub-renderer';
import type { SearchHit } from '~/reader/renderer';
import type { Locator } from '~/domain/locator';
import { buildEpubFixture } from '../support/fixtures';

/**
 * Drives the EPUB renderer's `search()` against the REAL vendored foliate-js
 * search pipeline: `search.js` (its `{ pre, match, post }` excerpt builder) and
 * `text-walker.js` run over documents parsed by the real `epub.js`, and CFIs
 * come from the real `epubcfi.js`. jsdom has no layout, so — exactly as the
 * sibling `epub-renderer.dom.test.ts` does — the paginating `foliate-view`
 * element is replaced by a lightweight stand-in. The replacement's `search`
 * mirrors foliate `View#searchBook` (vendor/foliate-js/view.js) so the real
 * matcher output flows through the renderer's `flattenExcerpt`, `searchToken`
 * guard and `clearSearch` teardown; the real overlay highlighting (addAnnotation)
 * needs the paginator and is therefore the only part left unexercised here.
 */

type Excerpt = { readonly pre: string; readonly match: string; readonly post: string };
type MatcherResult = { readonly range: Range; readonly excerpt: Excerpt };
type Matcher = (doc: Document, query: string) => Iterable<MatcherResult>;
type SearchResult =
  | 'done'
  | { readonly progress: number }
  | { readonly label: string; readonly subitems: ReadonlyArray<{ cfi: string; excerpt: Excerpt }> };

interface TestBook {
  sections: { load(): Promise<string>; createDocument(): Promise<Document>; cfi: string }[];
  resolveHref(value: string): { index: number; anchor: (doc: Document) => unknown } | undefined;
  resolveCFI(value: string): { index: number; anchor: (doc: Document) => Range };
  destroy(): void;
}

const urls = new Map<string, Blob>();
let cfi: { joinIndir(base: string, anchor: string): string; fromRange(range: Range): string };
let searchMatcher: (walker: unknown, options: Record<string, unknown>) => Matcher;
let textWalker: unknown;

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
  clearSearch = vi.fn();
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
  // Mirrors foliate View#searchBook: real matcher + excerpts + CFIs per section.
  async *search(opts: { query: string }): AsyncGenerator<SearchResult> {
    const sections = this.book.sections;
    for (let index = 0; index < sections.length; index += 1) {
      const doc = await sections[index]!.createDocument();
      const matcher = searchMatcher(textWalker, { defaultLocale: 'en' });
      const subitems = Array.from(matcher(doc, opts.query), ({ range, excerpt }) => ({
        cfi: this.getCFI(index, range),
        excerpt,
      }));
      yield { progress: (index + 1) / sections.length };
      if (subitems.length > 0) yield { label: `Section ${index + 1}`, subitems };
    }
    yield 'done';
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
  ({ searchMatcher } = (await import('../../vendor/foliate-js/search.js' as string)) as {
    searchMatcher: typeof searchMatcher;
  });
  ({ textWalker } = (await import('../../vendor/foliate-js/text-walker.js' as string)) as {
    textWalker: unknown;
  });
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

async function collect(iterable: AsyncIterable<SearchHit>): Promise<SearchHit[]> {
  const hits: SearchHit[] = [];
  for await (const hit of iterable) hits.push(hit);
  return hits;
}

it('flattens real foliate excerpts into non-empty strings and navigates to a hit', async () => {
  const { renderer } = await adapter();
  const relocations: Locator[] = [];
  renderer.onRelocate((locator) => relocations.push(locator));
  await renderer.open(new Blob([buildEpubFixture({ chapters: 2, paragraphs: 3 })]));

  const hits = await collect(renderer.search('Generated reader content'));
  // Every generated paragraph contains the phrase, so there is at least one hit
  // per section and the per-section progress fallback is exercised.
  expect(hits.length).toBeGreaterThan(0);
  for (const hit of hits) {
    expect(typeof hit.excerpt).toBe('string');
    // Guards the `{ pre, match, post }` flattening: an object or empty string here
    // would mean the three-part excerpt was mishandled.
    expect(hit.excerpt.length).toBeGreaterThan(0);
    expect(hit.excerpt.toLowerCase()).toContain('generated reader content');
    expect(hit.locator.kind).toBe('cfi');
    expect(hit.locator.value).toMatch(/^epubcfi\(/);
  }

  const view = document.querySelector('foliate-view') as TestView;
  const navigate = vi.spyOn(view.renderer, 'goTo');
  const before = relocations.length;
  renderer.goTo(hits[0]!.locator);
  await vi.waitFor(() => expect(relocations.length).toBeGreaterThan(before));
  expect(navigate).toHaveBeenCalled();
  expect(relocations.at(-1)!.kind).toBe('cfi');
  renderer.destroy();
});

it('matches a phrase that spans two generated paragraphs within one section', async () => {
  const { renderer } = await adapter();
  await renderer.open(new Blob([buildEpubFixture({ chapters: 1, paragraphs: 2 })]));
  // Blank query yields nothing; a real phrase yields the flattened hits.
  expect(await collect(renderer.search('   '))).toHaveLength(0);
  const hits = await collect(renderer.search('paragraph 1'));
  expect(hits.length).toBeGreaterThan(0);
  expect(hits.every((hit) => hit.excerpt.length > 0)).toBe(true);
  renderer.destroy();
});

it('stops early when the search is aborted', async () => {
  const { renderer } = await adapter();
  await renderer.open(new Blob([buildEpubFixture({ chapters: 2, paragraphs: 2 })]));
  const controller = new AbortController();
  controller.abort();
  expect(
    await collect(renderer.search('Generated reader content', controller.signal)),
  ).toHaveLength(0);
  renderer.destroy();
});

it('skips a hit whose CFI exceeds the locator length cap instead of aborting the search', async () => {
  const { renderer } = await adapter();
  await renderer.open(new Blob([buildEpubFixture({ chapters: 1, paragraphs: 1 })]));
  const view = document.querySelector('foliate-view') as TestView;

  // One matcher can emit a range CFI longer than MAX_LOCATOR_VALUE_LENGTH (512);
  // such a hit cannot be navigated to, but it must not take the rest down with it.
  const overLongCfi = `epubcfi(${'/2'.repeat(300)})`;
  const validCfi = 'epubcfi(/6/4!/4/2/1:0)';
  expect(overLongCfi.length).toBeGreaterThan(512);
  vi.spyOn(view, 'search').mockImplementation(async function* () {
    yield { progress: 1 };
    yield {
      label: 'Section 1',
      subitems: [
        { cfi: overLongCfi, excerpt: { pre: '', match: 'drop', post: '' } },
        { cfi: validCfi, excerpt: { pre: 'a ', match: 'keep', post: ' b' } },
      ],
    };
    yield 'done';
  });

  const hits = await collect(renderer.search('x'));
  expect(hits).toHaveLength(1);
  expect(hits[0]!.locator.value).toBe(validCfi);
  expect(hits[0]!.excerpt).toContain('keep');
  renderer.destroy();
});

it('lists spine sections as pages for the sidebar, with no thumbnails', async () => {
  const { renderer } = await adapter();
  await renderer.open(new Blob([buildEpubFixture({ chapters: 3, paragraphs: 2 })]));
  expect(renderer.supportsThumbnails).toBe(false);
  const pages = await renderer.listPages();
  expect(pages.length).toBeGreaterThan(0);
  expect(pages[0]!.locator.kind).toBe('cfi');
  expect(await renderer.renderThumbnail(0, 160)).toBeNull();
  renderer.destroy();
});

it('a newer search prevents the superseded one from clearing the view', async () => {
  const { renderer } = await adapter();
  await renderer.open(new Blob([buildEpubFixture({ chapters: 2, paragraphs: 2 })]));
  const view = document.querySelector('foliate-view') as TestView;
  const clear = view.clearSearch;
  clear.mockClear();

  // Start the first search and pull one hit so it owns the current token and is
  // suspended mid-iteration.
  const first = renderer.search('Generated reader content');
  expect((await first.next()).done).toBe(false);

  // A second search preempts it: the token now belongs to the newer search.
  const second = renderer.search('Generated reader content');
  await second.next();

  // Finishing the superseded search must NOT clear the view the newer one owns.
  await first.return(undefined);
  expect(clear).not.toHaveBeenCalled();

  // Draining the current search to completion clears exactly once.
  while (!(await second.next()).done) {
    /* consume remaining hits */
  }
  expect(clear).toHaveBeenCalledTimes(1);
  renderer.destroy();
});
