import { unzipSync, strFromU8 } from 'fflate';
import { assertLocator, createCfiLocator, type Locator } from '~/domain/locator';
import {
  DEFAULT_READER_SETTINGS,
  type ReaderSettings,
  type Renderer,
  type SearchHit,
  type TocItem,
} from './renderer';

interface EpubBook {
  transformTarget: EventTarget;
  toc?: { label: string; href: string; subitems?: EpubBook['toc'] }[];
  sections: { cfi?: string; createDocument(): Promise<Document> }[];
  destroy(): void;
}

interface FoliateView extends HTMLElement {
  book: EpubBook;
  renderer: {
    setStyles?(css: string): void;
    setAttribute(name: string, value: string): void;
    goTo(target: { index: number; anchor?: unknown }): Promise<void>;
  };
  open(book: EpubBook): Promise<void>;
  close(): void;
  resolveNavigation(value: string): { index: number; anchor?: unknown } | undefined;
  goTo(value: string | number): Promise<unknown>;
  goToFraction(fraction: number): Promise<void>;
  getCFI(index: number, range?: Range): string;
  prev(): Promise<void>;
  next(): Promise<void>;
}

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
  private callbacks = new Set<(locator: Locator, fraction: number) => void>();
  private readonly relocate = (event: Event) => {
    const { cfi, fraction } = (event as CustomEvent<{ cfi: string; fraction: number }>).detail;
    const locator = createCfiLocator(cfi, fraction);
    for (const callback of this.callbacks) callback(locator, locator.fraction);
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
    const [{ EPUB }] = await Promise.all([this.loadModule('epub'), this.loadModule('view')]);
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
    this.host.append(view);
    try {
      await view.open(book);
      if (this.dead) {
        this.closeView(view);
        return;
      }
      this.applySettings(this.settings);
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
      await view.renderer.goTo(target);
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
    if (!view) return [];
    const convert = (items: NonNullable<EpubBook['toc']>): Promise<TocItem[]> =>
      Promise.all(
        items.map(async (item) => {
          const target = view.resolveNavigation(item.href);
          let locator: Locator | undefined;
          if (target) {
            const doc = await view.book.sections[target.index]!.createDocument();
            const anchor =
              typeof target.anchor === 'function'
                ? (target.anchor as (doc: Document) => unknown)(doc)
                : undefined;
            let range: Range | undefined;
            if (anchor instanceof Range) range = anchor;
            else if (anchor instanceof Element) {
              range = doc.createRange();
              range.selectNodeContents(anchor);
              range.collapse(true);
            }
            locator = createCfiLocator(
              view.getCFI(target.index, range),
              target.index / view.book.sections.length,
            );
          }
          return {
            label: item.label,
            locator,
            children: item.subitems ? await convert(item.subitems) : undefined,
          };
        }),
      );
    return convert(view.book.toc ?? []);
  }
  onRelocate(callback: (locator: Locator, fraction: number) => void): () => void {
    this.callbacks.add(callback);
    return () => this.callbacks.delete(callback);
  }
  search(_query: string, _signal?: AbortSignal): AsyncIterable<SearchHit> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          throw new Error('In-book search is not implemented.');
        },
      }),
    };
  }
  applySettings(settings: ReaderSettings): void {
    this.settings = settings;
    const colors = {
      light: ['#fff', '#171717'],
      sepia: ['#f4ecd8', '#403421'],
      dark: ['#191919', '#eee'],
    }[settings.theme];
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
    this.view?.removeEventListener('relocate', this.relocate);
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
  }

  private closeView(view: FoliateView): void {
    if (!view.renderer || this.closedRenderers.has(view.renderer)) return;
    this.closedRenderers.add(view.renderer);
    view.close();
  }
}
