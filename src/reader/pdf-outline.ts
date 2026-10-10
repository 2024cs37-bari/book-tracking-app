import { createPdfLocator, type Locator } from '~/domain/locator';
import type { TocItem } from './renderer';

/**
 * The slice of a pdf.js document the outline converter needs. Declaring it
 * here keeps the conversion logic dependency-free and unit-testable without a
 * real PDF, a worker or a canvas.
 */
export interface PdfOutlineSource {
  readonly numPages: number;
  getOutline(): Promise<readonly PdfOutlineNode[] | null>;
  /** Resolves a named destination to an explicit destination array. */
  getDestination(id: string): Promise<unknown[] | null>;
  /** Zero-based page index for a page reference object. */
  getPageIndex(ref: object): Promise<number>;
}

export interface PdfOutlineNode {
  readonly title?: string;
  /** Explicit destination array, a named-destination string, or null. */
  readonly dest?: string | unknown[] | null;
  readonly items?: readonly PdfOutlineNode[];
}

/**
 * Builds a reader TOC from a PDF outline.
 *
 * Entries whose destination cannot be resolved to a page keep their label but
 * carry no locator, so the UI shows them disabled rather than dropping them —
 * the structure stays intact even when a target is broken.
 */
export async function buildPdfToc(source: PdfOutlineSource): Promise<TocItem[]> {
  let outline: readonly PdfOutlineNode[] | null;
  try {
    outline = await source.getOutline();
  } catch {
    return [];
  }
  if (outline === null || outline.length === 0) return [];
  return convert(source, outline);
}

async function convert(
  source: PdfOutlineSource,
  nodes: readonly PdfOutlineNode[],
): Promise<TocItem[]> {
  const items: TocItem[] = [];
  for (const node of nodes) {
    const label = node.title?.trim();
    const locator = await resolveLocator(source, node.dest);
    const children =
      node.items !== undefined && node.items.length > 0
        ? await convert(source, node.items)
        : undefined;
    items.push({
      label: label !== undefined && label.length > 0 ? label : 'Untitled section',
      locator,
      children,
    });
  }
  return items;
}

async function resolveLocator(
  source: PdfOutlineSource,
  dest: string | unknown[] | null | undefined,
): Promise<Locator | undefined> {
  if (dest === null || dest === undefined) return undefined;
  try {
    const explicit = typeof dest === 'string' ? await source.getDestination(dest) : dest;
    if (!Array.isArray(explicit) || explicit.length === 0) return undefined;
    const ref = explicit[0];
    if (ref === null || typeof ref !== 'object') return undefined;
    const pageIndex = await source.getPageIndex(ref);
    if (!Number.isInteger(pageIndex) || pageIndex < 0) return undefined;
    const fraction = source.numPages > 0 ? pageIndex / source.numPages : 0;
    return createPdfLocator(pageIndex, 0, fraction);
  } catch {
    return undefined;
  }
}
