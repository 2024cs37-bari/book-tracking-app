import type { ReaderSettings, ReaderMode } from './settings';

export const PDF_SPREAD_MIN_WIDTH = 700;
export const PDF_PAGE_GAP = 24;
export const PDF_CONTINUOUS_CACHE_LIMIT = 6;
export const PDF_TOTAL_CANVAS_PIXELS = 8_000_000;

export function effectivePdfMode(settings: ReaderSettings, width: number): ReaderMode {
  return settings.mode === 'double' && width < PDF_SPREAD_MIN_WIDTH ? 'single' : settings.mode;
}

/** Logical page order stays stable even when a spread is displayed right-to-left. */
export function pdfSpread(index: number, count: number, coverAlone: boolean): number[] {
  if (coverAlone && index === 0) return [0];
  const start = coverAlone ? 1 + Math.floor((index - 1) / 2) * 2 : Math.floor(index / 2) * 2;
  return start + 1 < count ? [start, start + 1] : [start];
}

export function pdfDisplayScale(
  dimensions: readonly { width: number; height: number }[],
  width: number,
  height: number,
  settings: ReaderSettings,
): number {
  const padding = Math.max(24, settings.marginPx);
  const availableWidth = Math.max(
    160,
    width - padding * 2 - PDF_PAGE_GAP * (dimensions.length - 1),
  );
  const availableHeight = Math.max(100, height - padding * 2);
  const sumWidth = dimensions.reduce((total, page) => total + page.width, 0);
  const maxHeight = Math.max(...dimensions.map((page) => page.height));
  const fit =
    settings.pdfFit === 'actual'
      ? 1
      : settings.pdfFit === 'page'
        ? Math.min(availableWidth / sumWidth, availableHeight / maxHeight)
        : availableWidth / sumWidth;
  return (fit * settings.pdfZoom) / 100;
}
