import { unzipSync, strFromU8 } from 'fflate';
import { assertLocator, createCfiLocator, type Locator } from '~/domain/locator';
import {
  DEFAULT_READER_SETTINGS,
  type Highlight,
  type ReaderSettings,
  type Renderer,
  type SearchHit,
  type SelectionInfo,
  type TocItem,
} from './renderer';

type OverlayerDraw = (rects: unknown, options?: Record<string, unknown>) => Element;
interface OverlayerModule {
  Overlayer: { highlight: OverlayerDraw };
}

/** Overlay colour tokens map to concrete CSS colours; the overlay opacity is low. */
const HIGHLIGHT_COLORS: Record<string, string> = {
  yellow: '#f6c744',
  green: '#5bd08a',
  blue: '#5aa9f6',
  pink: '#f67ab5',
};

interface EpubBook {
  transformTarget: EventTarget;
  toc?: { label: string; href?: string | null; subitems?: EpubBook['toc'] }[];
  sections: { cfi?: string; createDocument(): Promise<Document> }[];
  destroy(): void;
}

interface FoliateView extends HTMLElement {
  isFixedLayout?: boolean;
  book: EpubBook;
  renderer: {
    setStyles?(css: string): void;
    setAttribute(name: string, value: string): void;
    goTo(target: { index: number; anchor?: unknown }): Promise<void>;
    getContents(): { index: number; doc?: Document; overlayer?: unknown }[];
    addEventListener(type: string, listener: (event: Event) => void): void;
  };
  open(book: EpubBook): Promise<void>;
  close(): void;
  resolveNavigation(value: string): { index: number; anchor?: unknown } | undefined;
  goTo(value: string | number): Promise<unknown>;
  goToFraction(fraction: number): Promise<void>;
  getCFI(index: number, range?: Range): string;
  prev(): Promise<void>;
  next(): Promise<void>;
  search(opts: { query: string; index?: number }): AsyncIterable<FoliateSearchResult>;
  clearSearch(): void;
  addAnnotation(annotation: { value: string; color?: string }): Promise<unknown>;
  deleteAnnotation(annotation: { value: string }): Promise<unknown>;
}

type FoliateSearchExcerpt = { pre: string; match: string; post: string };

type FoliateSearchResult =
  | 'done'
  | { progress: number }
  | { label: string; subitems: ReadonlyArray<{ cfi: string; excerpt: FoliateSearchExcerpt }> };

// Native upstream modules are deliberately not bundled or imported by higher layers.
const upstream = async (name: string): Promise<Record<string, unknown>> =>
  import(/* @vite-ignore */ `${import.meta.env.BASE_URL}foliate-js/${name}.js`);

export const BOOK_CSP =
  "default-src 'none'; script-src 'none'; object-src 'none'; base-uri 'none'; img-src blob: data:; font-src blob: data:; style-src blob: 'unsafe-inline'; frame-src 'none'; connect-src 'none'; form-action 'none'";

/** Called before foliate creates any resource URL, never after iframe load. */
export function secureBookDocument(data: string, type: string): string {
  const mime =
    type === 'text/html'
      ? 'text/html'
      : type === 'image/svg+xml'
        ? 'image/svg+xml'
        : 'application/xhtml+xml';
  const doc = new DOMParser().parseFromString(data, mime);
  if (doc.querySelector('parsererror')) throw new Error('Malformed book document.');
  // SVG scripting is blocked by inherited CSP; remove active elements as well.
  if (mime === 'image/svg+xml') {
    doc.querySelectorAll('script, foreignObject').forEach((element) => element.remove());
  } else {
    const head = doc.querySelector('head');
    if (!head) throw new Error('Book document has no head.');
    const meta = doc.createElementNS('http://www.w3.org/1999/xhtml', 'meta');
    meta.setAttribute('http-equiv', 'Content-Security-Policy');
    meta.setAttribute('content', BOOK_CSP);
    head.prepend(meta);
    doc
      .querySelectorAll('base, iframe, object, embed, meta[http-equiv="refresh" i]')
      .forEach((element) => element.remove());
  }
  return new XMLSerializer().serializeToString(doc);
}

/**
 * Flattens foliate's `{ pre, match, post }` excerpt into one string. Foliate
 * returns the three parts so a caller can style the match; the reader shell
 * renders a single text run, so they are concatenated and whitespace-collapsed.
 */
function flattenExcerpt(excerpt: FoliateSearchExcerpt): string {
  return `${excerpt.pre}${excerpt.match}${excerpt.post}`.replace(/\s+/g, ' ').trim();
}

export class EpubRenderer implements Renderer {
  constructor(private readonly loadModule = upstream) {}
  private host?: HTMLElement;
  private view?: FoliateView;
  private book?: EpubBook;
  private dead = false;
  private settings = DEFAULT_READER_SETTINGS;
  private opening?: Promise<void>;
  private tasks = new Set<Promise<unknown>>();
  private closedRenderers = new WeakSet<object>();
  private toc?: Promise<TocItem[]>;
  private searchToken = 0;
  private callbacks = new Set<(locator: Locator, fraction: number) => void>();
  readonly supportsHighlights = true;
  private overlayerModule?: OverlayerModule;
  private highlights: readonly Highlight[] = [];
  private currentFraction = 0;
  private readonly selectionCallbacks = new Set<(selection: SelectionInfo | null) => void>();
  private readonly selectionDocs = new WeakSet<Document>();
  private readonly relocate = (event: Event) => {
    const { cfi, fraction } = (event as CustomEvent<{ cfi: string; fraction: number }>).detail;
    const locator = createCfiLocator(cfi, fraction);
    this.currentFraction = locator.fraction;
    for (const callback of this.callbacks) callback(locator, locator.fraction);
  };

  // A new overlay is created when a section renders; the overlayer is attached
  // right after this event, so re-draw highlights and wire selection on the
  // next microtask when getContents() can see them.
  private readonly handleCreateOverlay = (event: Event) => {
    const { index } = (event as CustomEvent<{ index: number }>).detail;
    queueMicrotask(() => {
      this.reapplyHighlights();
      const doc = this.view?.renderer.getContents().find((c) => c.index === index)?.doc;
      if (doc) this.attachSelection(doc, index);
    });
  };

  private readonly handleDrawAnnotation = (event: Event) => {
    const detail = (
      event as CustomEvent<{
        draw: (func: OverlayerDraw, options: Record<string, unknown>) => void;
        annotation: { color?: string };
      }>
    ).detail;
    const highlight = this.overlayerModule?.Overlayer.highlight;
    if (!highlight) return;
    const color = HIGHLIGHT_COLORS[detail.annotation.color ?? ''] ?? HIGHLIGHT_COLORS.yellow;
    detail.draw(highlight, { color });
  };

  mount(host: HTMLElement): void {
    this.host = host;
  }

  open(file: Blob, startAt?: Locator): Promise<void> {
    if (this.opening)
      return Promise.reject(new Error('Create a new reader session to open another book.'));
    this.opening = this.openBook(file, startAt);
    return this.opening;
  }

  private async openBook(file: Blob, startAt?: Locator): Promise<void> {
    if (!this.host || this.dead) throw new Error('Reader is not mounted.');
    const [{ EPUB }, , overlayerModule] = await Promise.all([
      this.loadModule('epub'),
      this.loadModule('view'),
      this.loadModule('overlayer'),
    ]);
    this.overlayerModule = overlayerModule as unknown as OverlayerModule;
    if (this.dead) return;
    // A bounded archive loader avoids upstream's ZIP worker/WASM dependencies.
    if (file.size > 256 * 1024 * 1024) throw new Error('EPUB exceeds the 256 MiB reader limit.');
    let expanded = 0;
    const files = unzipSync(new Uint8Array(await file.arrayBuffer()), {
      filter: (entry) => {
        expanded += entry.originalSize;
        if (entry.originalSize > 64 * 1024 * 1024 || expanded > 256 * 1024 * 1024)
          throw new Error('EPUB expanded content exceeds reader limits.');
        return true;
      },
    });
    const loader = {
      loadText: (name: string) => (files[name] ? strFromU8(files[name]) : null),
      loadBlob: (name: string, type: string) =>
        files[name] ? new Blob([new Uint8Array(files[name])], { type }) : null,
      getSize: (name: string) => files[name]?.length ?? 0,
    };
    type ArchiveLoader = typeof loader;
    const Constructor = EPUB as new (loader: ArchiveLoader) => { init(): Promise<EpubBook> };
    const book = await new Constructor(loader).init();
    if (this.dead) {
      book.destroy();
      return;
    }
    this.book = book;
    book.transformTarget.addEventListener('data', (event) => {
      const detail = (event as CustomEvent<{ data: string | Promise<string>; type: string }>)
        .detail;
      if (['application/xhtml+xml', 'text/html', 'image/svg+xml'].includes(detail.type)) {
        detail.data = Promise.resolve(detail.data).then((data) =>
          secureBookDocument(data, detail.type),
        );
      }
    });
    const view = document.createElement('foliate-view') as FoliateView;
    this.view = view;
    view.style.cssText = 'display:block;width:100%;height:100%';
    view.addEventListener('relocate', this.relocate);
    view.addEventListener('draw-annotation', this.handleDrawAnnotation);
    view.addEventListener('create-overlay', this.handleCreateOverlay);
    this.host.append(view);
    try {
      await view.open(book);
      if (this.dead) {
        this.closeView(view);
        return;
      }
      this.applySettings(this.settings);
      if (view.isFixedLayout)
        this.host.dispatchEvent(
          new CustomEvent('reader-message', {
            detail:
              'Fixed-layout EPUB preserves publisher typography. Font size, line height and margins do not reflow its pages; theme changes the reader backdrop.',
          }),
        );
      if (startAt) await this.restore(startAt);
      else await view.goTo(0);
    } catch (error) {
      this.destroy();
      throw error;
    }
  }

  private async restore(locator: Locator): Promise<void> {
    assertLocator(locator);
    const view = this.view!;
    try {
      const target = locator.kind === 'cfi' ? view.resolveNavigation(locator.value) : undefined;
      if (!target || target.index < 0 || target.index >= view.book.sections.length)
        throw new Error('Unresolved CFI');
      // Low-level goTo propagates errors; high-level upstream goTo swallows them.
      // Package-only CFIs identify a spine item, not a range in its document.
      // Upstream resolveCFI creates a range resolver even when no `!` path
      // exists; explicitly start the section instead of falling back by fraction.
      await view.renderer.goTo(
        locator.value.includes('!') ? target : { index: target.index, anchor: 0 },
      );
    } catch {
      await view.goToFraction(locator.fraction);
      this.host?.dispatchEvent(
        new CustomEvent('reader-message', {
          detail: 'Position restored approximately from percentage.',
        }),
      );
    }
  }

  private run(action: Promise<unknown>): void {
    this.tasks.add(action);
    void action
      .catch((error: unknown) => {
        if (!this.dead)
          this.host?.dispatchEvent(new CustomEvent('reader-message', { detail: String(error) }));
      })
      .finally(() => this.tasks.delete(action));
  }
  goTo(locator: Locator): void {
    if (this.view && !this.dead) this.run(this.restore(locator));
  }
  prev(): void {
    if (this.view && !this.dead) this.run(this.view.prev());
  }
  next(): void {
    if (this.view && !this.dead) this.run(this.view.next());
  }

  async getToc(): Promise<TocItem[]> {
    const view = this.view;
    if (!view || this.dead) return [];
    this.toc ??= this.readToc(view);
    return this.toc;
  }

  private async readToc(view: FoliateView): Promise<TocItem[]> {
    // Convert sequentially and retain at most one parsed section. A large TOC
    // must not eagerly parse every chapter or retain Documents in UI state.
    let parsed: { index: number; doc: Document } | undefined;
    const convert = async (items: NonNullable<EpubBook['toc']>): Promise<TocItem[]> => {
      const result: TocItem[] = [];
      for (const item of items) {
        if (this.dead) return [];
        const target = item.href ? view.resolveNavigation(item.href) : undefined;
        let locator: Locator | undefined;
        if (
          item.href &&
          target &&
          Number.isInteger(target.index) &&
          target.index >= 0 &&
          target.index < view.book.sections.length
        ) {
          let range: Range | undefined;
          let resolved = !item.href.includes('#') || item.href.endsWith('#');
          if (!resolved && typeof target.anchor === 'function') {
            if (parsed?.index !== target.index)
              parsed = {
                index: target.index,
                doc: await view.book.sections[target.index]!.createDocument(),
              };
            if (this.dead) return [];
            const anchor = (target.anchor as (doc: Document) => unknown)(parsed.doc);
            if (anchor instanceof Range) {
              range = anchor;
              resolved = true;
            } else if (anchor instanceof Element) {
              range = parsed.doc.createRange();
              range.selectNodeContents(anchor);
              range.collapse(true);
              resolved = true;
            }
          }
          if (resolved)
            locator = createCfiLocator(
              view.getCFI(target.index, range),
              target.index / view.book.sections.length,
            );
        }
        result.push({
          label: item.label,
          locator,
          children: item.subitems ? await convert(item.subitems) : undefined,
        });
      }
      return result;
    };
    return convert(view.book.toc ?? []);
  }
  onRelocate(callback: (locator: Locator, fraction: number) => void): () => void {
    this.callbacks.add(callback);
    return () => this.callbacks.delete(callback);
  }
  onSelection(callback: (selection: SelectionInfo | null) => void): () => void {
    this.selectionCallbacks.add(callback);
    return () => this.selectionCallbacks.delete(callback);
  }
  applyHighlights(highlights: readonly Highlight[]): void {
    const previous = this.highlights;
    this.highlights = highlights;
    const view = this.view;
    if (!view) return;
    const next = new Set(highlights.map((item) => item.locator.value));
    for (const stale of previous) {
      if (!next.has(stale.locator.value)) {
        void view.deleteAnnotation({ value: stale.locator.value }).catch(() => {});
      }
    }
    this.reapplyHighlights();
  }
  private reapplyHighlights(): void {
    const view = this.view;
    if (!view) return;
    for (const highlight of this.highlights) {
      // addAnnotation only draws where the target section is live; it removes
      // any same-value overlay first, so re-applying on each section load is
      // idempotent rather than duplicating overlays.
      void view
        .addAnnotation({ value: highlight.locator.value, color: highlight.color })
        .catch(() => {});
    }
  }
  private attachSelection(doc: Document, index: number): void {
    if (this.selectionDocs.has(doc)) return;
    this.selectionDocs.add(doc);
    doc.addEventListener('selectionchange', () => {
      const selection = doc.getSelection();
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        this.emitSelection(null);
        return;
      }
      const text = selection.toString().replace(/\s+/g, ' ').trim();
      if (text.length === 0) {
        this.emitSelection(null);
        return;
      }
      let locator: Locator;
      try {
        locator = createCfiLocator(
          this.view!.getCFI(index, selection.getRangeAt(0)),
          this.currentFraction,
        );
      } catch {
        // A selection whose CFI is unusable (e.g. past the length cap) cannot
        // be anchored; treat it as no selectable target.
        this.emitSelection(null);
        return;
      }
      this.emitSelection({ locator, excerpt: text.slice(0, 300) });
    });
  }
  private emitSelection(selection: SelectionInfo | null): void {
    for (const callback of this.selectionCallbacks) callback(selection);
  }
  async *search(query: string, signal?: AbortSignal): AsyncGenerator<SearchHit> {
    const view = this.view;
    const trimmed = query.trim();
    if (!view || this.dead || trimmed.length === 0) return;
    // A newer search preempts this one: it owns the token, so this generator
    // stops iterating and its finally must not clear the newer highlights.
    const token = ++this.searchToken;
    // The CFI anchors navigation; section progress is a best-effort fraction
    // fallback, updated as foliate reports it per section.
    let progress = 0;
    try {
      for await (const result of view.search({ query: trimmed })) {
        if (this.dead || signal?.aborted || token !== this.searchToken) break;
        if (result === 'done') break;
        if ('progress' in result) {
          progress = result.progress;
          continue;
        }
        for (const hit of result.subitems) {
          if (this.dead || signal?.aborted || token !== this.searchToken) break;
          let locator;
          try {
            locator = createCfiLocator(hit.cfi, progress);
          } catch {
            // A pathological hit — e.g. a range CFI past the locator length
            // cap — cannot be navigated to anyway. Skip it rather than let one
            // bad hit abort the whole search and drop every later match.
            continue;
          }
          yield {
            locator,
            excerpt: flattenExcerpt(hit.excerpt),
          };
        }
      }
    } finally {
      // Only the current search clears the view, so a superseded search cannot
      // wipe the overlay highlights a newer one just drew.
      if (token === this.searchToken) {
        try {
          view.clearSearch();
        } catch {
          // The view may already be torn down; nothing to clear.
        }
      }
    }
  }
  applySettings(settings: ReaderSettings): void {
    this.settings = settings;
    const colors = {
      light: ['#fff', '#171717'],
      sepia: ['#f4ecd8', '#403421'],
      dark: ['#191919', '#eee'],
    }[settings.theme];
    if (this.view) this.view.style.background = colors[0]!;
    if (this.view?.isFixedLayout) return;
    this.view?.renderer?.setStyles?.(
      `html { color-scheme: ${settings.theme === 'dark' ? 'dark' : 'light'}; background: ${colors[0]} !important; color: ${colors[1]} !important; } body { font-size: ${settings.fontSizePx}px !important; line-height: ${settings.lineHeight} !important; }`,
    );
    const gapPercent = (200 * settings.marginPx) / Math.max(200, this.host?.clientWidth ?? 800);
    this.view?.renderer?.setAttribute('gap', `${gapPercent}%`);
    this.view?.renderer?.setAttribute('margin', `${settings.marginPx}px`);
  }
  destroy(): void {
    if (this.dead) return;
    this.dead = true;
    this.selectionCallbacks.clear();
    this.view?.removeEventListener('relocate', this.relocate);
    this.view?.removeEventListener('draw-annotation', this.handleDrawAnnotation);
    this.view?.removeEventListener('create-overlay', this.handleCreateOverlay);
    if (this.view) this.closeView(this.view);
    this.view?.remove();
    const view = this.view;
    const book = this.book;
    // Upstream navigation is asynchronous and not abortable. Revoke resources
    // again when pending loads settle, so a late URL cannot escape cleanup.
    if (this.tasks.size || this.opening) {
      void Promise.allSettled([...(this.opening ? [this.opening] : []), ...this.tasks]).then(() => {
        if (view) this.closeView(view);
        book?.destroy();
        this.view = undefined;
        this.book = undefined;
        this.tasks.clear();
      });
    }
    book?.destroy();
    this.callbacks.clear();
    this.toc = undefined;
  }

  private closeView(view: FoliateView): void {
    if (!view.renderer || this.closedRenderers.has(view.renderer)) return;
    this.closedRenderers.add(view.renderer);
    view.close();
  }
}
