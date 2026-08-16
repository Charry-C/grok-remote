// Theme registry and persistence.
//
// Themes apply via the `data-theme` attribute on <html>. CSS variables for
// each theme live in style.css under `[data-theme="..."]` selectors.
//
// Persistence: localStorage key `grok-remote.theme`.

const STORAGE_KEY = 'grok-remote.theme';
const DEFAULT_THEME = 'dark';

export interface Theme {
  name:   string;
  label:  string;
  blurb:  string;
  accent: string;
  swatch: string;
  chrome: string;
}

export type ThemeName = 'dark' | 'light';

export const THEMES: Theme[] = [
  {
    name:    'dark',
    label:   'dark',
    blurb:   'true black, like the Grok app',
    accent:  '#f4f4f5',
    swatch:  '#000000',
    chrome:  '#000000',
  },
  {
    name:    'light',
    label:   'light',
    blurb:   'clean white, like the Grok app',
    accent:  '#111113',
    swatch:  '#ffffff',
    chrome:  '#ffffff',
  },
];

const NAMES: string[] = THEMES.map((t) => t.name);

function isValid(name: unknown): name is string {
  return typeof name === 'string' && NAMES.includes(name);
}

export function getTheme(): string {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (isValid(v)) return v;
  } catch { /* ignore */ }
  return DEFAULT_THEME;
}

export function setTheme(name: string): string {
  const n = isValid(name) ? name : DEFAULT_THEME;
  try { localStorage.setItem(STORAGE_KEY, n); } catch { /* ignore */ }
  applyTheme(n);
  try {
    if (typeof window !== 'undefined' && typeof CustomEvent === 'function') {
      window.dispatchEvent(new CustomEvent('grok-remote:theme-change', { detail: { theme: n } }));
    }
  } catch { /* node / test env */ }
  return n;
}

export function applyTheme(name: string): string {
  const n = isValid(name) ? name : DEFAULT_THEME;
  if (typeof document !== 'undefined' && document.documentElement) {
    const root = document.documentElement as HTMLElement & { dataset: DOMStringMap };
    root.dataset.theme = n;
    // Keep native controls (select, scrollbars, sheets) on the same scheme.
    if (root.style) root.style.colorScheme = n === 'light' ? 'light' : 'dark';
    const meta = document.querySelector('meta[name="theme-color"]') as HTMLMetaElement | null;
    if (meta) meta.content = getThemeMeta(n).chrome;
  }
  return n;
}

export function nextTheme(current: string): string {
  const cur = isValid(current) ? current : getTheme();
  const idx = NAMES.indexOf(cur);
  const next = NAMES[(idx + 1) % NAMES.length] ?? DEFAULT_THEME;
  setTheme(next);
  return next;
}

export function getThemeMeta(name: string): Theme {
  return THEMES.find((t) => t.name === name) ?? THEMES[0]!;
}
