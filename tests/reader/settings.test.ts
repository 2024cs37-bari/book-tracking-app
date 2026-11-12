import { expect, it } from 'vitest';
import { DEFAULT_READER_SETTINGS, normalizeReaderSettings } from '~/reader/settings';
import { effectivePdfMode, pdfDisplayScale, pdfSpread } from '~/reader/pdf-layout';

it('upgrades old preferences without losing theme, type size or the old PDF zoom', () => {
  const settings = normalizeReaderSettings({
    fontSizePx: 27,
    lineHeight: 1.8,
    marginPx: 40,
    theme: 'sepia',
  });
  expect(settings).toMatchObject({
    fontSizePx: 27,
    lineHeight: 1.8,
    marginPx: 40,
    theme: 'sepia',
    pdfZoom: 150,
    mode: 'single',
  });
  expect(normalizeReaderSettings(settings)).toEqual(settings);
});
it('repairs corrupt fields independently and does not coerce unsafe CSS values', () => {
  expect(normalizeReaderSettings(null)).toEqual(DEFAULT_READER_SETTINGS);
  expect(
    normalizeReaderSettings({
      mode: 'continuous',
      fontFamily: 'url(bad)',
      pdfZoom: Infinity,
      marginPx: -1,
      pdfRotation: 45,
      pdfCoverAlone: 'false',
      theme: 'dark',
    }),
  ).toEqual({ ...DEFAULT_READER_SETTINGS, mode: 'continuous', theme: 'dark' });
});
it('keeps PDF scale separate from EPUB type size', () => {
  expect(
    normalizeReaderSettings({ ...DEFAULT_READER_SETTINGS, fontSizePx: 36, pdfZoom: 75 }).pdfZoom,
  ).toBe(75);
});
it('pairs facing pages with or without a separate cover and adapts narrow views', () => {
  expect([0, 1, 2, 3].map((i) => pdfSpread(i, 4, true))).toEqual([[0], [1, 2], [1, 2], [3]]);
  expect([0, 1, 2].map((i) => pdfSpread(i, 3, false))).toEqual([[0, 1], [0, 1], [2]]);
  expect(effectivePdfMode({ ...DEFAULT_READER_SETTINGS, mode: 'double' }, 699)).toBe('single');
  expect(effectivePdfMode({ ...DEFAULT_READER_SETTINGS, mode: 'double' }, 700)).toBe('double');
});
it('fits both pages into the available area and applies explicit zoom once', () => {
  const pages = [
    { width: 600, height: 800 },
    { width: 600, height: 800 },
  ];
  expect(pdfDisplayScale(pages, 1272, 848, DEFAULT_READER_SETTINGS)).toBe(1);
  expect(pdfDisplayScale(pages, 1272, 448, { ...DEFAULT_READER_SETTINGS, pdfFit: 'page' })).toBe(
    0.5,
  );
  expect(
    pdfDisplayScale(pages, 1272, 448, {
      ...DEFAULT_READER_SETTINGS,
      pdfFit: 'actual',
      pdfZoom: 200,
    }),
  ).toBe(2);
});
