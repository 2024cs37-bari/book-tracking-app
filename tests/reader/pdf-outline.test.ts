import { describe, expect, it } from 'vitest';
import { buildPdfToc, type PdfOutlineNode, type PdfOutlineSource } from '~/reader/pdf-outline';
import { parsePdfLocator } from '~/domain/locator';

interface FakeOptions {
  readonly outline: readonly PdfOutlineNode[] | null;
  readonly numPages?: number;
  /** Named destination -> explicit destination array. */
  readonly named?: Record<string, unknown[] | null>;
  /** Page-ref object identity -> zero-based page index. */
  readonly pageIndex?: (ref: object) => number;
  readonly outlineThrows?: boolean;
}

function makeSource(options: FakeOptions): PdfOutlineSource {
  return {
    numPages: options.numPages ?? 10,
    getOutline: async () => {
      if (options.outlineThrows === true) throw new Error('boom');
      return options.outline;
    },
    getDestination: async (id) => options.named?.[id] ?? null,
    getPageIndex: async (ref) => {
      const resolve = options.pageIndex;
      if (resolve === undefined) throw new Error('no page index resolver');
      return resolve(ref);
    },
  };
}

describe('buildPdfToc', () => {
  it('returns an empty list when the PDF has no outline', async () => {
    expect(await buildPdfToc(makeSource({ outline: null }))).toEqual([]);
    expect(await buildPdfToc(makeSource({ outline: [] }))).toEqual([]);
  });

  it('returns an empty list when reading the outline throws', async () => {
    expect(await buildPdfToc(makeSource({ outline: [], outlineThrows: true }))).toEqual([]);
  });

  it('resolves explicit and named destinations to page locators', async () => {
    const chapterTwoRef = { num: 20, gen: 0 };
    const source = makeSource({
      numPages: 20,
      outline: [
        { title: 'Chapter One', dest: [{ num: 10, gen: 0 }, { name: 'XYZ' }] },
        { title: 'Chapter Two', dest: 'ch2' },
      ],
      named: { ch2: [chapterTwoRef, { name: 'Fit' }] },
      pageIndex: (ref) => {
        if (ref === chapterTwoRef) return 10;
        return 0;
      },
    });

    const toc = await buildPdfToc(source);
    expect(toc).toHaveLength(2);
    expect(toc[0]!.label).toBe('Chapter One');
    expect(parsePdfLocator(toc[0]!.locator!.value)).toEqual({ page: 0, yOffset: 0 });
    expect(toc[1]!.label).toBe('Chapter Two');
    const chapterTwo = parsePdfLocator(toc[1]!.locator!.value);
    expect(chapterTwo).toEqual({ page: 10, yOffset: 0 });
    expect(toc[1]!.locator!.fraction).toBeCloseTo(0.5);
  });

  it('keeps the label but drops the locator for an unresolvable destination', async () => {
    const source = makeSource({
      outline: [{ title: 'Broken Link', dest: 'missing' }, { title: 'No Destination' }],
      named: {},
      pageIndex: () => 0,
    });

    const toc = await buildPdfToc(source);
    expect(toc).toHaveLength(2);
    expect(toc[0]!.label).toBe('Broken Link');
    expect(toc[0]!.locator).toBeUndefined();
    expect(toc[1]!.locator).toBeUndefined();
  });

  it('converts nested outline items recursively', async () => {
    const source = makeSource({
      outline: [
        {
          title: 'Part I',
          dest: [{ num: 1, gen: 0 }],
          items: [{ title: 'Section A', dest: [{ num: 2, gen: 0 }] }],
        },
      ],
      pageIndex: () => 1,
    });

    const toc = await buildPdfToc(source);
    expect(toc[0]!.label).toBe('Part I');
    expect(toc[0]!.children).toHaveLength(1);
    expect(toc[0]!.children![0]!.label).toBe('Section A');
  });

  it('falls back to a placeholder label when a node has no title', async () => {
    const source = makeSource({ outline: [{ dest: [{ num: 1, gen: 0 }] }], pageIndex: () => 0 });
    const toc = await buildPdfToc(source);
    expect(toc[0]!.label).toBe('Untitled section');
  });
});
