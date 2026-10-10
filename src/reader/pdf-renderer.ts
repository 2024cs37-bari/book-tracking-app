import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PDFPageProxy,
  RenderTask,
} from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { observePdfStreamErrors } from './pdf-stream-errors';
import { buildPdfToc, type PdfOutlineNode } from './pdf-outline';
import {
  assertLocator,
  createPdfHighlightLocator,
  createPdfLocator,
  parsePdfHighlight,
  parsePdfLocator,
  type Locator,
} from '~/domain/locator';
import {
  DEFAULT_READER_SETTINGS,
  type Highlight,
  type ReaderSettings,
  type Renderer,
  type SearchHit,
  type SelectionInfo,
  type TocItem,
} from './renderer';

/** Highlight colour tokens → concrete CSS colours (drawn at low opacity). */
const PDF_HIGHLIGHT_COLORS: Record<string, string> = {
  yellow: '#f6c744',
  green: '#5bd08a',
  blue: '#5aa9f6',
  pink: '#f67ab5',
};

export const PDF_MAX_CANVAS_PIXELS = 4_000_000;
export const PDF_PAGE_CACHE_LIMIT = 1;

/** Minimal structural type for pdf.js's TextLayer, to avoid importing it eagerly. */
interface PdfTextLayer {
  render(): Promise<unknown>;
  readonly textDivs: HTMLElement[];
  readonly textContentItemsStr: string[];
}
type PdfTextLayerCtor = new (opts: {
  textContentSource: ReadableStream;
  container: HTMLElement;
  viewport: unknown;
}) => PdfTextLayer;

/** One visible page at a time: no canvases or decoded resources for hidden pages. */
export class PdfRenderer implements Renderer {
  private host?: HTMLElement;
  private scroller?: HTMLDivElement;
  private loading?: PDFDocumentLoadingTask;
  private document?: PDFDocumentProxy;
  private page?: PDFPageProxy;
  private task?: RenderTask;
  private canvas?: HTMLCanvasElement;
  private index = 0;
  private renderedIndex?: number;
  private scale = 1;
  private height = 1;
  private dead = false;
  private generation = 0;
  private streamError?: unknown;
  private queue: Promise<void> = Promise.resolve();
  private settings = DEFAULT_READER_SETTINGS;
  private textLayerCtor?: PdfTextLayerCtor;
  private pageEl?: HTMLDivElement;
  readonly supportsHighlights = true;
  private highlights: readonly Highlight[] = [];
  private readonly selectionCallbacks = new Set<(selection: SelectionInfo | null) => void>();
  private textLayerEl?: HTMLElement;
  private highlightLayerEl?: HTMLDivElement;
  private textPageIndex = -1;
  private callbacks = new Set<(locator: Locator, fraction: number) => void>();
  private readonly scroll = () => this.emit();
  private resize?: ResizeObserver;

  mount(host: HTMLElement): void {
    this.host = host;
    const scroller = document.createElement('div');
    scroller.className = 'pdf-scroll';
    scroller.tabIndex = 0;
    scroller.setAttribute('aria-label', 'PDF page');
    scroller.addEventListener('scroll', this.scroll);
    document.addEventListener('selectionchange', this.onSelectionChange);
    host.append(scroller);
    this.scroller = scroller;
    this.resize = new ResizeObserver(() => {
      if (this.document) this.move(this.index, this.offset());
    });
    this.resize.observe(host);
  }
  async open(file: Blob, startAt?: Locator): Promise<void> {
    if (!this.host || this.dead) throw new Error('Reader is not mounted.');
    if (this.loading) throw new Error('Create a new reader session to open another book.');
    const { getDocument, GlobalWorkerOptions, TextLayer } = await import('pdfjs-dist');
    if (this.dead) return;
    this.textLayerCtor = TextLayer as unknown as PdfTextLayerCtor;
    GlobalWorkerOptions.workerSrc = workerUrl;
    const base = `${import.meta.env.BASE_URL}pdf-assets/`;
    this.loading = getDocument({
      data: new Uint8Array(await file.arrayBuffer()),
      isEvalSupported: false,
      stopAtErrors: true,
      cMapUrl: `${base}cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${base}standard_fonts/`,
      wasmUrl: `${base}wasm/`,
      maxImageSize: PDF_MAX_CANVAS_PIXELS,
      canvasMaxAreaInBytes: PDF_MAX_CANVAS_PIXELS * 4,
    });
    try {
      const pdf = await this.loading.promise;
      if (this.dead) {
        await pdf.destroy();
        return;
      }
      this.document = pdf;
      observePdfStreamErrors(pdf, (pageIndex) => {
        const generation = this.generation;
        return (error) => {
          if (this.dead || generation !== this.generation || pageIndex !== this.index) return;
          this.streamError = error;
          this.task?.cancel();
        };
      });
      let index = 0;
      let offset = 0;
      if (startAt) {
        assertLocator(startAt);
        const position = startAt.kind === 'pdf' ? parsePdfLocator(startAt.value) : null;
        if (position && position.page < pdf.numPages) {
          index = position.page;
          offset = position.yOffset;
        } else {
          index = Math.min(pdf.numPages - 1, Math.floor(startAt.fraction * pdf.numPages));
          this.host.dispatchEvent(
            new CustomEvent('reader-message', {
              detail: 'Position restored approximately from percentage.',
            }),
          );
        }
      }
      await this.schedule(index, offset);
    } catch (error) {
      this.destroy();
      throw error;
    }
  }

  private offset(): number {
    return Math.max(0, (this.scroller?.scrollTop ?? 0) - this.settings.marginPx) / this.scale;
  }
  private emit(): void {
    if (
      !this.document ||
      !this.canvas ||
      this.renderedIndex === undefined ||
      this.canvas.dataset.renderState !== 'ready' ||
      this.dead
    )
      return;
    const offset = this.offset();
    const locator = createPdfLocator(
      this.renderedIndex,
      offset,
      (this.renderedIndex + Math.min(1, offset / this.height)) / this.document.numPages,
    );
    for (const callback of this.callbacks) callback(locator, locator.fraction);
  }
  private schedule(index: number, offset = 0): Promise<void> {
    const pdf = this.document;
    if (!pdf || this.dead) return Promise.resolve();
    this.index = Math.max(0, Math.min(pdf.numPages - 1, index));
    const target = this.index;
    const generation = ++this.generation;
    this.task?.cancel();
    const result = this.queue
      .catch(() => {})
      .then(async () => {
        if (this.dead || generation !== this.generation) return;
        this.releasePage();
        this.streamError = undefined;
        await pdf.cleanup();
        const page = await pdf.getPage(target + 1);
        if (this.dead || generation !== this.generation) {
          page.cleanup();
          return;
        }
        this.page = page;
        const natural = page.getViewport({ scale: 1 });
        this.height = natural.height;
        const width = Math.max(200, (this.host?.clientWidth ?? 800) - 2 * this.settings.marginPx);
        const requestedScale = ((width / natural.width) * this.settings.fontSizePx) / 18;
        const pixelRatio = Math.min(globalThis.devicePixelRatio || 1, 2);
        this.scale = Math.min(
          requestedScale,
          Math.sqrt(PDF_MAX_CANVAS_PIXELS / (natural.width * natural.height)) / pixelRatio,
        );
        const viewport = page.getViewport({ scale: this.scale * pixelRatio });
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = `${canvas.width / pixelRatio}px`;
        canvas.style.height = `${canvas.height / pixelRatio}px`;
        canvas.setAttribute('aria-label', `Page ${target + 1} of ${pdf.numPages}`);
        canvas.dataset.renderState = 'pending';
        this.canvas = canvas;
        const pageEl = document.createElement('div');
        pageEl.className = 'pdf-page';
        pageEl.append(canvas);
        this.pageEl = pageEl;
        // The old page's text/highlight layers are gone; the new ones attach
        // when this page's text layer finishes rendering.
        this.textLayerEl = undefined;
        this.highlightLayerEl = undefined;
        this.scroller!.replaceChildren(pageEl);
        this.scroller!.scrollTop = offset > 0 ? this.settings.marginPx + offset * this.scale : 0;
        const task = page.render({ canvas, viewport });
        this.task = task;
        try {
          await task.promise;
        } catch (error) {
          if (generation === this.generation && !this.dead) {
            this.releasePage();
            throw this.streamError ?? error;
          }
        } finally {
          if (this.task === task) this.task = undefined;
        }
        if (generation === this.generation && !this.dead) {
          if (this.streamError) {
            this.releasePage();
            throw this.streamError;
          }
          this.renderedIndex = target;
          canvas.dataset.renderState = 'ready';
          this.scroller!.scrollTop = offset > 0 ? this.settings.marginPx + offset * this.scale : 0;
          this.emit();
          // A selectable text layer over the canvas; drawn after the page so it
          // never delays the first paint. Stale appends are guarded by pageEl.
          void this.renderTextLayer(page, pageEl, generation, target);
        }
      });
    this.queue = result;
    return result;
  }
  private async renderTextLayer(
    page: PDFPageProxy,
    pageEl: HTMLDivElement,
    generation: number,
    pageIndex: number,
  ): Promise<void> {
    const ctor = this.textLayerCtor;
    if (!ctor) return;
    try {
      const viewport = page.getViewport({ scale: this.scale });
      const container = document.createElement('div');
      container.className = 'textLayer';
      container.style.setProperty('--scale-factor', String(this.scale));
      container.style.setProperty('--total-scale-factor', String(this.scale));
      container.style.width = `${Math.floor(viewport.width)}px`;
      container.style.height = `${Math.floor(viewport.height)}px`;
      const layer = new ctor({ textContentSource: page.streamTextContent(), container, viewport });
      await layer.render();
      if (generation !== this.generation || this.dead || this.pageEl !== pageEl) return;
      const highlightLayer = document.createElement('div');
      highlightLayer.className = 'pdf-highlight-layer';
      pageEl.append(container, highlightLayer);
      this.textLayerEl = container;
      this.highlightLayerEl = highlightLayer;
      this.textPageIndex = pageIndex;
      this.drawHighlights();
    } catch {
      // The text layer is a selection/accessibility enhancement; a failure must
      // not break page rendering.
    }
  }
  onSelection(callback: (selection: SelectionInfo | null) => void): () => void {
    this.selectionCallbacks.add(callback);
    return () => this.selectionCallbacks.delete(callback);
  }
  applyHighlights(highlights: readonly Highlight[]): void {
    this.highlights = highlights;
    this.drawHighlights();
  }
  private emitSelection(selection: SelectionInfo | null): void {
    for (const callback of this.selectionCallbacks) callback(selection);
  }
  private readonly onSelectionChange = (): void => {
    const el = this.textLayerEl;
    const selection = el ? document.getSelection() : null;
    if (!el || !selection || selection.rangeCount === 0 || selection.isCollapsed) {
      this.emitSelection(null);
      return;
    }
    const range = selection.getRangeAt(0);
    if (!el.contains(range.startContainer) || !el.contains(range.endContainer)) {
      this.emitSelection(null);
      return;
    }
    const a = this.globalOffset(el, range.startContainer, range.startOffset);
    const b = this.globalOffset(el, range.endContainer, range.endOffset);
    const text = selection.toString().replace(/\s+/g, ' ').trim();
    if (a === null || b === null || a === b || text === '') {
      this.emitSelection(null);
      return;
    }
    const [start, end] = a < b ? [a, b] : [b, a];
    const pageRect = this.pageEl?.getBoundingClientRect();
    const first = range.getClientRects()[0];
    const yOffset = pageRect && first ? Math.max(0, (first.top - pageRect.top) / this.scale) : 0;
    const pages = this.document?.numPages ?? 1;
    try {
      const locator = createPdfHighlightLocator(
        this.textPageIndex,
        yOffset,
        start,
        end,
        this.textPageIndex / pages,
      );
      this.emitSelection({ locator, excerpt: text.slice(0, 300) });
    } catch {
      this.emitSelection(null);
    }
  };
  /** Character offset of a DOM point within the text layer's rendered text. */
  private globalOffset(el: HTMLElement, node: Node, offset: number): number | null {
    try {
      const range = document.createRange();
      range.setStart(el, 0);
      range.setEnd(node, offset);
      return range.toString().length;
    } catch {
      return null;
    }
  }
  /** Resolves a character offset back to a (text node, offset) within el. */
  private resolvePoint(el: HTMLElement, target: number): { node: Node; offset: number } | null {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let seen = 0;
    let last: Node | null = null;
    let node = walker.nextNode();
    while (node) {
      const length = node.nodeValue?.length ?? 0;
      if (seen + length >= target) return { node, offset: target - seen };
      seen += length;
      last = node;
      node = walker.nextNode();
    }
    return last ? { node: last, offset: last.nodeValue?.length ?? 0 } : null;
  }
  private drawHighlights(): void {
    const el = this.textLayerEl;
    const layer = this.highlightLayerEl;
    const pageEl = this.pageEl;
    if (!el || !layer || !pageEl) return;
    layer.replaceChildren();
    const pageRect = pageEl.getBoundingClientRect();
    for (const highlight of this.highlights) {
      const anchor = parsePdfHighlight(highlight.locator.value);
      if (!anchor || anchor.page !== this.textPageIndex) continue;
      const start = this.resolvePoint(el, anchor.start);
      const end = this.resolvePoint(el, anchor.end);
      if (!start || !end) continue;
      const range = document.createRange();
      try {
        range.setStart(start.node, start.offset);
        range.setEnd(end.node, end.offset);
      } catch {
        continue;
      }
      const color = highlight.color
        ? (PDF_HIGHLIGHT_COLORS[highlight.color] ?? highlight.color)
        : (PDF_HIGHLIGHT_COLORS.yellow ?? '#f6c744');
      for (const rect of range.getClientRects()) {
        const box = document.createElement('div');
        box.className = 'pdf-highlight';
        box.style.left = `${rect.left - pageRect.left}px`;
        box.style.top = `${rect.top - pageRect.top}px`;
        box.style.width = `${rect.width}px`;
        box.style.height = `${rect.height}px`;
        box.style.setProperty('--pdf-highlight-color', color);
        layer.append(box);
      }
    }
  }
  private move(index: number, offset = 0): void {
    void this.schedule(index, offset).catch((error: unknown) =>
      this.host?.dispatchEvent(
        new CustomEvent('reader-message', { detail: `PDF rendering failed: ${String(error)}` }),
      ),
    );
  }
  goTo(locator: Locator): void {
    assertLocator(locator);
    const position = locator.kind === 'pdf' ? parsePdfLocator(locator.value) : null;
    if (position) this.move(position.page, position.yOffset);
  }
  prev(): void {
    this.move(this.index - 1);
  }
  next(): void {
    this.move(this.index + 1);
  }
  async getToc(): Promise<TocItem[]> {
    const pdf = this.document;
    if (!pdf || this.dead) return [];
    return buildPdfToc({
      numPages: pdf.numPages,
      getOutline: () => pdf.getOutline() as Promise<readonly PdfOutlineNode[] | null>,
      getDestination: (id) => pdf.getDestination(id),
      getPageIndex: (ref) => pdf.getPageIndex(ref as Parameters<typeof pdf.getPageIndex>[0]),
    });
  }
  onRelocate(callback: (locator: Locator, fraction: number) => void): () => void {
    this.callbacks.add(callback);
    return () => this.callbacks.delete(callback);
  }
  async *search(query: string, signal?: AbortSignal): AsyncGenerator<SearchHit> {
    const pdf = this.document;
    const needle = query.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!pdf || this.dead || needle.length === 0) return;
    const total = pdf.numPages;
    for (let pageIndex = 0; pageIndex < total; pageIndex += 1) {
      if (this.dead || signal?.aborted) break;
      let text: string;
      try {
        const page = await pdf.getPage(pageIndex + 1);
        try {
          const content = await page.getTextContent();
          // Join items with whitespace so a phrase split across text runs or a
          // line break still matches, then collapse runs so matching and
          // excerpts see single spaces.
          text = content.items
            .map((item) => ('str' in item ? item.str : ''))
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
        } finally {
          page.cleanup();
        }
      } catch {
        // A page that cannot be read is skipped, not fatal to the search.
        continue;
      }
      const haystack = text.toLowerCase();
      // Lowercasing is length-preserving for almost all text; fall back to the
      // lowercased snippet only when a rare case-fold changed the length.
      const excerptSource = haystack.length === text.length ? text : haystack;
      const fraction = total > 0 ? pageIndex / total : 0;
      let from = haystack.indexOf(needle);
      while (from !== -1) {
        if (this.dead || signal?.aborted) return;
        yield {
          locator: createPdfLocator(pageIndex, 0, fraction),
          excerpt: buildExcerpt(excerptSource, from, needle.length),
        };
        from = haystack.indexOf(needle, from + needle.length);
      }
    }
  }
  applySettings(settings: ReaderSettings): void {
    const offset = this.offset();
    this.settings = settings;
    if (this.scroller) {
      this.scroller.style.padding = `${settings.marginPx}px`;
      this.scroller.style.background = { light: '#fff', sepia: '#f4ecd8', dark: '#191919' }[
        settings.theme
      ];
    }
    if (this.document) this.move(this.index, offset);
  }
  private releasePage(): void {
    this.canvas?.remove();
    if (this.canvas) {
      this.canvas.width = 0;
      this.canvas.height = 0;
    }
    this.canvas = undefined;
    this.renderedIndex = undefined;
    this.page?.cleanup();
    this.page = undefined;
  }
  destroy(): void {
    if (this.dead) return;
    this.dead = true;
    this.generation++;
    this.task?.cancel();
    this.resize?.disconnect();
    this.scroller?.removeEventListener('scroll', this.scroll);
    document.removeEventListener('selectionchange', this.onSelectionChange);
    this.selectionCallbacks.clear();
    this.scroller?.remove();
    // Wait for cancellation before disposing the page/worker.
    void this.queue
      .catch(() => {})
      .then(async () => {
        this.releasePage();
        await this.loading?.destroy();
        this.loading = undefined;
        this.document = undefined;
        this.scroller = undefined;
      });
    this.callbacks.clear();
  }
}

/** A short snippet of surrounding text with the match roughly centered. */
function buildExcerpt(text: string, at: number, length: number): string {
  const radius = 40;
  const start = Math.max(0, at - radius);
  const end = Math.min(text.length, at + length + radius);
  const snippet = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${snippet}${end < text.length ? '…' : ''}`;
}
