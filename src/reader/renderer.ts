import type { BookFormat, RenderSupport } from '~/domain/enums';
import type { Locator } from '~/domain/locator';

export interface TocItem {
  readonly id?: string;
  readonly label: string;
  readonly locator?: Locator;
  readonly children?: readonly TocItem[];
}

export interface SearchHit {
  readonly locator: Locator;
  readonly excerpt: string;
}

/** A persisted highlight to (re)draw as an overlay over its anchored range. */
export interface Highlight {
  readonly id: string;
  readonly locator: Locator;
  /** Colour token, e.g. "yellow"; the renderer maps it to an overlay colour. */
  readonly color?: string;
}

/** A live text selection the user could turn into a highlight. */
export interface SelectionInfo {
  /** Anchor for the selected range (a range CFI for EPUB). */
  readonly locator: Locator;
  /** The selected text, trimmed; empty-selection events are not emitted. */
  readonly excerpt: string;
}

export type ReaderTheme = 'light' | 'sepia' | 'dark';

export interface ReaderSettings {
  readonly fontSizePx: number;
  readonly lineHeight: number;
  readonly marginPx: number;
  readonly theme: ReaderTheme;
}

export const DEFAULT_READER_SETTINGS: ReaderSettings = {
  fontSizePx: 18,
  lineHeight: 1.6,
  marginPx: 24,
  theme: 'light',
};

export type Unsubscribe = () => void;

/**
 * The only surface the reader shell is allowed to depend on.
 *
 * Every format engine (foliate-js, pdf.js) is wrapped by an implementation of
 * this interface, so engine-specific APIs, locator formats and lifecycle
 * quirks stay inside adapters. See docs/ARCHITECTURE.md §4.
 */
export interface Renderer {
  mount(host: HTMLElement): void;
  open(file: Blob, startAt?: Locator): Promise<void>;
  prev(): void;
  next(): void;
  goTo(locator: Locator): void;
  getToc(): Promise<TocItem[]>;
  onRelocate(callback: (locator: Locator, fraction: number) => void): Unsubscribe;
  search(query: string, signal?: AbortSignal): AsyncIterable<SearchHit>;
  /** True when this engine can capture selections and draw highlight overlays. */
  readonly supportsHighlights: boolean;
  /** Notifies with the current selection, or null when it is cleared. */
  onSelection(callback: (selection: SelectionInfo | null) => void): Unsubscribe;
  /** Draws the given highlights, replacing any previously drawn set. */
  applyHighlights(highlights: readonly Highlight[]): void;
  applySettings(settings: ReaderSettings): void;
  destroy(): void;
}

export interface RendererFactory {
  readonly format: BookFormat;
  readonly support: RenderSupport;
  /** Short label for diagnostics, e.g. "foliate-js 1.x". */
  readonly engine: string;
  create(): Renderer;
}

/**
 * Maps formats to renderer adapters.
 *
 * Only verified adapters are registered. Missing formats remain unavailable.
 */
export class RendererRegistry {
  private readonly factories = new Map<BookFormat, RendererFactory>();

  register(factory: RendererFactory): void {
    this.factories.set(factory.format, factory);
  }

  resolve(format: BookFormat): RendererFactory | null {
    return this.factories.get(format) ?? null;
  }

  list(): RendererFactory[] {
    return [...this.factories.values()].sort((left, right) =>
      left.format.localeCompare(right.format),
    );
  }

  has(format: BookFormat): boolean {
    return this.factories.has(format);
  }
}

export function createRendererRegistry(
  factories: readonly RendererFactory[] = [],
): RendererRegistry {
  const registry = new RendererRegistry();
  for (const factory of factories) {
    registry.register(factory);
  }
  return registry;
}
