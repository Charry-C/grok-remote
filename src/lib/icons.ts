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
  home: wrap(`
    <path d="M3.5 4.5h13a1.5 1.5 0 0 1 1.5 1.5v7a1.5 1.5 0 0 1-1.5 1.5H8l-3.5 3v-3h-1A1.5 1.5 0 0 1 2 13V6a1.5 1.5 0 0 1 1.5-1.5z"/>
  `),
  mcp: wrap(`
    <rect x="2.5" y="6.5" width="6" height="7" rx="1.5"/>
    <rect x="11.5" y="6.5" width="6" height="7" rx="1.5"/>
    <path d="M8.5 10h3"/>
    <path d="M5.5 4.5v2M5.5 13.5v2M14.5 4.5v2M14.5 13.5v2"/>
  `),
  memory: wrap(`
    <ellipse cx="10" cy="5.5" rx="6" ry="2"/>
    <path d="M4 5.5v3c0 1.1 2.7 2 6 2s6-.9 6-2v-3"/>
    <path d="M4 8.5v3c0 1.1 2.7 2 6 2s6-.9 6-2v-3"/>
    <path d="M4 11.5v3c0 1.1 2.7 2 6 2s6-.9 6-2v-3"/>
  `),
  models: wrap(`
    <rect x="4" y="6" width="12" height="9" rx="1.5"/>
    <path d="M5.5 4h9M6.5 2h7"/>
  `),
  leaders: wrap(`
    <circle cx="10" cy="6.5" r="2.5"/>
    <path d="M4 16c0-2.8 2.7-5 6-5s6 2.2 6 5"/>
    <circle cx="10" cy="3" r="0.6" fill="currentColor"/>
  `),
  worktrees: wrap(`
    <circle cx="5.5" cy="4.5" r="1.8"/>
    <circle cx="5.5" cy="15.5" r="1.8"/>
    <circle cx="14.5" cy="10" r="1.8"/>
    <path d="M5.5 6.3v7.4"/>
    <path d="M5.5 10c0-2.5 2-4.5 4.5-4.5h3"/>
  `),
  sessions: wrap(`
    <circle cx="10" cy="10" r="7"/>
    <path d="M10 6v4l2.5 2"/>
  `),
  import: wrap(`
    <path d="M10 3v9"/>
    <path d="M6.5 8.5L10 12l3.5-3.5"/>
    <path d="M4 14.5v1A1.5 1.5 0 0 0 5.5 17h9a1.5 1.5 0 0 0 1.5-1.5v-1"/>
  `),
  health: wrap(`
    <path d="M10 16.5s-6-3.7-6-8.2A3.3 3.3 0 0 1 10 6a3.3 3.3 0 0 1 6 2.3c0 4.5-6 8.2-6 8.2z"/>
  `),
  flow: wrap(`
    <circle cx="4" cy="6" r="1.8"/>
    <circle cx="16" cy="6" r="1.8"/>
    <circle cx="10" cy="14" r="1.8"/>
    <path d="M5.4 7l3.5 5.4"/>
    <path d="M14.6 7l-3.5 5.4"/>
    <path d="M5.8 6h8.4"/>
  `),
  setup: wrap(`
    <circle cx="10" cy="10" r="2.5"/>
    <path d="M10 2.5v2.3M10 15.2v2.3M2.5 10h2.3M15.2 10h2.3M4.6 4.6l1.6 1.6M13.8 13.8l1.6 1.6M4.6 15.4l1.6-1.6M13.8 6.2l1.6-1.6"/>
  `),
  skills: wrap(`
    <path d="M11.5 2L4 11.5h5L8.5 18 16 8.5h-5z"/>
  `),
  settings: wrap(`
    <path d="M4 5h6M14 5h2"/>
    <path d="M4 10h2M10 10h6"/>
    <path d="M4 15h8M16 15h0"/>
    <circle cx="12" cy="5" r="1.4"/>
    <circle cx="8" cy="10" r="1.4"/>
    <circle cx="14" cy="15" r="1.4"/>
  `),
  gear: wrap(`
    <circle cx="10" cy="10" r="2.3"/>
    <path d="M8.15 2.7h3.7l.4 1.8c.5.2.96.47 1.36.8l1.78-.52 1.78 3.08-1.46 1.08c.08.45.12.9.12 1.06s-.04.61-.12 1.06l1.46 1.08-1.78 3.08-1.78-.52a6 6 0 0 1-1.36.8l-.4 1.8h-3.7l-.4-1.8a6 6 0 0 1-1.36-.8l-1.78.52-1.78-3.08 1.46-1.08A6.4 6.4 0 0 1 4.23 10c0-.38.04-.61.12-1.06L2.89 7.86l1.78-3.08 1.78.52c.4-.33.86-.6 1.36-.8l.4-1.8z"/>
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
  'panel-right-open': wrap(`
    <rect x="2.5" y="2.5" width="15" height="15" rx="2"/>
    <path d="M13 2.5v15"/>
    <path d="m9 7.5L6.5 10 9 12.5"/>
  `),
  'panel-right-close': wrap(`
    <rect x="2.5" y="2.5" width="15" height="15" rx="2"/>
    <path d="M13 2.5v15"/>
    <path d="m6.5 7.5 2.5 2.5-2.5 2.5"/>
  `),
  globe: wrap(`
    <circle cx="10" cy="10" r="7"/>
    <path d="M3 10h14"/>
    <path d="M10 3a10 10 0 0 1 0 14"/>
    <path d="M10 3a10 10 0 0 0 0 14"/>
  `),
  'refresh-cw': wrap(`
    <path d="M17 4v4h-4"/>
    <path d="M3 16v-4h4"/>
    <path d="M5.5 8.5A6 6 0 0 1 16 7"/>
    <path d="M14.5 11.5A6 6 0 0 1 4 13"/>
  `),
  'download-cloud': wrap(`
    <path d="M5.5 14.5A4 4 0 0 1 6 6.6 5 5 0 0 1 15.9 7.5 3.5 3.5 0 0 1 14.5 14.5"/>
    <path d="M10 9v6"/>
    <path d="M7.5 12.5L10 15l2.5-2.5"/>
  `),
  check: wrap(`
    <path d="M4 10.5l3.5 3.5L16 5.5"/>
  `),
  'x-circle': wrap(`
    <circle cx="10" cy="10" r="7"/>
    <path d="M7.5 7.5l5 5"/>
    <path d="M12.5 7.5l-5 5"/>
  `),
  'maximize-2': wrap(`
    <polyline points="13 3 17 3 17 7"/>
    <polyline points="7 17 3 17 3 13"/>
    <line x1="17" y1="3" x2="11" y2="9"/>
    <line x1="3" y1="17" x2="9" y2="11"/>
  `),
  'minimize-2': wrap(`
    <polyline points="3 11 9 11 9 17"/>
    <polyline points="17 9 11 9 11 3"/>
    <line x1="11" y1="9" x2="17" y2="3"/>
    <line x1="3" y1="17" x2="9" y2="11"/>
  `),
  wrench: wrap(`
    <path d="M14 6.5a3.5 3.5 0 0 1-4.5 3.36L4 15.36 6.64 18l5.5-5.5A3.5 3.5 0 1 0 14 6.5z"/>
    <path d="M14 6.5l-1.7-1.7a1 1 0 0 1 0-1.4l1-1a1 1 0 0 1 1.4 0L17.6 5.3"/>
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
  mic: wrap(`
    <rect x="7.4" y="3.2" width="5.2" height="8.4" rx="2.6"/>
    <path d="M4.8 10.2a5.2 5.2 0 0 0 10.4 0"/>
    <path d="M10 15.4v1.6"/>
  `),
} as const;

export type IconName = keyof typeof ICONS;

export function iconHtml(name: string): string {
  return (ICONS as Record<string, string>)[name] || '';
}

// Official Grok singularity mark (2025). Isolated from the grok.com
// lockup so the empty-chat hero can scale it independently of the wordmark.
export const GROK_MARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 34 33" fill="currentColor" aria-hidden="true" focusable="false"><path d="M13.2371 21.0407L24.3186 12.8506C24.8619 12.4491 25.6384 12.6057 25.8973 13.2294C27.2597 16.5185 26.651 20.4712 23.9403 23.1851C21.2297 25.8989 17.4581 26.4941 14.0108 25.1386L10.2449 26.8843C15.6463 30.5806 22.2053 29.6665 26.304 25.5601C29.5551 22.3051 30.562 17.8683 29.6205 13.8673L29.629 13.8758C28.2637 7.99809 29.9647 5.64871 33.449 0.844576C33.5314 0.730667 33.6139 0.616757 33.6964 0.5L29.1113 5.09055V5.07631L13.2343 21.0436"/><path d="M10.9503 23.0313C7.07343 19.3235 7.74185 13.5853 11.0498 10.2763C13.4959 7.82722 17.5036 6.82767 21.0021 8.2971L24.7595 6.55998C24.0826 6.07017 23.215 5.54334 22.2195 5.17313C17.7198 3.31926 12.3326 4.24192 8.67479 7.90126C5.15635 11.4239 4.0499 16.8403 5.94992 21.4622C7.36924 24.9165 5.04257 27.3598 2.69884 29.826C1.86829 30.7002 1.0349 31.5745 0.36364 32.5L10.9474 23.0341"/></svg>`;

// Official Grok wordmark paths, cropped to the letterforms.
export const GROK_WORDMARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="37.8 8 50 17.2" fill="currentColor" aria-hidden="true" focusable="false"><path d="M45.7187 25.009C40.8101 25.009 37.8834 21.4448 37.8834 16.5846C37.8834 11.6788 40.9146 8.02795 45.8145 8.02795C49.6433 8.02795 52.4466 9.99027 53.1075 13.6411H50.1675C49.7345 11.5647 48.0024 10.401 45.8145 10.401C42.282 10.401 40.7322 13.4586 40.7322 16.5846C40.7322 19.7106 42.282 22.7454 45.8145 22.7454C49.1875 22.7454 50.6689 20.3039 50.7828 18.2731H45.7006V15.9105H53.381L53.3684 17.1457C53.3684 21.7359 51.4978 25.009 45.7187 25.009Z"/><path d="M55.5659 24.7077V14.782L57.731 12.9109H62.3347V15.1014H58.1413V24.7077H55.5659Z"/><path d="M68.6362 24.9815C64.8074 24.9815 62.7335 22.2662 62.7335 18.7979C62.7335 15.3068 64.8074 12.6143 68.6362 12.6143C72.4878 12.6143 74.5389 15.3068 74.5389 18.7979C74.5389 22.2662 72.4878 24.9815 68.6362 24.9815ZM65.4228 18.7979C65.4228 21.4904 66.8813 22.8366 68.6362 22.8366C70.4139 22.8366 71.8497 21.4904 71.8497 18.7979C71.8497 16.1054 70.4139 14.7363 68.6362 14.7363C66.8813 14.7363 65.4228 16.1054 65.4228 18.7979Z"/><path d="M76.4462 24.7077V8.41584H79.0216V19.1679L84.4685 12.9109H87.5908L82.6908 18.2731L87.6364 24.7077H84.5596L80.5539 19.1788L79.0216 19.1679V24.7077H76.4462Z"/></svg>`;
