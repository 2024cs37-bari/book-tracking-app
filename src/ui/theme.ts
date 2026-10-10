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

/** Returns readable text (#fff or near-black) for a hex background. */
function contrastText(hex: string): string {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return '#ffffff';
  const int = parseInt(match[1]!, 16);
  const r = (int >> 16) & 0xff;
  const g = (int >> 8) & 0xff;
  const b = int & 0xff;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? '#10131a' : '#ffffff';
}

export function applyAccent(color: string): void {
  const root = document.documentElement;
  if (color.length > 0) {
    root.style.setProperty('--accent', color);
    root.style.setProperty('--accent-text', contrastText(color));
  } else {
    root.style.removeProperty('--accent');
    root.style.removeProperty('--accent-text');
  }
  try {
    if (color.length > 0) localStorage.setItem(ACCENT_KEY, color);
    else localStorage.removeItem(ACCENT_KEY);
  } catch {
    // Non-fatal.
  }
}

/** Applies persisted theme + accent; call once at startup. */
export function initTheme(): void {
  applyTheme(loadTheme());
  applyAccent(loadAccent());
}
