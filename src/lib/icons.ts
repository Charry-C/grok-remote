// Centralized inline SVG icons. Stroke-based, currentColor, 1.5px stroke,
// 20x20 viewBox. The rail and any other surface can drop one in by name.
//
// Why inline instead of an SVG sprite or icon font:
//  - Zero new deps and zero network round trips.
//  - currentColor lets every icon track the active theme without per-icon
//    CSS.
//  - Each definition is small (~150 chars) so the bundle hit is trivial.

const W = 20, H = 20, BASE = 'fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"';

function wrap(inner: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" aria-hidden="true" ${BASE}>${inner}</svg>`;
}

export const ICONS = {
  models: wrap(`
    <rect x="4" y="6" width="12" height="9" rx="1.5"/>
    <path d="M5.5 4h9M6.5 2h7"/>
  `),
  import: wrap(`
    <path d="M10 3v9"/>
    <path d="M6.5 8.5L10 12l3.5-3.5"/>
    <path d="M4 14.5v1A1.5 1.5 0 0 0 5.5 17h9a1.5 1.5 0 0 0 1.5-1.5v-1"/>
  `),
  skills: wrap(`
    <path d="M11.5 2L4 11.5h5L8.5 18 16 8.5h-5z"/>
  `),
  star: wrap(`
    <path d="M10 2.5 12.4 7.4 17.8 8.2 13.9 12 14.8 17.3 10 14.9 5.2 17.3 6.1 12 2.2 8.2 7.6 7.4z"/>
  `),
  'panel-left-open': wrap(`
    <rect x="2.5" y="2.5" width="15" height="15" rx="2"/>
    <path d="M7 2.5v15"/>
    <path d="m11 7.5 2.5 2.5L11 12.5"/>
  `),
  'panel-left-close': wrap(`
    <rect x="2.5" y="2.5" width="15" height="15" rx="2"/>
    <path d="M7 2.5v15"/>
    <path d="m13.5 7.5L11 10l2.5 2.5"/>
  `),
  check: wrap(`
    <path d="M4 10.5l3.5 3.5L16 5.5"/>
  `),
  folder: wrap(`
    <path d="M2.5 5.5a1.5 1.5 0 0 1 1.5-1.5h3.5l1.5 2H16a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 16 16H4a1.5 1.5 0 0 1-1.5-1.5z"/>
  `),
  inbox: wrap(`
    <path d="M3 13.5 5.2 5.8A1.5 1.5 0 0 1 6.6 4.7h6.8a1.5 1.5 0 0 1 1.4 1.1L17 13.5"/>
    <path d="M3 13.5h3.2l1.1 2h5.4l1.1-2H17v1A1.5 1.5 0 0 1 15.5 16h-11A1.5 1.5 0 0 1 3 14.5z"/>
  `),
  archive: wrap(`
    <rect x="3" y="3.5" width="14" height="4" rx="1.2"/>
    <path d="M4.5 7.5h11v7A1.5 1.5 0 0 1 14 16H6a1.5 1.5 0 0 1-1.5-1.5z"/>
    <path d="M8 11h4"/>
  `),
  trash: wrap(`
    <path d="M4 6.5h12"/>
    <path d="M8 3.5h4"/>
    <path d="M6.5 6.5l.6 9a1.5 1.5 0 0 0 1.5 1.4h2.8a1.5 1.5 0 0 0 1.5-1.4l.6-9"/>
  `),
  pencil: wrap(`
    <path d="M12.2 4.2l3.6 3.6-8.5 8.5H3.7v-3.6z"/>
    <path d="M10.6 5.8l3.6 3.6"/>
  `),
  copy: wrap(`
    <rect x="7" y="7" width="9" height="9" rx="1.5"/>
    <path d="M13 7V5.5A1.5 1.5 0 0 0 11.5 4h-6A1.5 1.5 0 0 0 4 5.5v6A1.5 1.5 0 0 0 5.5 13H7"/>
  `),
  plus: wrap(`
    <path d="M10 4.5v11"/>
    <path d="M4.5 10h11"/>
  `),
  sun: wrap(`
    <circle cx="10" cy="10" r="3.1"/>
    <path d="M10 2.4v1.7M10 15.9v1.7M2.4 10h1.7M15.9 10h1.7"/>
    <path d="M4.5 4.5l1.2 1.2M14.3 14.3l1.2 1.2M4.5 15.5l1.2-1.2M14.3 5.7l1.2-1.2"/>
  `),
  moon: wrap(`
    <path d="M13.2 3.4A7 7 0 1 0 16.6 13 5.5 5.5 0 0 1 13.2 3.4z"/>
  `),
  'chevron-down': wrap(`
    <path d="M5 7.5 10 12.5 15 7.5"/>
  `),
  sliders: wrap(`
    <path d="M3.5 6.5h13"/>
    <path d="M3.5 13.5h13"/>
    <circle cx="8" cy="6.5" r="1.7"/>
    <circle cx="12.5" cy="13.5" r="1.7"/>
  `),
  send: wrap(`
    <path d="M10 15.5v-11"/>
    <path d="M5.5 9 10 4.5 14.5 9"/>
  `),
  stop: wrap(`
    <rect x="6" y="6" width="8" height="8" rx="1.4"/>
  `),
} as const;

export type IconName = keyof typeof ICONS;

export function iconHtml(name: string): string {
  return (ICONS as Record<string, string>)[name] || '';
}

// Official Grok singularity mark (2025). Isolated from the grok.com
// lockup so the empty-chat hero can scale it independently of the wordmark.
export const GROK_MARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 34 33" fill="currentColor" aria-hidden="true" focusable="false"><path d="M13.2371 21.0407L24.3186 12.8506C24.8619 12.4491 25.6384 12.6057 25.8973 13.2294C27.2597 16.5185 26.651 20.4712 23.9403 23.1851C21.2297 25.8989 17.4581 26.4941 14.0108 25.1386L10.2449 26.8843C15.6463 30.5806 22.2053 29.6665 26.304 25.5601C29.5551 22.3051 30.562 17.8683 29.6205 13.8673L29.629 13.8758C28.2637 7.99809 29.9647 5.64871 33.449 0.844576C33.5314 0.730667 33.6139 0.616757 33.6964 0.5L29.1113 5.09055V5.07631L13.2343 21.0436"/><path d="M10.9503 23.0313C7.07343 19.3235 7.74185 13.5853 11.0498 10.2763C13.4959 7.82722 17.5036 6.82767 21.0021 8.2971L24.7595 6.55998C24.0826 6.07017 23.215 5.54334 22.2195 5.17313C17.7198 3.31926 12.3326 4.24192 8.67479 7.90126C5.15635 11.4239 4.0499 16.8403 5.94992 21.4622C7.36924 24.9165 5.04257 27.3598 2.69884 29.826C1.86829 30.7002 1.0349 31.5745 0.36364 32.5L10.9474 23.0341"/></svg>`;
