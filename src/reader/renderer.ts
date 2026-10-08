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
  open(file: Blob, startAt?: Locator): Promise<void>;
  goTo(locator: Locator): void;
  getToc(): Promise<TocItem[]>;
  onRelocate(callback: (locator: Locator, fraction: number) => void): Unsubscribe;
  search(query: string, signal?: AbortSignal): AsyncIterable<SearchHit>;
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
 * No adapter is registered yet: EPUB and PDF rendering is the next milestone,
 * and the registry exists so the reader shell can be written against a stable
 * contract before any engine is chosen. `resolve` returning null is an
 * expected state that the UI renders as "reading not available yet".
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
