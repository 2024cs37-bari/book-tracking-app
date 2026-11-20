import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PDFPageProxy,
  RenderTask,
} from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { observePdfStreamErrors } from './pdf-stream-errors';
import { friendlyPdfError, PDF_MAX_SOURCE_IMAGE_PIXELS } from './pdf-limits';
import { invertPdfCanvas } from './pdf-colors';
import {
  effectivePdfMode,
  pdfSpread,
  pdfDisplayScale,
  PDF_CONTINUOUS_CACHE_LIMIT,
  PDF_TOTAL_CANVAS_PIXELS,
} from './pdf-layout';
import { normalizeReaderSettings, type ReaderMode } from './settings';
import { AnnotationDiagnostics } from './annotation-diagnostics';
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
  type AnnotationAnchor,
  type AnnotationAnchorStatus,
  type ReaderPage,
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
export const PDF_MAX_CANVAS_EDGE = 16_384;
export const PDF_PAGE_CACHE_LIMIT = 1;
export const PDF_MAX_FILE_BYTES = 256 * 1024 * 1024;
/** Pixel ceiling for a sidebar page thumbnail (small, so cheap to render). */
export const PDF_THUMBNAIL_MAX_PIXELS = 400_000;
/**
 * Smallest width change (CSS px) that re-renders on resize. It is deliberately
 * larger than any desktop scrollbar: a tall page toggling a scrollbar changes
 * the measured width by ~15px, and re-rendering on that would loop forever
 * (render → page gets tall → scrollbar appears → width shrinks → render…). A
 * genuine window resize or sidebar drag always crosses this threshold.
 */
export const RESIZE_WIDTH_EPSILON = 24;
/** Pinch-to-zoom clamps the extra scale factor applied on top of the fit width. */
export const PDF_MIN_ZOOM = 0.5;
export const PDF_MAX_ZOOM = 4;

/** Minimal structural type for pdf.js's TextLayer, to avoid importing it eagerly. */
interface PdfTextLayer {
  render(): Promise<unknown>;
  cancel?(): void;
  readonly textDivs: HTMLElement[];
  readonly textContentItemsStr: string[];
}
type PdfTextLayerCtor = new (opts: {
  textContentSource: ReadableStream;
  container: HTMLElement;
  viewport: unknown;
}) => PdfTextLayer;

interface PageSurface {
  index: number;
  page: PDFPageProxy;
  canvas: HTMLCanvasElement;
  element: HTMLDivElement;
  scale: number;
  anchorScale: number;
  height: number;
  textLayer?: PdfTextLayer;
  text?: HTMLDivElement;
  highlights?: HTMLDivElement;
}

/** Bounded page surfaces share one document/worker across all reading modes. */
export class PdfRenderer implements Renderer {
  private host?: HTMLElement;
  private scroller?: HTMLDivElement;
  private loading?: PDFDocumentLoadingTask;
  private document?: PDFDocumentProxy;
  private pendingPage?: PDFPageProxy;
  private readonly borrowedPages = new Set<PDFPageProxy>();
  private readonly neighborErrors = new Set<number>();
  private committedPad = 24;
  private layoutAnchor?: { index: number; offset: number };
  private thumbnailQueue: Promise<void> = Promise.resolve();
  private readonly thumbnailTasks = new Set<RenderTask>();
  private task?: RenderTask;
  private canvas?: HTMLCanvasElement;
  private index = 0;
  private renderedIndex?: number;
  private scale = 1;
  private restoredOffset?: { scrollTop: number; value: number };
  private height = 1;
  private dead = false;
  private generation = 0;
  // Operator lists are shared by foreground pages and thumbnails. pdf.js may
  // retain a partial list after a decode failure, so remember the error for this
  // immutable document even when its first consumer was a background thumbnail.
  private readonly pageStreamErrors = new Map<number, unknown>();
  private queue: Promise<void> = Promise.resolve();
  private settings = DEFAULT_READER_SETTINGS;
  private textLayerCtor?: PdfTextLayerCtor;
  private pageEl?: HTMLDivElement;
  readonly supportsHighlights = true;
  readonly supportsThumbnails = true;
  private highlights: readonly Highlight[] = [];
  private readonly annotationDiagnostics = new AnnotationDiagnostics();
  private readonly selectionCallbacks = new Set<(selection: SelectionInfo | null) => void>();
  private callbacks = new Set<(locator: Locator, fraction: number) => void>();
  private readonly surfaces = new Map<number, PageSurface>();
  private readonly dimensions = new Map<number, { width: number; height: number }>();
  private slots: HTMLDivElement[] = [];
  private flow?: HTMLDivElement;
  private mode: ReaderMode = 'single';
  private layoutDirty = true;
  private restoring = false;
  private scheduledIndex?: number;
  private pendingNavigation?: { index: number; offset: number };
  private scrollFrame = 0;
  private lastHeight = 0;
  private readonly scroll = () => {
    if (this.restoring || this.dead || (this.layoutDirty && this.scheduledIndex !== undefined))
      return;
    if (this.mode !== 'continuous') {
      this.emit();
      return;
    }
    cancelAnimationFrame(this.scrollFrame);
    this.scrollFrame = requestAnimationFrame(() => this.followScroll());
  };
  private resize?: ResizeObserver;
  private lastWidth = 0;
  private resizeTimer?: ReturnType<typeof setTimeout>;
  /** Extra render-scale factor from pinch-to-zoom, on top of the fit-to-width scale. */
  private zoom = 1;
  /**
   * Transient zoom applied as a GPU CSS transform during a pinch/wheel gesture,
   * relative to the committed `zoom`. The sheet scales instantly and smoothly;
   * one re-raster at the new resolution runs when the gesture settles.
   */
  private liveZoom = 1;
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private pinchStartDistance = 0;
  private pinchStartZoom = 1;
  private pinchTimer?: ReturnType<typeof setTimeout>;

  mount(host: HTMLElement): void {
    this.host = host;
    const scroller = document.createElement('div');
    scroller.className = 'pdf-scroll';
    scroller.tabIndex = 0;
    scroller.setAttribute('aria-label', 'PDF pages');
    scroller.addEventListener('scroll', this.scroll);
    document.addEventListener('selectionchange', this.onSelectionChange);
    host.append(scroller);
    this.scroller = scroller;
    host.addEventListener('pointerdown', this.onPointerDown);
    host.addEventListener('pointermove', this.onPointerMove);
    host.addEventListener('pointerup', this.onPointerUp);
    host.addEventListener('pointercancel', this.onPointerUp);
    // Trackpad pinch and ctrl+wheel arrive as wheel events with ctrlKey; map
    // them to the render zoom (and prevent the browser zooming the whole page).
    host.addEventListener('wheel', this.onWheel, { passive: false });
    this.resize = new ResizeObserver(() => {
      if (!this.document || this.dead) return;
      // Measure width the SAME way move() does (clientWidth), and ignore
      // sub-threshold jitter. A height-only change (sidebar drag ticks) and the
      // pixel-or-two flutter a scrollbar toggle or fractional display scaling
      // can introduce must never re-raster — otherwise each render nudges the
      // measured width and the observer re-renders forever. move() also records
      // the width it rendered at, so the tick right after a render is a no-op.
      const width = this.host?.clientWidth ?? 0;
      const height = this.host?.clientHeight ?? 0;
      if (
        width === 0 ||
        (Math.abs(width - this.lastWidth) < RESIZE_WIDTH_EPSILON &&
          (this.settings.pdfFit !== 'page' ||
            Math.abs(height - this.lastHeight) < RESIZE_WIDTH_EPSILON))
      )
        return;
      this.lastWidth = width;
      clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => {
        if (this.document && !this.dead) {
          const anchor = this.pendingNavigation ?? {
            index: this.renderedIndex ?? this.index,
            offset: this.offset(),
          };
          this.layoutDirty = true;
          this.move(anchor.index, anchor.offset);
        }
      }, 150);
    });
    this.resize.observe(host);
  }
  async open(file: Blob, startAt?: Locator): Promise<void> {
    if (!this.host || this.dead) throw new Error('Reader is not mounted.');
    if (this.loading) throw new Error('Create a new reader session to open another book.');
    if (file.size > PDF_MAX_FILE_BYTES) throw new Error('PDF exceeds the 256 MiB reader limit.');
    const { getDocument, GlobalWorkerOptions, TextLayer } = await import('pdfjs-dist');
    if (this.dead) return;
    this.textLayerCtor = TextLayer as unknown as PdfTextLayerCtor;
    GlobalWorkerOptions.workerSrc = workerUrl;
    const base = `${import.meta.env.BASE_URL}pdf-assets/`;
    const data = new Uint8Array(await file.arrayBuffer());
    if (this.dead) return;
    this.loading = getDocument({
      data,
      isEvalSupported: false,
      stopAtErrors: true,
      cMapUrl: `${base}cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${base}standard_fonts/`,
      wasmUrl: `${base}wasm/`,
      maxImageSize: PDF_MAX_SOURCE_IMAGE_PIXELS,
      canvasMaxAreaInBytes: PDF_MAX_CANVAS_PIXELS * 4,
      isImageDecoderSupported: false,
    });
    try {
      const pdf = await this.loading.promise;
      if (this.dead) {
        await pdf.destroy();
        return;
      }
      this.document = pdf;
      observePdfStreamErrors(pdf, (pageIndex) => (error) => {
        if (this.dead) return;
        this.pageStreamErrors.set(pageIndex, error);
        if (pageIndex !== this.index) return;
        this.task?.cancel();
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
      throw friendlyPdfError(error);
    }
  }

  /** The scroller's top padding = where the page sheet starts (min 24 for the desk). */
  private pagePad(): number {
    return this.committedPad;
  }
  private offset(): number {
    if (this.layoutAnchor) return this.layoutAnchor.offset;
    const scrollTop = this.scroller?.scrollTop ?? 0;
    // WebKit rounds programmatic scrolling to CSS pixels. Re-serializing that
    // rounded position can lose PDF points on every reopen at fractional zoom.
    // Keep the intended anchor until the displayed scroll position changes.
    if (this.restoredOffset?.scrollTop === scrollTop) return this.restoredOffset.value;
    this.restoredOffset = undefined;
    return Math.max(0, scrollTop - this.pageTop(this.renderedIndex ?? this.index)) / this.scale;
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
  private pageTop(index: number): number {
    return this.pagePad() + (this.mode === 'continuous' ? (this.slots[index]?.offsetTop ?? 0) : 0);
  }
  private activate(surface: PageSurface): void {
    if (this.renderedIndex !== surface.index) this.restoredOffset = undefined;
    this.canvas = surface.canvas;
    this.pageEl = surface.element;
    this.renderedIndex = surface.index;
    this.scale = surface.anchorScale;
    this.height = surface.height;
  }
  private dispose(surface: PageSurface): void {
    surface.textLayer?.cancel?.();
    surface.canvas.width = 0;
    surface.canvas.height = 0;
    surface.element.remove();
    if (
      ![...this.surfaces.values()].some((other) => other !== surface && other.page === surface.page)
    ) {
      try {
        surface.page.cleanup();
      } catch {
        /* Already torn down. */
      }
    }
  }
  private rotation(page: PDFPageProxy): number {
    return ((page.rotate ?? 0) + this.settings.pdfRotation) % 360;
  }
  private size(page: PDFPageProxy): { width: number; height: number } {
    const size = page.getViewport({ scale: 1, rotation: this.rotation(page) });
    if (!Number.isFinite(size.width * size.height) || size.width <= 0 || size.height <= 0)
      throw new Error('PDF page dimensions are invalid.');
    return { width: size.width, height: size.height };
  }
  private layoutScale(sizes: readonly { width: number; height: number }[]): number {
    return (
      pdfDisplayScale(
        sizes,
        this.scroller?.clientWidth || this.host?.clientWidth || 800,
        this.scroller?.clientHeight || this.host?.clientHeight || 600,
        this.settings,
      ) * this.zoom
    );
  }
  private async paint(
    index: number,
    generation: number,
    displayScale: number,
    page: PDFPageProxy,
    mode: ReaderMode,
  ): Promise<PageSurface | undefined> {
    if (this.pageStreamErrors.has(index)) throw this.pageStreamErrors.get(index);
    const pdf = this.document!;
    this.borrowedPages.delete(page);
    this.pendingPage = page;
    let canvas: HTMLCanvasElement | undefined;
    let committed = false;
    try {
      if (this.dead || generation !== this.generation) return;
      const natural = this.size(page);
      const canonical = page.getViewport({ scale: 1 });
      const pixelRatio = Math.min(globalThis.devicePixelRatio || 1, 2);
      const budget =
        mode === 'continuous'
          ? PDF_TOTAL_CANVAS_PIXELS / PDF_CONTINUOUS_CACHE_LIMIT
          : PDF_MAX_CANVAS_PIXELS;
      const bitmapScale = Math.min(
        displayScale * pixelRatio,
        Math.sqrt(budget / (natural.width * natural.height)),
        PDF_MAX_CANVAS_EDGE / Math.max(natural.width, natural.height),
      );
      const viewport = page.getViewport({ scale: bitmapScale, rotation: this.rotation(page) });
      const cssViewport = page.getViewport({ scale: displayScale, rotation: this.rotation(page) });
      canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      canvas.style.width = `${Math.floor(cssViewport.width)}px`;
      canvas.style.height = `${Math.floor(cssViewport.height)}px`;
      canvas.setAttribute('aria-label', `Page ${index + 1} of ${pdf.numPages}`);
      canvas.dataset.renderState = 'pending';
      const element = document.createElement('div');
      element.className = 'pdf-page';
      element.dataset.pageIndex = String(index);
      element.append(canvas);
      const task = page.render({ canvas, viewport });
      this.task = task;
      try {
        await task.promise;
      } catch (error) {
        if (!this.dead && generation === this.generation)
          throw this.pageStreamErrors.get(index) ?? error;
        return;
      } finally {
        if (this.task === task) this.task = undefined;
      }
      if (this.dead || generation !== this.generation) return;
      if (this.pageStreamErrors.has(index)) throw this.pageStreamErrors.get(index);
      if (this.settings.pdfInvert) invertPdfCanvas(canvas);
      canvas.dataset.colorMode = this.settings.pdfInvert ? 'inverted' : 'original';
      canvas.dataset.renderState = 'ready';
      committed = true;
      return {
        index,
        page,
        canvas,
        element,
        scale: displayScale,
        anchorScale: cssViewport.height / canonical.height,
        height: canonical.height,
      };
    } finally {
      if (!committed) {
        if (canvas) {
          canvas.width = 0;
          canvas.height = 0;
        }
        if (![...this.surfaces.values()].some((surface) => surface.page === page)) page.cleanup();
      }
      if (this.pendingPage === page) this.pendingPage = undefined;
    }
  }
  private createFlow(): void {
    const flow = document.createElement('div');
    flow.className = 'pdf-flow';
    this.flow = flow;
    this.slots = Array.from({ length: this.document!.numPages }, (_, index) => {
      const slot = document.createElement('div');
      slot.className = 'pdf-slot';
      slot.dataset.pageIndex = String(index);
      slot.setAttribute('aria-label', `Page ${index + 1}`);
      const placeholder = document.createElement('span');
      placeholder.className = 'pdf-page-placeholder';
      placeholder.textContent = `Page ${index + 1}`;
      slot.append(placeholder);
      flow.append(slot);
      return slot;
    });
    this.resizeSlots();
    this.scroller!.replaceChildren(flow);
  }
  private resizeSlots(): void {
    const fallback = this.dimensions.values().next().value ?? { width: 612, height: 792 };
    for (let i = 0; i < this.slots.length; i++) {
      const size = this.dimensions.get(i) ?? fallback;
      const scale = this.layoutScale([size]);
      const slot = this.slots[i]!;
      slot.style.width = `${Math.floor(size.width * scale)}px`;
      slot.style.height = `${Math.floor(size.height * scale)}px`;
    }
  }
  private continuousTargets(index: number): number[] {
    const top = this.scroller?.scrollTop ?? 0;
    const bottom = top + (this.scroller?.clientHeight || 600);
    const targets = [index];
    for (
      let i = index + 1;
      i < this.slots.length && targets.length < PDF_CONTINUOUS_CACHE_LIMIT - 1;
      i++
    ) {
      targets.push(i);
      if (this.pageTop(i) > bottom) break;
    }
    if (index > 0 && targets.length < PDF_CONTINUOUS_CACHE_LIMIT) targets.push(index - 1);
    return targets;
  }
  private followScroll(): void {
    if (
      !this.flow ||
      this.mode !== 'continuous' ||
      this.dead ||
      (this.layoutDirty && this.scheduledIndex !== undefined)
    )
      return;
    const top = (this.scroller?.scrollTop ?? 0) + this.pagePad() + 1;
    // Binary search lightweight placeholders; only nearby pages are decoded.
    let low = 0,
      high = this.slots.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (this.pageTop(mid) <= top) low = mid;
      else high = mid - 1;
    }
    const index = low;
    const surface = this.surfaces.get(index);
    if (surface) {
      this.activate(surface);
      this.emit();
    }
    if (
      this.index !== index ||
      (this.scheduledIndex !== index &&
        this.continuousTargets(index).some(
          (i) =>
            !this.surfaces.has(i) && !this.pageStreamErrors.has(i) && !this.neighborErrors.has(i),
        ))
    ) {
      void this.schedule(index, 0, false).catch((error: unknown) => this.report(error));
    }
  }
  private schedule(index: number, offset = 0, navigate = true): Promise<void> {
    const pdf = this.document;
    if (!pdf || this.dead) return Promise.resolve();
    this.index = Math.max(0, Math.min(pdf.numPages - 1, index));
    const target = this.index;
    this.pendingNavigation = navigate ? { index: target, offset } : undefined;
    this.scheduledIndex = target;
    const generation = ++this.generation;
    this.task?.cancel();
    const result = this.queue
      .catch(() => {})
      .then(async () => {
        if (this.dead || generation !== this.generation) return;
        const mode = effectivePdfMode(this.settings, this.host?.clientWidth || 800);
        const rebuild = this.layoutDirty || mode !== this.mode;
        const group =
          mode === 'double'
            ? pdfSpread(target, pdf.numPages, this.settings.pdfCoverAlone)
            : [target];
        const fresh: PageSurface[] = [];
        try {
          // Paint the requested page before replacing any working content.
          const groupPages: PDFPageProxy[] = [];
          if (mode !== 'continuous' || rebuild || !this.surfaces.has(target)) {
            for (const i of group) {
              if (this.pageStreamErrors.has(i)) throw this.pageStreamErrors.get(i);
              const page = await pdf.getPage(i + 1);
              this.borrowedPages.add(page);
              if (this.dead || generation !== this.generation) return;
              groupPages.push(page);
              this.dimensions.set(i, this.size(page));
            }
            const scale = this.layoutScale(group.map((i) => this.dimensions.get(i)!));
            for (let i = 0; i < group.length; i++) {
              const surface = await this.paint(group[i]!, generation, scale, groupPages[i]!, mode);
              if (!surface) return;
              fresh.push(surface);
            }
          }
          if (this.dead || generation !== this.generation) return;
          this.restoring = true;
          this.mode = mode;
          this.committedPad = Math.max(this.settings.marginPx, 24);
          this.scroller!.style.padding = `${this.committedPad}px`;
          if (rebuild || mode !== 'continuous') {
            const old = [...this.surfaces.values()];
            this.surfaces.clear();
            if (mode === 'continuous') this.createFlow();
            else {
              this.flow = undefined;
              this.slots = [];
              const spread = document.createElement('div');
              spread.className = 'pdf-spread';
              spread.style.flexDirection =
                this.settings.pdfDirection === 'rtl' ? 'row-reverse' : 'row';
              this.scroller!.replaceChildren(spread);
            }
            for (const surface of fresh) this.installSurface(surface);
            for (const surface of old) this.dispose(surface);
          } else {
            const oldTop = this.pageTop(target);
            this.resizeSlots();
            if (!navigate) this.scroller!.scrollTop += this.pageTop(target) - oldTop;
            for (const surface of fresh) this.installSurface(surface);
          }
          fresh.length = 0;
          this.layoutDirty = false;
          this.layoutAnchor = undefined;
          this.neighborErrors.delete(target);
          this.scroller!.dataset.mode = mode;
          this.lastWidth = this.host?.clientWidth ?? 800;
          this.lastHeight = this.host?.clientHeight ?? 600;
          const active = this.surfaces.get(target)!;
          this.activate(active);
          if (navigate) {
            const requested = this.pageTop(target) + offset * active.anchorScale;
            const requestedTop = mode === 'continuous' || offset > 0 ? requested : 0;
            this.scroller!.scrollTop = Math.round(requestedTop);
            const actualTop = this.scroller!.scrollTop;
            this.restoredOffset =
              Math.abs(actualTop - requestedTop) <= 1
                ? { scrollTop: actualTop, value: offset }
                : undefined;
          }
          this.pendingNavigation = undefined;
          this.restoring = false;
          this.emitSelection(null);
          this.emit();
          this.checkAnnotationAnchors();
          if (mode !== 'continuous') return;
          const targets = this.continuousTargets(target);
          for (const [i, surface] of this.surfaces) {
            if (!targets.includes(i)) {
              this.surfaces.delete(i);
              this.dispose(surface);
              const label = document.createElement('span');
              label.className = 'pdf-page-placeholder';
              label.textContent = `Page ${i + 1}`;
              this.slots[i]!.replaceChildren(label);
            }
          }
          for (const i of targets) {
            if (this.dead || generation !== this.generation) return;
            if (this.surfaces.has(i) || this.pageStreamErrors.has(i) || this.neighborErrors.has(i))
              continue;
            try {
              const page = await pdf.getPage(i + 1);
              this.borrowedPages.add(page);
              if (this.dead || generation !== this.generation) return;
              this.dimensions.set(i, this.size(page));
              const surface = await this.paint(
                i,
                generation,
                this.layoutScale([this.dimensions.get(i)!]),
                page,
                mode,
              );
              if (!surface) return;
              const oldTop = this.pageTop(target);
              this.restoring = true;
              this.resizeSlots();
              this.scroller!.scrollTop += this.pageTop(target) - oldTop;
              this.installSurface(surface);
              this.restoring = false;
            } catch (error) {
              if (generation !== this.generation || this.dead) return;
              this.neighborErrors.add(i);
              const label = document.createElement('p');
              label.className = 'pdf-page-error';
              label.textContent = `Page ${i + 1} could not be rendered. ${String(error)}`;
              this.slots[i]!.replaceChildren(label);
            }
          }
        } finally {
          this.restoring = false;
          if (generation === this.generation) {
            this.scheduledIndex = undefined;
            this.pendingNavigation = undefined;
            this.layoutAnchor = undefined;
          }
          for (const surface of fresh) this.dispose(surface);
          for (const page of this.borrowedPages) {
            this.borrowedPages.delete(page);
            if (!this.retainsPage(page)) page.cleanup();
          }
        }
      });
    this.queue = result;
    return result;
  }
  private installSurface(surface: PageSurface): void {
    const previous = this.surfaces.get(surface.index);
    this.surfaces.set(surface.index, surface);
    if (previous) this.dispose(previous);
    if (this.mode === 'continuous') this.slots[surface.index]!.replaceChildren(surface.element);
    else this.scroller!.firstElementChild!.append(surface.element);
    void this.renderTextLayer(surface);
  }
  private async renderTextLayer(surface: PageSurface): Promise<void> {
    const ctor = this.textLayerCtor;
    if (!ctor) return;
    try {
      const viewport = surface.page.getViewport({
        scale: surface.scale,
        rotation: this.rotation(surface.page),
      });
      const container = document.createElement('div');
      container.className = 'textLayer';
      container.style.setProperty('--scale-factor', String(surface.scale));
      container.style.setProperty('--total-scale-factor', String(surface.scale));
      container.style.width = `${Math.floor(viewport.width)}px`;
      container.style.height = `${Math.floor(viewport.height)}px`;
      const layer = new ctor({
        textContentSource: surface.page.streamTextContent(),
        container,
        viewport,
      });
      surface.textLayer = layer;
      await layer.render();
      if (this.dead || this.surfaces.get(surface.index) !== surface) return;
      const highlightLayer = document.createElement('div');
      highlightLayer.className = 'pdf-highlight-layer';
      surface.element.append(container, highlightLayer);
      surface.text = container;
      surface.highlights = highlightLayer;
      this.drawHighlights();
    } catch {
      /* A missing text layer must not erase a painted page. */
    }
  }
  onSelection(callback: (selection: SelectionInfo | null) => void): () => void {
    this.selectionCallbacks.add(callback);
    return () => this.selectionCallbacks.delete(callback);
  }
  onContextMenu(): () => void {
    // The PDF text layer lives in the host document, so the reader shell's own
    // surface contextmenu/long-press handling already opens the menu over PDF.
    // There is nothing to forward from an iframe here.
    return () => {};
  }
  applyHighlights(highlights: readonly Highlight[]): void {
    this.highlights = highlights;
    this.drawHighlights();
  }
  setAnnotationAnchors(annotations: readonly AnnotationAnchor[]): void {
    this.annotationDiagnostics.setAnchors(annotations);
    this.checkAnnotationAnchors();
  }
  onAnnotationStatus(callback: (states: readonly AnnotationAnchorStatus[]) => void): () => void {
    return this.annotationDiagnostics.subscribe(callback);
  }
  private checkAnnotationAnchors(): void {
    const pdf = this.document;
    if (!pdf || this.dead) return;
    for (const annotation of this.annotationDiagnostics.anchors) {
      const position =
        annotation.locator.kind === 'pdf' ? parsePdfLocator(annotation.locator.value) : null;
      const range =
        annotation.kind === 'highlight' ? parsePdfHighlight(annotation.locator.value) : null;
      if (
        !position ||
        position.page >= pdf.numPages ||
        (annotation.kind === 'highlight' && !range)
      ) {
        this.annotationDiagnostics.report(
          annotation.id,
          'unresolved',
          'The saved page or highlight range is not present in this book. Your annotation is kept.',
        );
        continue;
      }
      const surface = this.surfaces.get(position.page);
      if (!surface) continue; // No eager page/text decoding.
      if (position.yOffset > surface.height) {
        this.annotationDiagnostics.report(
          annotation.id,
          'unresolved',
          'The saved position lies outside this page. Your annotation is kept.',
        );
        continue;
      }
      if (range) {
        const text = surface.text;
        if (!text) continue;
        if (!this.resolvePoint(text, range.start) || !this.resolvePoint(text, range.end)) {
          this.annotationDiagnostics.report(
            annotation.id,
            'unresolved',
            'The saved highlight text range could not be found on this page. Your annotation is kept.',
          );
          continue;
        }
      }
      this.annotationDiagnostics.report(annotation.id, 'resolved');
    }
  }
  private emitSelection(selection: SelectionInfo | null): void {
    for (const callback of this.selectionCallbacks) callback(selection);
  }
  private readonly onSelectionChange = (): void => {
    const selection = document.getSelection();
    const surface = [...this.surfaces.values()].find(
      (item) => selection?.anchorNode && item.text?.contains(selection.anchorNode),
    );
    const el = surface?.text;
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
    const pageRect = surface?.element.getBoundingClientRect();
    const first = range.getClientRects()[0];
    const yOffset =
      pageRect && first ? Math.max(0, (first.top - pageRect.top) / surface!.anchorScale) : 0;
    const pages = this.document?.numPages ?? 1;
    try {
      const locator = createPdfHighlightLocator(
        surface!.index,
        yOffset,
        start,
        end,
        surface!.index / pages,
      );
      this.emitSelection({ locator, excerpt: text.slice(0, 300) });
    } catch {
      this.emitSelection(null);
    }
  };
  // Two-pointer pinch over the reader surface changes the render zoom. The
  // live gesture only tracks pointers and updates `zoom`; a single re-raster
  // runs once the gesture settles (debounced, via schedule()'s queue), never
  // on every move — mirroring the resize debounce.
  private readonly onPointerDown = (event: PointerEvent): void => {
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (this.pointers.size === 2) {
      this.pinchStartDistance = this.pointerDistance();
      this.pinchStartZoom = this.zoom;
      if (this.scroller) this.scroller.style.touchAction = 'none';
    }
  };
  private readonly onPointerMove = (event: PointerEvent): void => {
    if (!this.pointers.has(event.pointerId)) return;
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (this.pointers.size !== 2 || this.pinchStartDistance === 0) return;
    event.preventDefault();
    const ratio = this.pointerDistance() / this.pinchStartDistance;
    // Live, GPU-cheap preview: scale the already-rendered sheet; no re-raster.
    this.liveZoom = clampZoom(this.pinchStartZoom * ratio) / this.zoom;
    this.applyLiveZoom();
  };
  private readonly onPointerUp = (event: PointerEvent): void => {
    if (!this.pointers.delete(event.pointerId)) return;
    if (this.pointers.size >= 2 || this.pinchStartDistance === 0) return;
    this.pinchStartDistance = 0;
    if (this.scroller) this.scroller.style.touchAction = '';
    this.scheduleZoomCommit();
  };
  // Trackpad pinch / ctrl+wheel: zoom the page content (not the browser). Like
  // Okular/pdf.js, the gesture only CSS-scales the current bitmap for instant,
  // smooth feedback; the crisp re-raster at the new resolution happens once,
  // after the gesture settles.
  private readonly onWheel = (event: WheelEvent): void => {
    if (!event.ctrlKey || this.dead || !this.document) return;
    event.preventDefault();
    const effective = clampZoom(this.zoom * this.liveZoom * Math.exp(-event.deltaY / 300));
    this.liveZoom = effective / this.zoom;
    this.applyLiveZoom();
    this.scheduleZoomCommit();
  };
  /** Scales the current page element in place (visual only) for the live gesture. */
  private applyLiveZoom(): void {
    const pageEl = this.pageEl;
    const scroller = this.scroller;
    if (!pageEl || !scroller) return;
    // Anchor the scale at the top of what's currently visible (in page coords),
    // which is exactly where the re-render restores the scroll. So the content
    // under the viewport top stays put during the gesture and the commit lands
    // in the same place — no jump/readjust when a tall page is scrolled.
    const originY = Math.max(0, scroller.scrollTop - pageEl.offsetTop);
    pageEl.style.transformOrigin = `50% ${originY}px`;
    pageEl.style.transform = this.liveZoom === 1 ? '' : `scale(${this.liveZoom})`;
  }
  private scheduleZoomCommit(): void {
    clearTimeout(this.pinchTimer);
    this.pinchTimer = setTimeout(() => this.commitZoom(), 160);
  }
  /**
   * Bakes the live zoom into `zoom` and re-rasters once at the new resolution.
   * The old (scaled) page stays visible until the fresh, crisp page swaps in via
   * replaceChildren, so the size is continuous and there is no blank flash.
   */
  private commitZoom(): void {
    if (this.dead || !this.document) return;
    const committed = clampZoom(this.zoom * this.liveZoom);
    this.liveZoom = 1;
    if (committed === this.zoom) {
      this.applyLiveZoom();
      return;
    }
    const pdfZoom = Math.min(400, Math.max(50, Math.round(this.settings.pdfZoom * committed)));
    this.zoom = 1;
    this.applySettings({ ...this.settings, pdfZoom });
    this.host?.dispatchEvent(new CustomEvent('reader-settings-change', { detail: { pdfZoom } }));
  }
  private pointerDistance(): number {
    const points = [...this.pointers.values()];
    const a = points[0];
    const b = points[1];
    if (!a || !b) return 0;
    return Math.hypot(a.x - b.x, a.y - b.y);
  }
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
    let node = walker.nextNode();
    while (node) {
      const length = node.nodeValue?.length ?? 0;
      if (seen + length >= target) return { node, offset: target - seen };
      seen += length;
      node = walker.nextNode();
    }
    return null;
  }
  private drawHighlights(): void {
    this.checkAnnotationAnchors();
    for (const surface of this.surfaces.values()) this.drawSurfaceHighlights(surface);
  }
  private drawSurfaceHighlights(surface: PageSurface): void {
    const el = surface.text;
    const layer = surface.highlights;
    const pageEl = surface.element;
    if (!el || !layer) return;
    layer.replaceChildren();
    const pageRect = pageEl.getBoundingClientRect();
    for (const highlight of this.highlights) {
      const anchor = parsePdfHighlight(highlight.locator.value);
      if (!anchor || anchor.page !== surface.index) continue;
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
  private report(error: unknown): void {
    this.host?.dispatchEvent(
      new CustomEvent('reader-message', {
        detail: `PDF rendering failed: ${String(friendlyPdfError(error))}`,
      }),
    );
  }
  private move(index: number, offset = 0): void {
    void this.schedule(index, offset).catch((error: unknown) => this.report(error));
  }
  goTo(locator: Locator): void {
    assertLocator(locator);
    const position = locator.kind === 'pdf' ? parsePdfLocator(locator.value) : null;
    if (position) this.move(position.page, position.yOffset);
  }
  prev(): void {
    const group =
      this.mode === 'double'
        ? pdfSpread(this.index, this.document?.numPages ?? 0, this.settings.pdfCoverAlone)
        : [this.index];
    if (group[0]! > 0) this.move(group[0]! - 1);
  }
  next(): void {
    const pdf = this.document;
    const group =
      this.mode === 'double'
        ? pdfSpread(this.index, pdf?.numPages ?? 0, this.settings.pdfCoverAlone)
        : [this.index];
    if (pdf !== undefined && group.at(-1)! < pdf.numPages - 1) this.move(group.at(-1)! + 1);
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
  listPages(): Promise<ReaderPage[]> {
    const pdf = this.document;
    if (pdf === undefined || this.dead) return Promise.resolve([]);
    const total = pdf.numPages;
    const pages: ReaderPage[] = [];
    for (let index = 0; index < total; index += 1) {
      pages.push({
        index,
        label: String(index + 1),
        locator: createPdfLocator(index, 0, total > 0 ? index / total : 0),
      });
    }
    return Promise.resolve(pages);
  }
  renderThumbnail(index: number, maxEdgePx: number): Promise<string | null> {
    const result = this.thumbnailQueue
      .catch(() => {})
      .then(() => this.createThumbnail(index, maxEdgePx));
    this.thumbnailQueue = result.then(() => {});
    return result;
  }
  private async createThumbnail(index: number, maxEdgePx: number): Promise<string | null> {
    const pdf = this.document;
    if (
      !pdf ||
      this.dead ||
      this.pageStreamErrors.has(index) ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= pdf.numPages ||
      !Number.isFinite(maxEdgePx) ||
      maxEdgePx <= 0
    )
      return null;
    if (typeof document === 'undefined') return null;
    const canvas = document.createElement('canvas');
    if (typeof canvas.getContext !== 'function' || typeof canvas.toBlob !== 'function') return null;
    let page: PDFPageProxy | undefined;
    let task: RenderTask | undefined;
    try {
      page = await pdf.getPage(index + 1);
      if (this.dead) return null;
      const natural = page.getViewport({ scale: 1 });
      if (
        !Number.isFinite(natural.width * natural.height) ||
        natural.width <= 0 ||
        natural.height <= 0
      )
        return null;
      const scale = Math.min(
        Math.min(maxEdgePx, PDF_MAX_CANVAS_EDGE) / Math.max(natural.width, natural.height),
        Math.sqrt(PDF_THUMBNAIL_MAX_PIXELS / (natural.width * natural.height)),
      );
      const viewport = page.getViewport({ scale });
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      task = page.render({ canvas, viewport });
      this.thumbnailTasks.add(task);
      await task.promise;
      if (this.dead || this.pageStreamErrors.has(index)) return null;
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/jpeg', 0.72),
      );
      return this.dead || blob === null ? null : URL.createObjectURL(blob);
    } catch {
      return null;
    } finally {
      if (task) this.thumbnailTasks.delete(task);
      canvas.width = 0;
      canvas.height = 0;
      if (page && !this.retainsPage(page)) {
        try {
          page.cleanup();
        } catch {
          /* Document teardown already disposed it. */
        }
      }
    }
  }
  private retainsPage(page: PDFPageProxy): boolean {
    return (
      page === this.pendingPage ||
      this.borrowedPages.has(page) ||
      [...this.surfaces.values()].some((surface) => surface.page === page)
    );
  }
  async getVisibleText(): Promise<string> {
    const pdf = this.document;
    if (!pdf || this.dead) return '';
    // The page actually painted on screen, falling back to the pending target
    // before the first paint completes.
    const index = this.renderedIndex ?? this.index;
    if (index < 0 || index >= pdf.numPages) return '';
    try {
      const page = await pdf.getPage(index + 1);
      try {
        const content = await page.getTextContent();
        // Join runs with spaces and collapse, exactly like search(), so a word
        // split across text runs or line breaks reads as one word aloud.
        return content.items
          .map((item) => ('str' in item ? item.str : ''))
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
      } finally {
        if (!this.retainsPage(page)) page.cleanup();
      }
    } catch {
      return '';
    }
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
          if (!this.retainsPage(page)) page.cleanup();
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
    const next = normalizeReaderSettings(settings);
    const renderChanged = [
      'mode',
      'marginPx',
      'pdfFit',
      'pdfZoom',
      'pdfRotation',
      'pdfCoverAlone',
      'pdfDirection',
      'pdfInvert',
    ].some(
      (key) => this.settings[key as keyof ReaderSettings] !== next[key as keyof ReaderSettings],
    );
    if (next.pdfRotation !== this.settings.pdfRotation) this.dimensions.clear();
    if (next.pdfZoom !== this.settings.pdfZoom || next.pdfFit !== this.settings.pdfFit)
      this.zoom = 1;
    this.settings = next;
    if (this.scroller) {
      this.scroller.style.background = { light: '#8b9096', sepia: '#b9a888', dark: '#15171a' }[
        next.theme
      ];
    }
    if (this.document && renderChanged) {
      this.layoutAnchor ??= this.pendingNavigation ?? {
        index: this.renderedIndex ?? this.index,
        offset,
      };
      this.layoutDirty = true;
      this.move(this.layoutAnchor.index, this.layoutAnchor.offset);
    }
  }
  private releasePage(): void {
    const old = [...this.surfaces.values()];
    this.surfaces.clear();
    for (const surface of old) this.dispose(surface);
    this.canvas = undefined;
    this.renderedIndex = undefined;
    this.restoredOffset = undefined;
    this.slots = [];
    this.flow = undefined;
  }
  destroy(): void {
    if (this.dead) return;
    this.dead = true;
    this.pageStreamErrors.clear();
    this.annotationDiagnostics.clear();
    this.generation++;
    this.task?.cancel();
    for (const surface of this.surfaces.values()) surface.textLayer?.cancel?.();
    cancelAnimationFrame(this.scrollFrame);
    for (const task of this.thumbnailTasks) task.cancel();
    this.resize?.disconnect();
    clearTimeout(this.resizeTimer);
    clearTimeout(this.pinchTimer);
    this.host?.removeEventListener('pointerdown', this.onPointerDown);
    this.host?.removeEventListener('pointermove', this.onPointerMove);
    this.host?.removeEventListener('pointerup', this.onPointerUp);
    this.host?.removeEventListener('pointercancel', this.onPointerUp);
    this.host?.removeEventListener('wheel', this.onWheel);
    this.pointers.clear();
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
      })
      .catch(() => {
        /* Document may already have failed or been destroyed. */
      });
    this.callbacks.clear();
  }
}

/** Clamps the pinch zoom factor to the supported range. */
function clampZoom(zoom: number): number {
  return Math.min(PDF_MAX_ZOOM, Math.max(PDF_MIN_ZOOM, zoom));
}

/** A short snippet of surrounding text with the match roughly centered. */
function buildExcerpt(text: string, at: number, length: number): string {
  const radius = 40;
  const start = Math.max(0, at - radius);
  const end = Math.min(text.length, at + length + radius);
  const snippet = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${snippet}${end < text.length ? '…' : ''}`;
}
