import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PDFPageProxy,
  RenderTask,
} from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { observePdfStreamErrors } from './pdf-stream-errors';
import { buildPdfToc, type PdfOutlineNode } from './pdf-outline';
import { assertLocator, createPdfLocator, parsePdfLocator, type Locator } from '~/domain/locator';
import {
  DEFAULT_READER_SETTINGS,
  type ReaderSettings,
  type Renderer,
  type SearchHit,
  type TocItem,
} from './renderer';

export const PDF_MAX_CANVAS_PIXELS = 4_000_000;
export const PDF_PAGE_CACHE_LIMIT = 1;

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
  private callbacks = new Set<(locator: Locator, fraction: number) => void>();
  private readonly scroll = () => this.emit();
  private resize?: ResizeObserver;

  // Highlighting needs a selectable text layer, which the canvas-only PDF
  // renderer does not yet have; the capability is reported false so the reader
  // UI hides the affordance rather than offering a dead control.
  readonly supportsHighlights = false;
  onSelection(): () => void {
    return () => {};
  }
  applyHighlights(): void {}

  mount(host: HTMLElement): void {
    this.host = host;
    const scroller = document.createElement('div');
    scroller.className = 'pdf-scroll';
    scroller.tabIndex = 0;
    scroller.setAttribute('aria-label', 'PDF page');
    scroller.addEventListener('scroll', this.scroll);
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
    const { getDocument, GlobalWorkerOptions } = await import('pdfjs-dist');
    if (this.dead) return;
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
        this.scroller!.replaceChildren(canvas);
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
        }
      });
    this.queue = result;
    return result;
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
