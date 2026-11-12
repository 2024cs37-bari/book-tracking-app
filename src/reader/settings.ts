export type ReaderTheme = 'light' | 'sepia' | 'dark';
export type ReaderMode = 'single' | 'double' | 'continuous';
export type ReaderFont = 'publisher' | 'serif' | 'sans' | 'mono';
export type PdfFit = 'width' | 'page' | 'actual';

/** Device-local preferences. Original document geometry and saved locators stay independent. */
export interface ReaderSettings {
  readonly mode: ReaderMode;
  readonly fontSizePx: number;
  readonly lineHeight: number;
  readonly marginPx: number;
  readonly theme: ReaderTheme;
  readonly fontFamily: ReaderFont;
  readonly textAlign: 'publisher' | 'left' | 'justify';
  readonly textWidthPx: number;
  readonly letterSpacing: number;
  readonly paragraphSpacing: number;
  readonly pdfFit: PdfFit;
  readonly pdfZoom: number;
  readonly pdfRotation: 0 | 90 | 180 | 270;
  readonly pdfCoverAlone: boolean;
  readonly pdfDirection: 'ltr' | 'rtl';
  readonly pdfInvert: boolean;
}

export const DEFAULT_READER_SETTINGS: ReaderSettings = {
  mode: 'single',
  fontSizePx: 18,
  lineHeight: 1.6,
  marginPx: 24,
  theme: 'light',
  fontFamily: 'publisher',
  textAlign: 'publisher',
  textWidthPx: 720,
  letterSpacing: 0,
  paragraphSpacing: 0,
  pdfFit: 'width',
  pdfZoom: 100,
  pdfRotation: 0,
  pdfCoverAlone: true,
  pdfDirection: 'ltr',
  pdfInvert: false,
};

/** Upgrade legacy preferences field by field; malformed values cannot reach engine CSS/math. */
export function normalizeReaderSettings(input: unknown): ReaderSettings {
  const value = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const number = (
    key: keyof ReaderSettings,
    min: number,
    max: number,
    fallback: number,
  ): number => {
    const v = value[key];
    return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : fallback;
  };
  const choice = <T extends string | number>(
    key: keyof ReaderSettings,
    choices: readonly T[],
    fallback: T,
  ): T => (choices.includes(value[key] as T) ? (value[key] as T) : fallback);
  const fontSizePx = number('fontSizePx', 12, 36, 18);
  return {
    mode: choice('mode', ['single', 'double', 'continuous'], 'single'),
    fontSizePx,
    lineHeight: number('lineHeight', 1, 2.5, 1.6),
    marginPx: number('marginPx', 0, 80, 24),
    theme: choice('theme', ['light', 'sepia', 'dark'], 'light'),
    fontFamily: choice('fontFamily', ['publisher', 'serif', 'sans', 'mono'], 'publisher'),
    textAlign: choice('textAlign', ['publisher', 'left', 'justify'], 'publisher'),
    textWidthPx: number('textWidthPx', 400, 1200, 720),
    letterSpacing: number('letterSpacing', 0, 0.12, 0),
    paragraphSpacing: number('paragraphSpacing', 0, 2, 0),
    pdfFit: choice('pdfFit', ['width', 'page', 'actual'], 'width'),
    pdfZoom: number('pdfZoom', 50, 400, Math.round((fontSizePx / 18) * 100)),
    pdfRotation: choice('pdfRotation', [0, 90, 180, 270], 0),
    pdfCoverAlone: typeof value.pdfCoverAlone === 'boolean' ? value.pdfCoverAlone : true,
    pdfDirection: choice('pdfDirection', ['ltr', 'rtl'], 'ltr'),
    pdfInvert: value.pdfInvert === true,
  };
}

export const READER_FONTS: Record<Exclude<ReaderFont, 'publisher'>, string> = {
  serif: 'Georgia, "Palatino Linotype", Palatino, serif',
  sans: 'system-ui, -apple-system, "Segoe UI", sans-serif',
  mono: 'ui-monospace, "Cascadia Code", "Liberation Mono", monospace',
};
