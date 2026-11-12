import { describe, expect, it } from 'vitest';
import { ACCENT_PRESETS, accentInk, contrastRatio, contrastText } from '~/ui/theme';

const palettes = [
  ['#faf9f6', '#f2f0ea', '#fffefa'],
  ['#1e211c', '#191c17', '#282c25'],
];
describe('accent contrast', () => {
  it('uses WCAG relative luminance for preset and custom button text', () => {
    for (const color of [
      ...ACCENT_PRESETS.map((preset) => preset.value).filter(Boolean),
      '#ffffff',
      '#000000',
      '#ff0000',
      '#808080',
      '#00ff00',
      '#123456',
    ]) {
      expect(contrastRatio(contrastText(color), color), color).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrastText('#c67c00')).toBe('#10131a');
  });
  it('keeps accent links readable on every surface in both themes', () => {
    for (const surfaces of palettes)
      for (const color of [
        ...ACCENT_PRESETS.map((preset) => preset.value).filter(Boolean),
        '#ffffff',
        '#000000',
        '#123456',
      ]) {
        const ink = accentInk(color, surfaces);
        for (const surface of surfaces)
          expect(contrastRatio(ink, surface), `${color} on ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
  });
});
