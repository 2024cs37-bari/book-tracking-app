/**
 * App theme control. The palette lives entirely in CSS tokens
 * (src/styles/global.css); this only chooses which palette applies and lets the
 * user override the accent. Theme is a `data-theme` attribute on the root
 * element: absent = follow the OS, "light"/"dark" = force. A custom accent is
 * an inline `--accent` override with a contrast-matched `--accent-text`.
 */

export type AppTheme = 'system' | 'light' | 'dark';

const THEME_KEY = 'app-theme';
const ACCENT_KEY = 'app-accent';

/** Suggested accent presets for the Settings picker. */
export const ACCENT_PRESETS: readonly { readonly name: string; readonly value: string }[] = [
  { name: 'Default', value: '' },
  { name: 'Blue', value: '#2f5bd7' },
  { name: 'Violet', value: '#7c4dff' },
  { name: 'Green', value: '#2e8b57' },
  { name: 'Amber', value: '#c67c00' },
  { name: 'Rose', value: '#c2185b' },
];

export function loadTheme(): AppTheme {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(theme: AppTheme): void {
  const root = document.documentElement;
  if (theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;
  applyAccentTokens(loadAccent());
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Theme is a per-viewer convenience; a storage failure must not break the app.
  }
}

export function loadAccent(): string {
  try {
    return localStorage.getItem(ACCENT_KEY) ?? '';
  } catch {
    return '';
  }
}

type Rgb = readonly [number, number, number];
function rgb(hex: string): Rgb | null {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return null;
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}
function luminance(value: Rgb): number {
  const channel = (n: number) => {
    const v = n / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return channel(value[0]) * 0.2126 + channel(value[1]) * 0.7152 + channel(value[2]) * 0.0722;
}
export function contrastRatio(foreground: string, background: string): number {
  const a = rgb(foreground),
    b = rgb(background);
  if (!a || !b) return 0;
  const al = luminance(a),
    bl = luminance(b);
  return (Math.max(al, bl) + 0.05) / (Math.min(al, bl) + 0.05);
}
/** WCAG relative luminance, rather than a weighted RGB brightness heuristic. */
export function contrastText(hex: string): string {
  const chosen =
    contrastRatio('#ffffff', hex) >= contrastRatio('#10131a', hex) ? '#ffffff' : '#10131a';
  // Some midtones need pure black; near-black plus white can both fall just
  // below 4.5 even though black or white always offers a compliant option.
  return contrastRatio(chosen, hex) >= 4.5 ? chosen : '#000000';
}
/** Keep the chosen button background, but adjust colored text against surfaces. */
export function accentInk(hex: string, surfaces: readonly string[]): string {
  const start = rgb(hex);
  if (!start || surfaces.length === 0) return hex;
  const minimum = (color: string) =>
    Math.min(...surfaces.map((surface) => contrastRatio(color, surface)));
  if (minimum(hex) >= 4.5) return hex;
  const target = minimum('#ffffff') > minimum('#000000') ? 255 : 0;
  for (let step = 1; step <= 100; step++) {
    const fraction = step / 100;
    const result =
      '#' +
      start
        .map((channel) =>
          Math.round(channel + (target - channel) * fraction)
            .toString(16)
            .padStart(2, '0'),
        )
        .join('');
    if (minimum(result) >= 4.5) return result;
  }
  return target === 255 ? '#ffffff' : '#000000';
}
function applyAccentTokens(color: string): void {
  const root = document.documentElement;
  if (rgb(color)) {
    const css = getComputedStyle(root);
    const surfaces = ['--surface', '--surface-sunken', '--surface-raised']
      .map((name) => css.getPropertyValue(name).trim())
      .filter((value) => rgb(value) !== null);
    root.style.setProperty('--accent', color);
    root.style.setProperty('--accent-text', contrastText(color));
    root.style.setProperty('--accent-ink', accentInk(color, surfaces));
  } else {
    root.style.removeProperty('--accent');
    root.style.removeProperty('--accent-text');
    root.style.removeProperty('--accent-ink');
  }
}

export function applyAccent(color: string): void {
  color = rgb(color.trim()) ? color.trim().toLowerCase() : '';
  applyAccentTokens(color);
  try {
    if (color.length > 0) localStorage.setItem(ACCENT_KEY, color);
    else localStorage.removeItem(ACCENT_KEY);
  } catch {
    // Non-fatal.
  }
}

let systemThemeObserved = false;

/** Applies persisted theme + accent; call once at startup. */
export function initTheme(): void {
  applyTheme(loadTheme());
  applyAccent(loadAccent());
  if (!systemThemeObserved && typeof matchMedia === 'function') {
    systemThemeObserved = true;
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (loadTheme() === 'system') applyAccentTokens(loadAccent());
    });
  }
}
