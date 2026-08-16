// Conversation sidebar: list + new + star + archive + folders.
//
// Rows are intentionally compact: status dot + star + name + archive close. The
// model badge, connect/disconnect link, and cwd path were moved off the row.
// Folders are persisted server-side via /api/folders. Drag/drop uses Pointer
// Events so the same code path works on desktop and touch.

import { api } from '../lib/api.js';
import { el, renderToast } from '../lib/render.js';
import { fmtTokens } from '../lib/format.js';
import { iconHtml } from '../lib/icons.js';
import { setTheme } from '../lib/themes.js';
import { computeSelection } from './agents-selection.js';
import { openCwdSheet } from './cwd-sheet.js';
import { openImportSheet } from './import-sheet.js';
import { openPromptSheet } from './prompt-sheet.js';

const STATUS_LABEL: Record<string, string> = {
  idle:         'idle',
  running:      'running',
  errored:      'errored',
  killed:       'killed',
  starting:     'starting',
  disconnected: 'disconnected',
  exited:       'disconnected',
  observed:     'watching TUI',
};

const SORT_KEY        = 'grok-remote.sidebar.sort';
const STATUS_KEY      = 'grok-remote.sidebar.status-filter';
const SEARCH_KEY      = 'grok-remote.sidebar.search';
const COLLAPSED_KEY   = 'grok-remote.sidebar.collapsed-folders';
const SORT_DEFAULT    = 'created_desc';
// Touch needs a long-press because vertical drag is reserved for scrolling.
// Mouse/pen activate drag immediately past a small horizontal move threshold.
const LONG_PRESS_MS    = 450;
const MOUSE_DRAG_THRESH = 6;
const TOUCH_MOVE_THRESH = 8;
// A pointerup within this window with no movement counts as a plain click.
const CLICK_MAX_MS = 250;

const DELETE_OVERLAY_CONFIRM =
  'Remove this conversation from grok-remote. The official Grok session files are kept unless you opt in.';
const DELETE_TUI_CONFIRM =
  'Also delete the official Grok session files? This cannot be undone.';

interface SortConfig { label: string; cmp(a: Agent, b: Agent): number }

const SORTS: Record<string, SortConfig> = {
  created_desc:    { label: 'Newest first',  cmp: (a, b) => (b.createdAt || '').localeCompare(a.createdAt || '') },
  created_asc:     { label: 'Oldest first',  cmp: (a, b) => (a.createdAt || '').localeCompare(b.createdAt || '') },
  activity_desc:   { label: 'Last active',   cmp: (a, b) => (b.lastSeen   || '').localeCompare(a.lastSeen   || '') },
  name_asc:        { label: 'Name A–Z',      cmp: (a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }) },
};

interface StatusFilter {
  id: string;
  label: string;
  match: string[];
}

const STATUS_FILTERS: StatusFilter[] = [
  { id: 'idle',          label: 'Idle',          match: ['idle'] },
  { id: 'running',       label: 'Running',       match: ['running', 'starting'] },
  { id: 'watching',      label: 'Watching TUI',  match: ['observed'] },
  { id: 'disconnected',  label: 'Disconnected',  match: ['disconnected', 'exited'] },
  { id: 'errored',       label: 'Errored',       match: ['errored', 'killed'] },
];

const STATUS_FILTER_IDS = new Set(STATUS_FILTERS.map((s) => s.id));

function statusBucket(status?: string): string {
  const raw = status || 'idle';
  for (const f of STATUS_FILTERS) if (f.match.includes(raw)) return f.id;
  return raw;
}

function loadSort(): string { try { const v = localStorage.getItem(SORT_KEY); return v && SORTS[v] ? v : SORT_DEFAULT; } catch { return SORT_DEFAULT; } }
function saveSort(v: string): void { try { localStorage.setItem(SORT_KEY, v); } catch { /* ignore */ } }
function loadStatusFilters(): Set<string> {
  try {
    const raw = localStorage.getItem(STATUS_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((x): x is string => typeof x === 'string' && STATUS_FILTER_IDS.has(x)));
  } catch { return new Set(); }
}
function saveStatusFilters(set: Set<string>): void {
  try { localStorage.setItem(STATUS_KEY, JSON.stringify(Array.from(set))); } catch { /* ignore */ }
}
function loadSearch(): string { try { return localStorage.getItem(SEARCH_KEY) || ''; } catch { return ''; } }
function saveSearch(v: string): void { try { localStorage.setItem(SEARCH_KEY, v); } catch { /* ignore */ } }
function loadCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((x): x is string => typeof x === 'string'));
  } catch { return new Set(); }
}
function saveCollapsed(set: Set<string>): void {
  try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify(Array.from(set))); } catch { /* ignore */ }
}

export interface Agent {
  id: string;
  name?: string;
  model?: string;
  status?: string;
  cwd?: string;
  createdAt?: string;
  lastSeen?: string;
  starred?: boolean;
  archived?: boolean;
  totalTokens?: number;
  inFlight?: number;
  heldBy?: 'tui' | 'remote' | null;
  source?: 'tui' | 'remote';
  lastSessionId?: string;
  sessionId?: string;
  wantedConnected?: boolean;
  [k: string]: unknown;
}

export interface Folder {
  id: string;
  name: string;
  agentIds: string[];
  createdAt: string;
  // System folders ("Archived") can't be deleted or renamed.
  system?: boolean;
}

const ARCHIVED_FOLDER_ID = 'archived';

export interface AgentsSidebarOptions {
  onSelect?: (id: string) => void;
  onCreate?: (created: Agent) => void;
  onDelete?: (id: string) => void;
}

const TOP_LEVEL_ID = '__top__';

export class AgentsSidebar {
  onSelect?: (id: string) => void;
  onCreate?: (created: Agent) => void;
  onDelete?: (id: string) => void;

  agents: Agent[];
  folders: Folder[];
  selectedId: string | null;
  // Multi-selection (Ctrl/Cmd-click + Shift-click) is independent of selectedId,
  // which still tracks the currently-open conversation.
  multiSelection: Set<string>;
  selectionAnchor: string | null;
  pollHandle: ReturnType<typeof setInterval> | null;
  sortKey: string;
  statusFilters: Set<string>;
  search: string;
  collapsed: Set<string>;

  activeList: HTMLElement;
  multiSelectFooter: HTMLElement;
  multiSelectLabel: HTMLElement;
  empty: HTMLElement;
  noMatch: HTMLElement;
  error: HTMLElement;
  newBtn: HTMLButtonElement;
  newFolderBtn: HTMLButtonElement;
  importBtn: HTMLButtonElement;
  closeDrawerBtn: HTMLButtonElement;
  searchInput: HTMLInputElement;
  searchClearBtn: HTMLButtonElement;
  sortBtn: HTMLButtonElement;
  sortLabel: HTMLElement;
  sortWrap: HTMLElement;
  root: HTMLElement;

  private _creating?: boolean;
  private _spawnHandlerWired?: boolean;
  private _agentsStream?: EventSource | null;
  private _sseAlive?: boolean;
  private _onVisibility?: () => void;

  // Drag state (pointer-events based).
  private _drag: {
    agentId: string;
    pointerId: number;
    pointerType: string;
    startX: number;
    startY: number;
    startTime: number;
    sourceEl: HTMLElement;
    ghost: HTMLElement | null;
    active: boolean;
    captured: boolean;
    pressTimer: number | null;
    moved: boolean;
  } | null = null;

  private _ctxMenu: HTMLElement | null = null;
  private _ctxCleanup: (() => void) | null = null;
  private _sortMenu: HTMLElement | null = null;
  private _sortCleanup: (() => void) | null = null;

  constructor({ onSelect, onCreate, onDelete }: AgentsSidebarOptions) {
    this.onSelect = onSelect;
    this.onCreate = onCreate;
    this.onDelete = onDelete;
    this.agents = [];
    this.folders = [];
    this.selectedId = null;
    this.multiSelection = new Set();
    this.selectionAnchor = null;
    this.pollHandle = null;
    this.sortKey = loadSort();
    this.statusFilters = loadStatusFilters();
    this.search  = loadSearch();
    this.collapsed = loadCollapsed();

    this.activeList = el('div', { class: 'agents-list' }) as HTMLElement;
    // Drop-target highlight should clear if the user drags out of the list.
    this.activeList.addEventListener('pointerleave', () => {
      this.activeList.querySelectorAll('.folder-header--drop').forEach((n) =>
        n.classList.remove('folder-header--drop'),
      );
    });

    this.empty = el('div', { class: 'agents-empty' }, 'no agents yet') as HTMLElement;
    this.noMatch = el('div', { class: 'agents-empty' }, 'No conversations match these filters') as HTMLElement;
    this.error = el('div', { class: 'agents-empty agents-empty--err' }) as HTMLElement;
    this.error.hidden = true;

    this.newBtn = el('button', {
      class: 'agents-new-btn',
      type: 'button',
      title: 'New chat. Long-press to change the working directory.',
    },
      el('span', { class: 'agents-new-btn__ico', html: iconHtml('plus') }),
      el('span', { class: 'agents-new-btn__label' }, 'New chat'),
    ) as HTMLButtonElement;
    let suppressNewClick = false;
    this.newBtn.addEventListener('click', () => {
      if (suppressNewClick) { suppressNewClick = false; return; }
      void this.spawnNew();
    });
    this.newBtn.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      suppressNewClick = true;
      void this.changeDefaultCwd();
    });
    let newPress: number | null = null;
    this.newBtn.addEventListener('pointerdown', () => {
      newPress = window.setTimeout(() => {
        newPress = null;
        suppressNewClick = true;
        void this.changeDefaultCwd();
      }, 520);
    });
    const cancelNewPress = () => {
      if (newPress != null) { window.clearTimeout(newPress); newPress = null; }
    };
    this.newBtn.addEventListener('pointerup', cancelNewPress);
    this.newBtn.addEventListener('pointercancel', cancelNewPress);
    this.newBtn.addEventListener('pointerleave', cancelNewPress);

    this.newFolderBtn = el('button', {
      class: 'agents-chip-btn agents-new-folder-btn',
      type: 'button',
      title: 'Create a folder',
      onclick: () => void this.promptNewFolder(),
    },
      el('span', { class: 'agents-chip-btn__ico', html: iconHtml('folder') }),
      el('span', { class: 'agents-chip-btn__label' }, 'Folder'),
    ) as HTMLButtonElement;

    this.importBtn = el('button', {
      class: 'agents-chip-btn agents-import-btn',
      type: 'button',
      title: 'Import a leftover TUI session',
      onclick: () => this.openImport(),
    },
      el('span', { class: 'agents-chip-btn__ico', html: iconHtml('import') }),
      el('span', { class: 'agents-chip-btn__label' }, 'Import'),
    ) as HTMLButtonElement;

    this.closeDrawerBtn = el('button', {
      class: 'sidebar-close',
      type: 'button',
      title: 'close menu',
      'aria-label': 'close menu',
      onclick: () => document.dispatchEvent(new CustomEvent('grok-remote:close-drawer')),
    }, '×') as HTMLButtonElement;

    this.searchInput = el('input', {
      class: 'sidebar-search-input',
      type: 'search',
      placeholder: 'search conversations',
      value: this.search,
      'aria-label': 'search conversations',
      oninput: (ev: Event) => {
        const target = ev.target as HTMLInputElement;
        this.search = (target.value || '').trim();
        saveSearch(this.search);
        this.renderList();
      },
      onfocus: () => {
        // iOS scrolls the document to keep inputs in view; the chat
        // pane is frozen while the drawer is open, so snap back.
        window.scrollTo(0, 0);
      },
    }) as HTMLInputElement;
    this.searchClearBtn = el('button', {
      class: 'sidebar-search-clear',
      type: 'button',
      title: 'clear search',
      'aria-label': 'clear search',
      onclick: () => {
        this.search = '';
        this.searchInput.value = '';
        saveSearch('');
        this.renderList();
        this.searchInput.focus();
      },
    }, '×') as HTMLButtonElement;

    this.sortLabel = el('span', { class: 'sidebar-filter__label' }, 'Filter') as HTMLElement;
    this.sortBtn = el('button', {
      class: 'sidebar-filter__btn',
      type: 'button',
      'aria-label': 'Filter conversations',
      'aria-haspopup': 'dialog',
      'aria-expanded': 'false',
      onclick: () => this.toggleFilterSheet(),
    },
      el('span', { class: 'sidebar-filter__ico', html: iconHtml('sliders') }),
      this.sortLabel,
      el('span', { class: 'sidebar-filter__caret', html: iconHtml('chevron-down') }),
    ) as HTMLButtonElement;
    this.sortWrap = el('div', { class: 'sidebar-filter' }, this.sortBtn) as HTMLElement;
    this.paintFilterButton();

    this.multiSelectLabel = el('span', { class: 'sidebar-multi__label' }, '') as HTMLElement;
    const clearBtn = el('button', {
      class: 'sidebar-multi__clear',
      type: 'button',
      title: 'clear selection (Esc)',
      onclick: (ev: MouseEvent) => { ev.stopPropagation(); this.clearMultiSelection(); },
    }, 'clear') as HTMLButtonElement;
    this.multiSelectFooter = el('div', { class: 'sidebar-multi', hidden: '' },
      this.multiSelectLabel,
      clearBtn,
    ) as HTMLElement;

    const themeDark = el('button', {
      class: 'sidebar-theme__opt',
      type: 'button',
      'data-appearance': 'dark',
      title: 'Dark appearance',
      'aria-label': 'Use dark appearance',
      onclick: () => setTheme('dark'),
    },
      el('span', { class: 'sidebar-theme__ico', html: iconHtml('moon') }),
      el('span', { class: 'sidebar-theme__txt' }, 'Dark'),
    ) as HTMLButtonElement;
    const themeLight = el('button', {
      class: 'sidebar-theme__opt',
      type: 'button',
      'data-appearance': 'light',
      title: 'Light appearance',
      'aria-label': 'Use light appearance',
      onclick: () => setTheme('light'),
    },
      el('span', { class: 'sidebar-theme__ico', html: iconHtml('sun') }),
      el('span', { class: 'sidebar-theme__txt' }, 'Light'),
    ) as HTMLButtonElement;

    this.root = el('aside', { class: 'sidebar' },
      el('div', { class: 'sidebar-head' },
        el('div', { class: 'sidebar-head__row' },
          el('span', { class: 'sidebar-title' }, 'Chats'),
          this.closeDrawerBtn,
        ),
        el('div', { class: 'sidebar-theme', role: 'group', 'aria-label': 'Appearance' },
          themeDark,
          themeLight,
        ),
        el('div', { class: 'sidebar-actions' },
          this.newBtn,
          el('div', { class: 'sidebar-actions__secondary' },
            this.newFolderBtn,
            this.importBtn,
          ),
        ),
      ),
      el('div', { class: 'sidebar-tools' },
        el('div', { class: 'sidebar-search' },
          this.searchInput,
          this.searchClearBtn,
        ),
        this.sortWrap,
      ),
      this.error,
      el('div', { class: 'sidebar-body' },
        this.activeList,
      ),
      this.multiSelectFooter,
    ) as HTMLElement;

    // Esc clears the multi-selection. Scoped to the sidebar root so we don't
    // intercept Esc inside the chat composer or other modals.
    this.root.addEventListener('keydown', (ev: KeyboardEvent) => {
      if (ev.key === 'Escape' && this.multiSelection.size > 0) {
        ev.preventDefault();
        this.clearMultiSelection();
      }
    });
    // Make the root focusable for the Escape handler to fire.
    if (!this.root.hasAttribute('tabindex')) this.root.setAttribute('tabindex', '-1');
  }

  clearMultiSelection(): void {
    if (this.multiSelection.size === 0 && this.selectionAnchor == null) return;
    this.multiSelection = new Set();
    this.selectionAnchor = null;
    this.renderList();
  }

  private _updateMultiFooter(): void {
    const n = this.multiSelection.size;
    if (n <= 1) {
      this.multiSelectFooter.hidden = true;
      return;
    }
    this.multiSelectFooter.hidden = false;
    this.multiSelectLabel.textContent = `${n} selected`;
  }

  // Visible, sorted, search-and-status-filtered agent IDs in on-screen order.
  // Used as the ordering universe for shift-click range selection.
  private _visibleOrderedIds(): string[] {
    const visible = this._sortAgents(this.agents).filter((a) => this._isVisible(a));
    const folderById = new Map<string, Folder>();
    for (const f of this.folders) folderById.set(f.id, f);
    const folderOfAgent = new Map<string, string>();
    for (const f of this.folders) for (const aid of f.agentIds) folderOfAgent.set(aid, f.id);

    if (this.folders.length === 0) return visible.map((a) => a.id);

    const topLevel: string[] = [];
    const buckets = new Map<string, string[]>();
    for (const a of visible) {
      const fid = folderOfAgent.get(a.id);
      if (fid && folderById.has(fid)) {
        if (!buckets.has(fid)) buckets.set(fid, []);
        buckets.get(fid)!.push(a.id);
      } else {
        topLevel.push(a.id);
      }
    }
    const ordered: string[] = [];
    ordered.push(...topLevel);
    for (const f of this.folders) ordered.push(...(buckets.get(f.id) || []));
    return ordered;
  }

  private _sortAgents(list: Agent[]): Agent[] {
    const sorter = SORTS[this.sortKey] || SORTS[SORT_DEFAULT]!;
    return list.slice().sort((a, b) => {
      const s = (b.starred ? 1 : 0) - (a.starred ? 1 : 0);
      if (s) return s;
      return sorter.cmp(a, b);
    });
  }

  private _matchesSearch(a: Agent): boolean {
    if (!this.search) return true;
    const needle = this.search.toLowerCase();
    return (a.name || '').toLowerCase().includes(needle)
        || (a.id || '').toLowerCase().includes(needle)
        || (a.model || '').toLowerCase().includes(needle)
        || (a.lastSessionId || '').toLowerCase().includes(needle)
        || (a.sessionId || '').toLowerCase().includes(needle);
  }

  private _matchesStatus(a: Agent): boolean {
    if (this.statusFilters.size === 0) return true;
    return this.statusFilters.has(statusBucket(a.status));
  }

  private _isVisible(a: Agent): boolean {
    return this._matchesSearch(a) && this._matchesStatus(a);
  }

  private _isFiltering(): boolean {
    return !!this.search || this.statusFilters.size > 0;
  }

  // Leftover `grok-remote:resume-tui` events still land here after the
  // Resume sheet was removed. Import-only: never spawn() / steal the ACP lock.
  async resumeTui(session: { sessionId: string; cwd?: string; title?: string }): Promise<void> {
    if (this._creating) return;
    this._creating = true;
    try {
      const created = await api.createAgent({
        name: session.title || session.sessionId.slice(0, 8),
        cwd: session.cwd,
        resumeSessionId: session.sessionId,
        connect: false,
      }) as Agent;
      if (typeof this.onCreate === 'function') this.onCreate(created);
      await this.refresh();
      if (created && created.id) this.select(created.id);
      document.dispatchEvent(new CustomEvent('grok-remote:close-drawer'));
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'failed to resume session';
      this.error.textContent = msg;
      this.error.hidden = false;
    } finally {
      this._creating = false;
    }
  }

  private _toast(text: string): void {
    const toast = renderToast(text, 'warn');
    toast.style.position = 'fixed';
    toast.style.top = '16px';
    toast.style.right = '16px';
    toast.style.zIndex = '50';
    document.body.appendChild(toast);
    window.setTimeout(() => {
      toast.classList.add('toast--out');
      window.setTimeout(() => toast.remove(), 250);
    }, 4000);
  }

  async spawnNew(): Promise<void> {
    if (this._creating) return;
    this._creating = true;
    this.newBtn.disabled = true;
    this.error.hidden = true;
    const labelEl = this.newBtn.querySelector('.agents-new-btn__label');
    const prevLabel = labelEl?.textContent || 'New chat';
    if (labelEl) labelEl.textContent = 'Starting…';
    try {
      let defaultCwd = '';
      try {
        const settings = await api.getSettings() as { defaultCwd?: unknown };
        defaultCwd = typeof settings.defaultCwd === 'string' ? settings.defaultCwd.trim() : '';
      } catch { defaultCwd = ''; }
      if (!defaultCwd) {
        defaultCwd = (await openCwdSheet({ current: '' })) || '';
        if (!defaultCwd) return;
      }
      const created = await api.createAgent({}) as Agent;
      if (typeof this.onCreate === 'function') this.onCreate(created);
      await this.refresh();
      if (created && created.id) this.select(created.id);
      document.dispatchEvent(new CustomEvent('grok-remote:close-drawer'));
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'failed to spawn agent';
      this.error.textContent = msg;
      this.error.hidden = false;
    } finally {
      this._creating = false;
      this.newBtn.disabled = false;
      if (labelEl) labelEl.textContent = prevLabel;
    }
  }

  private paintFilterButton(): void {
    const n = this.statusFilters.size;
    let text = 'Filter';
    if (n === 1) {
      const id = [...this.statusFilters][0]!;
      const lab = STATUS_FILTERS.find((s) => s.id === id)?.label;
      if (lab) text = `Filter · ${lab}`;
    } else if (n > 1) {
      text = `Filter · ${n} statuses`;
    }
    this.sortLabel.textContent = text;
    this.sortWrap.classList.toggle('is-filtered', n > 0 || this.sortKey !== SORT_DEFAULT);
    this.sortBtn.title = n
      ? `${(SORTS[this.sortKey] || SORTS[SORT_DEFAULT]!).label} · ${text}`
      : (SORTS[this.sortKey] || SORTS[SORT_DEFAULT]!).label;
  }

  private setSort(key: string): void {
    if (!SORTS[key] || key === this.sortKey) return;
    this.sortKey = key;
    saveSort(this.sortKey);
    this.paintFilterButton();
    this._syncFilterSheet();
    this.renderList();
  }

  private toggleStatusFilter(id: string): void {
    if (!STATUS_FILTER_IDS.has(id)) return;
    if (this.statusFilters.has(id)) this.statusFilters.delete(id);
    else this.statusFilters.add(id);
    saveStatusFilters(this.statusFilters);
    this.paintFilterButton();
    this._syncFilterSheet();
    this.renderList();
  }

  private clearStatusFilters(): void {
    if (this.statusFilters.size === 0) return;
    this.statusFilters = new Set();
    saveStatusFilters(this.statusFilters);
    this.paintFilterButton();
    this._syncFilterSheet();
    this.renderList();
  }

  private toggleFilterSheet(): void {
    if (this._sortMenu) this.closeFilterSheet();
    else this.openFilterSheet();
  }

  private closeFilterSheet(): void {
    if (this._sortCleanup) { this._sortCleanup(); this._sortCleanup = null; }
    this._sortMenu?.remove();
    this._sortMenu = null;
    this.sortBtn.setAttribute('aria-expanded', 'false');
    this.sortWrap.classList.remove('is-open');
  }

  private _syncFilterSheet(): void {
    const sheet = this._sortMenu;
    if (!sheet) return;
    sheet.querySelectorAll<HTMLElement>('[data-sort]').forEach((btn) => {
      btn.classList.toggle('is-on', btn.dataset.sort === this.sortKey);
    });
    sheet.querySelectorAll<HTMLElement>('[data-status]').forEach((btn) => {
      const id = btn.dataset.status || '';
      btn.classList.toggle('is-on', this.statusFilters.has(id));
    });
    const clear = sheet.querySelector<HTMLElement>('[data-clear-status]');
    if (clear) clear.hidden = this.statusFilters.size === 0;
  }

  private openFilterSheet(): void {
    this.closeFilterSheet();

    const arrange = el('div', { class: 'filter-sheet__chips' },
      ...Object.entries(SORTS).map(([k, s]) =>
        el('button', {
          class: `filter-sheet__chip${k === this.sortKey ? ' is-on' : ''}`,
          type: 'button',
          'data-sort': k,
          onclick: () => this.setSort(k),
        }, s.label),
      ),
    );

    const statuses = el('div', { class: 'filter-sheet__chips' },
      ...STATUS_FILTERS.map((s) =>
        el('button', {
          class: `filter-sheet__chip filter-sheet__chip--status${this.statusFilters.has(s.id) ? ' is-on' : ''}`,
          type: 'button',
          'data-status': s.id,
          onclick: () => this.toggleStatusFilter(s.id),
        },
          el('span', { class: `filter-sheet__dot filter-sheet__dot--${s.id}` }),
          s.label,
        ),
      ),
    );

    const clearBtn = el('button', {
      class: 'filter-sheet__clear',
      type: 'button',
      'data-clear-status': '1',
      hidden: this.statusFilters.size === 0 ? '' : undefined,
      onclick: () => this.clearStatusFilters(),
    }, 'Clear status') as HTMLButtonElement;

    const sheet = el('div', {
      class: 'tui-sheet filter-sheet',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': 'Filter conversations',
      onclick: (ev: MouseEvent) => ev.stopPropagation(),
    },
      el('div', { class: 'tui-sheet__backdrop', onclick: () => this.closeFilterSheet() }),
      el('div', { class: 'filter-sheet__card' },
        el('div', { class: 'ctx-sheet__handle', 'aria-hidden': 'true' }),
        el('header', { class: 'filter-sheet__head' },
          el('h2', { class: 'filter-sheet__title' }, 'Filter'),
          el('p', { class: 'filter-sheet__hint' }, 'Arrange the list, then keep only the states you want.'),
        ),
        el('section', { class: 'filter-sheet__section' },
          el('h3', { class: 'filter-sheet__label' }, 'Arrange'),
          arrange,
        ),
        el('section', { class: 'filter-sheet__section' },
          el('h3', { class: 'filter-sheet__label' }, 'Status'),
          statuses,
          clearBtn,
        ),
      ),
    ) as HTMLElement;

    document.body.appendChild(sheet);
    this._sortMenu = sheet;
    this.sortBtn.setAttribute('aria-expanded', 'true');
    this.sortWrap.classList.add('is-open');

    const onDoc = (ev: Event): void => {
      const tgt = ev.target as Node | null;
      if (tgt && (sheet.contains(tgt) || this.sortBtn.contains(tgt))) return;
      this.closeFilterSheet();
    };
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        this.closeFilterSheet();
        this.sortBtn.focus();
      }
    };
    setTimeout(() => {
      document.addEventListener('pointerdown', onDoc, true);
      document.addEventListener('keydown', onKey, true);
    }, 0);
    this._sortCleanup = () => {
      document.removeEventListener('pointerdown', onDoc, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }

  async changeDefaultCwd(): Promise<void> {
    let current = '';
    try {
      const settings = await api.getSettings() as { defaultCwd?: unknown };
      current = typeof settings.defaultCwd === 'string' ? settings.defaultCwd : '';
    } catch { current = ''; }
    const next = await openCwdSheet({ current });
    if (next) this._toast(`cwd set to ${next}`);
  }

  openImport(): void {
    openImportSheet({
      onOpen: (id) => {
        if (typeof this.onCreate === 'function') this.onCreate({ id } as Agent);
        void this.refresh();
        this.select(id);
        document.dispatchEvent(new CustomEvent('grok-remote:close-drawer'));
      },
    });
  }

  async promptNewFolder(): Promise<void> {
    const name = await openPromptSheet({
      title: 'New folder',
      hint: 'A place to group conversations. Drag chats in after you create it.',
      icon: 'folder',
      placeholder: 'Folder name',
      confirmLabel: 'Create folder',
    });
    if (!name) return;
    try {
      await api.folders.create(name);
      await this.refreshFolders();
      this.renderList();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this._toast(`Couldn't create folder: ${msg}`);
    }
  }

  mount(parent: HTMLElement): void {
    parent.appendChild(this.root);
    void this.refresh();
    void this.refreshFolders();
    this._startSseStream();
    this.startPolling();
    if (!this._spawnHandlerWired) {
      document.addEventListener('grok-remote:spawn-agent', () => void this.spawnNew());
      document.addEventListener('grok-remote:resume-tui', ((ev: CustomEvent) => {
        const d = ev.detail || {};
        if (d.sessionId) void this.resumeTui(d);
      }) as EventListener);
      document.addEventListener('grok-remote:close-drawer', () => this.closeFilterSheet());
      this._spawnHandlerWired = true;
    }
  }

  private _startSseStream(): void {
    if (this._agentsStream) return;
    try {
      const es = new EventSource(api.agentsStreamUrl());
      this._agentsStream = es;
      es.addEventListener('open', () => { this._sseAlive = true; });
      es.addEventListener('agents_snapshot', (ev: MessageEvent) => {
        try {
          const d = JSON.parse(ev.data);
          if (d && Array.isArray(d.agents)) {
            this.agents = d.agents;
            this.renderList();
            document.dispatchEvent(new CustomEvent('grok-remote:agents-refresh', { detail: d.agents }));
          }
        } catch { /* ignore */ }
      });
      const onMutation = (): void => { void this.refresh(); };
      es.addEventListener('agent_added',   onMutation);
      es.addEventListener('agent_removed', onMutation);
      es.addEventListener('agent_updated', onMutation);
      es.addEventListener('agent_status',  onMutation);
      es.addEventListener('agent_tokens', (ev: MessageEvent) => {
        try {
          const d = JSON.parse(ev.data) as { id?: string; totalTokens?: unknown };
          if (!d || !d.id || typeof d.totalTokens !== 'number') return;
          const idx = this.agents.findIndex((a) => a && a.id === d.id);
          if (idx < 0) return;
          this.agents[idx] = { ...this.agents[idx]!, totalTokens: d.totalTokens };
          this.renderList();
          document.dispatchEvent(new CustomEvent('grok-remote:agents-refresh', { detail: this.agents }));
        } catch { /* ignore */ }
      });
      es.addEventListener('agent_inflight', (ev: MessageEvent) => {
        try {
          const d = JSON.parse(ev.data) as { id?: string; inFlight?: unknown };
          if (!d || !d.id || typeof d.inFlight !== 'number') return;
          const idx = this.agents.findIndex((a) => a && a.id === d.id);
          if (idx < 0) return;
          this.agents[idx] = { ...this.agents[idx]!, inFlight: d.inFlight };
          this.renderList();
          document.dispatchEvent(new CustomEvent('grok-remote:agents-refresh', { detail: this.agents }));
        } catch { /* ignore */ }
      });
      es.addEventListener('error', () => { this._sseAlive = false; });
    } catch {
      this._agentsStream = null;
    }
  }

  private _stopSseStream(): void {
    if (this._agentsStream) {
      try { this._agentsStream.close(); } catch { /* ignore */ }
      this._agentsStream = null;
    }
  }

  startPolling(): void {
    if (this.pollHandle) clearInterval(this.pollHandle);
    this.pollHandle = setInterval(() => {
      if (document.hidden) return;
      if (this._sseAlive) return;
      void this.refresh();
    }, 4000);
    if (!this._onVisibility) {
      this._onVisibility = (): void => {
        if (!document.hidden) void this.refresh();
      };
      document.addEventListener('visibilitychange', this._onVisibility);
    }
  }

  stopPolling(): void {
    if (this.pollHandle) {
      clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
    if (this._onVisibility) {
      document.removeEventListener('visibilitychange', this._onVisibility);
      this._onVisibility = undefined;
    }
    this._stopSseStream();
  }

  async refresh(): Promise<void> {
    try {
      const data = await api.listAgents();
      const agents: Agent[] = Array.isArray(data)
        ? data as Agent[]
        : (data && typeof data === 'object' && Array.isArray((data as { agents?: unknown }).agents)
            ? (data as { agents: Agent[] }).agents
            : []);
      this.agents = agents;
      this.renderList();
      document.dispatchEvent(new CustomEvent('grok-remote:agents-refresh', { detail: agents }));
    } catch (e) {
      this.agents = [];
      const msg = e instanceof Error ? e.message : String(e);
      this.renderList(msg);
    }
  }

  async refreshFolders(): Promise<void> {
    try {
      const data = await api.folders.list() as unknown;
      this.folders = Array.isArray(data) ? data as Folder[] : [];
    } catch {
      this.folders = [];
    }
  }

  renderList(errorMessage?: string): void {
    this._closeContextMenu();
    // If an SSE-triggered re-render lands mid-drag, kill the drag so we don't
    // leave a ghost stranded against a recycled source element.
    if (this._drag) this._cancelDrag();
    this.activeList.replaceChildren();
    if (this.searchClearBtn) this.searchClearBtn.hidden = !this.search;
    // Drop stale ids from multi-selection so the footer count stays accurate.
    if (this.multiSelection.size > 0) {
      const liveIds = new Set(this.agents.map((a) => a.id));
      const before = this.multiSelection.size;
      for (const id of [...this.multiSelection]) {
        if (!liveIds.has(id)) this.multiSelection.delete(id);
      }
      if (before !== this.multiSelection.size && this.selectionAnchor && !liveIds.has(this.selectionAnchor)) {
        this.selectionAnchor = null;
      }
    }
    this._updateMultiFooter();

    if (errorMessage) {
      this.activeList.appendChild(el('div', { class: 'agents-empty agents-empty--err' },
        'backend unreachable'));
      return;
    }

    const visible = this._sortAgents(this.agents).filter((a) => this._isVisible(a));

    // Bucket every visible agent by folder id. The system "Archived" folder
    // collects every archived agent automatically (the backend assigns them
    // when the archived flag flips).
    const folderById = new Map<string, Folder>();
    for (const f of this.folders) folderById.set(f.id, f);
    const folderOfAgent = new Map<string, string>();
    for (const f of this.folders) for (const aid of f.agentIds) folderOfAgent.set(aid, f.id);

    const topLevel: Agent[] = [];
    const buckets = new Map<string, Agent[]>();
    for (const a of visible) {
      let fid = folderOfAgent.get(a.id);
      // Belt-and-suspenders: an archived agent must always live in the Archived
      // folder, even if the backend folder side-effect lagged or the folder file
      // is out of sync. Without this, archived agents fall to top level.
      if (a.archived && fid !== ARCHIVED_FOLDER_ID && folderById.has(ARCHIVED_FOLDER_ID)) {
        fid = ARCHIVED_FOLDER_ID;
      }
      if (fid && folderById.has(fid)) {
        if (!buckets.has(fid)) buckets.set(fid, []);
        buckets.get(fid)!.push(a);
      } else {
        topLevel.push(a);
      }
    }

    if (!this.agents.length) {
      this.activeList.appendChild(this.empty);
      return;
    }
    if (!visible.length && this.folders.length === 0) {
      this.activeList.appendChild(this.noMatch);
      return;
    }

    const filtering = this._isFiltering();
    if (this.folders.length > 0) {
      if (!filtering || topLevel.length > 0) {
        this.activeList.appendChild(this.renderGroup(TOP_LEVEL_ID, 'Top level', topLevel, null));
      }
      for (const f of this.folders) {
        const items = buckets.get(f.id) || [];
        if (filtering && items.length === 0) continue;
        this.activeList.appendChild(this.renderGroup(f.id, f.name, items, f));
      }
      if (!this.activeList.childElementCount) this.activeList.appendChild(this.noMatch);
    } else {
      if (!topLevel.length) this.activeList.appendChild(this.noMatch);
      else for (const a of topLevel) this.activeList.appendChild(this.renderItem(a, false));
    }

    // Later folders must paint over earlier ones in the same sticky slot.
    this.activeList.querySelectorAll<HTMLElement>('.folder-header').forEach((h, i) => {
      h.style.zIndex = String(2 + i);
    });
  }

  private renderGroup(groupId: string, label: string, items: Agent[], folder: Folder | null): DocumentFragment {
    const isTopLevel = groupId === TOP_LEVEL_ID;
    const isSystem = !!(folder && folder.system);
    const isArchived = folder?.id === ARCHIVED_FOLDER_ID;
    // System (archived) folders auto-collapse by default until the user toggles them.
    const isCollapsed = isArchived
      ? !this.collapsed.has(`open:${groupId}`)
      : this.collapsed.has(groupId);
    const folderId = isTopLevel ? null : groupId;

    const caret = el('span', {
      class: `folder-caret${isCollapsed ? ' is-collapsed' : ''}`,
      html: iconHtml('chevron-down'),
    });
    const glyph = el('span', {
      class: 'folder-glyph',
      html: iconHtml(isArchived ? 'archive' : isTopLevel ? 'inbox' : 'folder'),
    });
    const labelEl = el('span', { class: 'folder-name' }, label);
    const count = el('span', { class: 'folder-count' }, String(items.length));

    const deleteBtn = (!isTopLevel && !isSystem) ? el('button', {
      class: 'folder-delete',
      type: 'button',
      title: 'Delete folder (conversations move back to top level)',
      'aria-label': `Delete folder ${label}`,
      onclick: async (ev: MouseEvent) => {
        ev.stopPropagation();
        const ok = await openPromptSheet({
          title: 'Delete folder?',
          hint: `"${label}" will be removed. Conversations move back to the top level.`,
          icon: 'folder',
          ask: false,
          danger: true,
          confirmLabel: 'Delete folder',
        });
        if (ok == null) return;
        try {
          await api.folders.remove(folderId!);
          await this.refreshFolders();
          this.renderList();
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          this._toast(`Couldn't delete folder: ${msg}`);
        }
      },
    },
      el('span', { html: iconHtml('trash') }),
    ) as HTMLButtonElement : null;

    const header = el('div', {
      class: `folder-header${isTopLevel ? ' folder-header--top' : ''}${isSystem ? ' folder-header--system' : ''}`,
      'data-folder-id': groupId,
      onclick: (ev: MouseEvent) => {
        ev.stopPropagation();
        if (isArchived) {
          // Inverse key so the default state is collapsed.
          const k = `open:${groupId}`;
          if (this.collapsed.has(k)) this.collapsed.delete(k); else this.collapsed.add(k);
        } else {
          if (isCollapsed) this.collapsed.delete(groupId); else this.collapsed.add(groupId);
        }
        saveCollapsed(this.collapsed);
        this.renderList();
      },
      ondblclick: (ev: MouseEvent) => {
        if (isTopLevel || isSystem || !folder) return;
        ev.preventDefault();
        ev.stopPropagation();
        this.beginInlineRenameFolder(folder, labelEl as HTMLElement);
      },
    }, caret, glyph, labelEl, count, deleteBtn) as HTMLElement;

    const body = el('div', { class: 'folder-body' }) as HTMLElement;
    if (!isCollapsed) {
      if (items.length === 0) {
        body.appendChild(el('div', { class: 'folder-empty' },
          isTopLevel ? 'Drop a chat here to take it out of a folder' : 'Drop chats here'));
      } else {
        for (const a of items) body.appendChild(this.renderItem(a, false));
      }
    }

    // Header + body are siblings in .agents-list (no wrapping box) so
    // every header shares the list as its sticky containing block and
    // later folders can cover earlier ones at the same top: 0 slot.
    body.setAttribute('data-folder-id', groupId);
    const frag = document.createDocumentFragment();
    frag.append(header, body);
    return frag;
  }

  private beginInlineRenameFolder(folder: Folder, labelEl: HTMLElement): void {
    const parent = labelEl.parentElement;
    if (!parent) return;
    const input = el('input', {
      class: 'folder-rename-input',
      type: 'text',
      value: folder.name,
      onclick: (ev: MouseEvent) => ev.stopPropagation(),
      onkeydown: (ev: KeyboardEvent) => {
        if (ev.key === 'Enter') { ev.preventDefault(); (ev.target as HTMLInputElement).blur(); }
        else if (ev.key === 'Escape') { ev.preventDefault(); (input as HTMLInputElement).value = folder.name; (ev.target as HTMLInputElement).blur(); }
      },
      onblur: async (ev: FocusEvent) => {
        const next = ((ev.target as HTMLInputElement).value || '').trim();
        if (!next || next === folder.name) { this.renderList(); return; }
        try {
          await api.folders.update(folder.id, { name: next });
          await this.refreshFolders();
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          alert(`rename folder failed: ${msg}`);
        }
        this.renderList();
      },
    }) as HTMLInputElement;
    parent.replaceChild(input, labelEl);
    input.focus();
    input.select();
  }

  private beginInlineRenameAgent(a: Agent, nameEl: HTMLElement): void {
    const parent = nameEl.parentElement;
    if (!parent) return;
    const input = el('input', {
      class: 'agent-rename-input',
      type: 'text',
      value: a.name || '',
      onclick: (ev: MouseEvent) => ev.stopPropagation(),
      onkeydown: (ev: KeyboardEvent) => {
        if (ev.key === 'Enter') { ev.preventDefault(); (ev.target as HTMLInputElement).blur(); }
        else if (ev.key === 'Escape') { ev.preventDefault(); (input as HTMLInputElement).value = a.name || ''; (input as HTMLInputElement).dataset['cancel'] = '1'; (ev.target as HTMLInputElement).blur(); }
      },
      onblur: async (ev: FocusEvent) => {
        const target = ev.target as HTMLInputElement;
        const cancel = target.dataset['cancel'] === '1';
        const next = (target.value || '').trim();
        if (cancel || !next || next === a.name) { this.renderList(); return; }
        try {
          await api.updateAgent(a.id, { name: next });
          await this.refresh();
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          alert(`rename failed: ${msg}`);
          this.renderList();
        }
      },
    }) as HTMLInputElement;
    parent.replaceChild(input, nameEl);
    input.focus();
    input.select();
  }

  renderItem(a: Agent, isArchived: boolean): HTMLElement {
    const isSelected = a.id === this.selectedId;
    const status = a.status || 'idle';
    const isDisconnected = status === 'disconnected' || status === 'exited' || status === 'observed';
    const dot = el('span', { class: `agent-dot agent-dot--${status}` });

    const starBtn = el('button', {
      class: `agent-star agent-row-action${a.starred ? ' is-on' : ''}`,
      title: a.starred ? 'unstar' : 'star',
      type: 'button',
      onclick: async (ev: MouseEvent) => {
        ev.stopPropagation();
        starBtn.disabled = true;
        try {
          await api.updateAgent(a.id, { starred: !a.starred });
          await this.refresh();
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          alert(`star failed: ${msg}`);
        } finally {
          starBtn.disabled = false;
        }
      },
    }, a.starred ? '★' : '☆') as HTMLButtonElement;

    const nameEl = el('span', {
      class: 'agent-name',
      ondblclick: (ev: MouseEvent) => {
        if (isArchived) return;
        ev.preventDefault();
        ev.stopPropagation();
        this.beginInlineRenameAgent(a, nameEl as HTMLElement);
      },
    }, a.name || a.id.slice(0, 8)) as HTMLElement;

    let closeArea: HTMLElement | null;
    if (!isArchived) {
      const archiveBtn = el('button', {
        class: 'agent-archive agent-row-action',
        type: 'button',
        title: 'archive (move to archived; you can restore or delete later)',
        onclick: async (ev: MouseEvent) => {
          ev.stopPropagation();
          archiveBtn.disabled = true;
          try {
            await api.updateAgent(a.id, { archived: true });
            if (this.selectedId === a.id) this.selectedId = null;
            await this.refresh();
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            alert(`archive failed: ${msg}`);
          } finally {
            archiveBtn.disabled = false;
          }
        },
      }, '×') as HTMLButtonElement;
      closeArea = archiveBtn;
    } else {
      const restoreBtn = el('button', {
        class: 'agent-restore agent-row-action',
        type: 'button',
        title: 'restore from archive',
        onclick: async (ev: MouseEvent) => {
          ev.stopPropagation();
          restoreBtn.disabled = true;
          try {
            await api.updateAgent(a.id, { archived: false });
            await this.refresh();
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            alert(`restore failed: ${msg}`);
          } finally {
            restoreBtn.disabled = false;
          }
        },
      }, 'restore') as HTMLButtonElement;
      const deleteBtn = el('button', {
        class: 'agent-delete-forever agent-row-action',
        type: 'button',
        title: 'Remove this conversation from grok-remote. The official Grok session files are kept unless you opt in.',
        onclick: async (ev: MouseEvent) => {
          ev.stopPropagation();
          if (!confirm(DELETE_OVERLAY_CONFIRM)) return;
          const deleteTuiSession = confirm(DELETE_TUI_CONFIRM);
          try {
            await api.deleteAgent(a.id, { deleteTuiSession });
            if (typeof this.onDelete === 'function') this.onDelete(a.id);
            if (this.selectedId === a.id) this.selectedId = null;
            await this.refresh();
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            alert(`delete failed: ${msg}`);
          }
        },
      }, 'delete') as HTMLButtonElement;
      closeArea = el('div', { class: 'agent-archived-actions' }, restoreBtn, deleteBtn) as HTMLElement;
    }

    const inflightChip = (typeof a.inFlight === 'number' && a.inFlight > 0)
      ? el('span', { class: 'agent-inflight', title: `${a.inFlight} tool call${a.inFlight === 1 ? '' : 's'} in flight` },
          el('span', { class: 'agent-inflight-dot' }),
          `${a.inFlight} tool${a.inFlight === 1 ? '' : 's'}`)
      : null;
    const tokenChip = (typeof a.totalTokens === 'number' && a.totalTokens > 0)
      ? el('span', { class: 'agent-tokens', title: `${a.totalTokens.toLocaleString()} tokens in context` }, fmtTokens(a.totalTokens))
      : null;
    const statusChip = el('span', { class: `agent-status agent-status--${status}` }, STATUS_LABEL[status] || status);

    const metaChildren: (HTMLElement | null)[] = [statusChip];
    if (inflightChip) metaChildren.push(inflightChip);
    if (tokenChip) metaChildren.push(tokenChip);

    const isMulti = this.multiSelection.has(a.id);
    const item = el('div', {
      class: [
        'agent-item',
        isSelected     ? 'agent-item--selected' : '',
        isMulti        ? 'agent-item--multi' : '',
        isDisconnected ? 'agent-item--off' : '',
        isArchived     ? 'agent-item--archived' : '',
        a.starred      ? 'agent-item--starred' : '',
      ].filter(Boolean).join(' '),
      'data-agent-id': a.id,
      oncontextmenu: (ev: MouseEvent) => {
        ev.preventDefault();
        ev.stopPropagation();
        this._showContextMenu(a, ev.clientX, ev.clientY);
      },
    },
      el('div', { class: 'agent-item-top' },
        dot,
        starBtn,
        nameEl,
        closeArea,
      ),
      el('div', { class: 'agent-item-meta' }, ...metaChildren),
    ) as HTMLElement;

    // Treat genuinely-archived agents as non-draggable regardless of the
    // legacy parameter (the folder system handles archived now).
    const treatAsArchived = isArchived || !!a.archived;
    this._attachDragHandlers(item, a, treatAsArchived);
    return item;
  }

  // Pointer-events drag/drop. Mouse/pen drag activates as soon as horizontal
  // motion crosses MOUSE_DRAG_THRESH; touch uses a long-press so vertical
  // scroll still works. We do NOT setPointerCapture until drag actually
  // activates: capturing on pointerdown was breaking the row's own click-to-
  // select because pointer capture redirects subsequent events away from any
  // ancestor click target until release.
  private _attachDragHandlers(item: HTMLElement, agent: Agent, isArchived: boolean): void {
    const agentId = agent.id;

    const onPointerDown = (ev: PointerEvent): void => {
      const target = ev.target as HTMLElement | null;
      const tgtTag = target ? `${target.tagName.toLowerCase()}.${target.className || ''}` : '(none)';
      const matchedAction = target?.closest('.agent-row-action, input, select, textarea')?.tagName || null;
      console.debug(`[drag] pointerdown id=${agentId} button=${ev.button} type=${ev.pointerType} target=${tgtTag} actionMatch=${matchedAction}`);
      if (ev.button !== undefined && ev.button !== 0) {
        console.debug(`[drag] press-skipped reason=not-primary-button button=${ev.button}`);
        return;
      }
      // Only the explicit action buttons (star, archive, restore, delete-forever)
      // and any input/select inside the row (rename) opt out of drag. The rest
      // of the row body, including the name text, should drag freely.
      if (target && target.closest('.agent-row-action, input, select, textarea')) {
        console.debug(`[drag] press-skipped reason=action-or-form-field match=${matchedAction}`);
        return;
      }
      this._cancelDrag();
      const drag = {
        agentId,
        pointerId: ev.pointerId,
        pointerType: ev.pointerType || 'mouse',
        startX: ev.clientX,
        startY: ev.clientY,
        startTime: performance.now(),
        sourceEl: item,
        ghost: null as HTMLElement | null,
        active: false,
        captured: false,
        pressTimer: null as number | null,
        moved: false,
      };
      this._drag = drag;
      if (isArchived) {
        // Archived rows don't drag (drop targets are non-archived folders),
        // but we still want click-to-select to work via pointerup below.
        return;
      }
      if (drag.pointerType === 'touch') {
        // Touch: wait for the long-press; mouse skips the timer entirely so
        // click-and-drag feels immediate.
        drag.pressTimer = window.setTimeout(() => {
          if (this._drag === drag) this._activateDrag(drag.startX, drag.startY);
        }, LONG_PRESS_MS);
      }
    };

    const onPointerMove = (ev: PointerEvent): void => {
      const drag = this._drag;
      if (!drag || drag.pointerId !== ev.pointerId) return;
      const dx = ev.clientX - drag.startX;
      const dy = ev.clientY - drag.startY;
      const moved = Math.hypot(dx, dy);
      if (!drag.active) {
        if (isArchived) {
          if (moved > MOUSE_DRAG_THRESH) drag.moved = true;
          return;
        }
        if (drag.pointerType === 'touch') {
          if (moved > TOUCH_MOVE_THRESH) {
            console.debug(`[drag] cancel reason=touch-scroll-intent moved=${moved.toFixed(1)}`);
            this._cancelDrag();
          }
          return;
        }
        if (Math.abs(dx) >= MOUSE_DRAG_THRESH || moved >= MOUSE_DRAG_THRESH * 2) {
          drag.moved = true;
          console.debug(`[drag] activate id=${drag.agentId} startX=${drag.startX} startY=${drag.startY} dx=${dx.toFixed(1)} dy=${dy.toFixed(1)}`);
          this._activateDrag(ev.clientX, ev.clientY);
        }
        return;
      }
      ev.preventDefault();
      this._moveGhost(ev.clientX, ev.clientY);
      this._highlightDropTarget(ev.clientX, ev.clientY);
    };

    const onPointerUp = (ev: PointerEvent): void => {
      const drag = this._drag;
      if (!drag || drag.pointerId !== ev.pointerId) return;
      if (drag.captured) {
        try { item.releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
      }
      if (drag.active) {
        const target = this._findDropTarget(ev.clientX, ev.clientY);
        console.debug(`[drag] up dropOn=${target} id=${drag.agentId}`);
        this._endDrag();
        if (target) void this._assignAgentToFolder(drag.agentId, target);
        return;
      }
      const dt = performance.now() - drag.startTime;
      const dx = Math.abs(ev.clientX - drag.startX);
      const dy = Math.abs(ev.clientY - drag.startY);
      this._cancelDrag();
      const isClick = dt < CLICK_MAX_MS * 4
        && dx < MOUSE_DRAG_THRESH
        && dy < MOUSE_DRAG_THRESH;
      if (isClick) {
        const tgt = ev.target as HTMLElement | null;
        if (tgt && tgt.closest('.agent-row-action, input, select, textarea')) {
          console.debug(`[drag] click-skipped reason=action-control`);
          return;
        }
        console.debug(`[drag] click-select id=${agentId} dt=${dt.toFixed(0)}ms`);
        this._handleRowClick(agentId, ev);
      }
    };

    const onPointerCancel = (ev: PointerEvent): void => {
      const drag = this._drag;
      if (!drag || drag.pointerId !== ev.pointerId) return;
      console.debug(`[drag] cancel reason=pointercancel id=${drag.agentId}`);
      this._cancelDrag();
    };

    item.addEventListener('pointerdown', onPointerDown);
    item.addEventListener('pointermove', onPointerMove);
    item.addEventListener('pointerup', onPointerUp);
    item.addEventListener('pointercancel', onPointerCancel);
  }

  private _activateDrag(clientX: number, clientY: number): void {
    const drag = this._drag;
    if (!drag || drag.active) return;
    drag.active = true;
    if (drag.pressTimer) { clearTimeout(drag.pressTimer); drag.pressTimer = null; }
    // Capture only now. Capturing on pointerdown was breaking taps because
    // the captured pointer's events bypass the row's click semantics.
    try {
      drag.sourceEl.setPointerCapture(drag.pointerId);
      drag.captured = true;
    } catch { /* ignore */ }
    const rect = drag.sourceEl.getBoundingClientRect();
    const ghost = drag.sourceEl.cloneNode(true) as HTMLElement;
    ghost.classList.add('agent-drag-ghost');
    ghost.style.position = 'fixed';
    ghost.style.left = `${rect.left}px`;
    ghost.style.top = `${rect.top}px`;
    ghost.style.width = `${rect.width}px`;
    ghost.style.pointerEvents = 'none';
    ghost.style.zIndex = '9999';
    document.body.appendChild(ghost);
    drag.ghost = ghost;
    drag.sourceEl.classList.add('agent-item--dragging');
    document.body.classList.add('agents-dragging');
    this._moveGhost(clientX, clientY);
    this._highlightDropTarget(clientX, clientY);
    if (navigator.vibrate) { try { navigator.vibrate(10); } catch { /* ignore */ } }
  }

  private _moveGhost(clientX: number, clientY: number): void {
    const drag = this._drag;
    if (!drag || !drag.ghost) return;
    const rect = drag.sourceEl.getBoundingClientRect();
    const offsetX = drag.startX - rect.left;
    const offsetY = drag.startY - rect.top;
    drag.ghost.style.left = `${clientX - offsetX}px`;
    drag.ghost.style.top  = `${clientY - offsetY}px`;
  }

  private _highlightDropTarget(clientX: number, clientY: number): void {
    const all = this.activeList.querySelectorAll<HTMLElement>('.folder-header');
    let hit: HTMLElement | null = null;
    for (const h of all) {
      const r = h.getBoundingClientRect();
      if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) {
        hit = h;
        break;
      }
    }
    for (const h of all) h.classList.toggle('folder-header--drop', h === hit);
  }

  private _findDropTarget(clientX: number, clientY: number): string | null {
    const all = this.activeList.querySelectorAll<HTMLElement>('.folder-header');
    for (const h of all) {
      const r = h.getBoundingClientRect();
      if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) {
        return h.getAttribute('data-folder-id');
      }
    }
    return null;
  }

  private _endDrag(): void {
    const drag = this._drag;
    if (!drag) return;
    if (drag.pressTimer) { clearTimeout(drag.pressTimer); drag.pressTimer = null; }
    if (drag.captured) {
      try { drag.sourceEl.releasePointerCapture(drag.pointerId); } catch { /* ignore */ }
    }
    if (drag.ghost && drag.ghost.parentNode) drag.ghost.parentNode.removeChild(drag.ghost);
    drag.sourceEl.classList.remove('agent-item--dragging');
    document.body.classList.remove('agents-dragging');
    this.activeList.querySelectorAll('.folder-header--drop').forEach((n) => n.classList.remove('folder-header--drop'));
    this._drag = null;
  }

  private _cancelDrag(): void {
    if (!this._drag) return;
    this._endDrag();
  }

  private async _assignAgentToFolder(agentId: string, groupId: string): Promise<void> {
    const folderId = groupId === TOP_LEVEL_ID ? null : groupId;
    console.debug(`[drag] assign id=${agentId} folder=${folderId}`);
    try {
      await api.agents.setFolder(agentId, folderId);
      console.debug(`[drag] assign-ok id=${agentId} folder=${folderId}`);
      await this.refreshFolders();
      this.renderList();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.debug(`[drag] assign-fail id=${agentId} folder=${folderId} err=${msg}`);
      alert(`move failed: ${msg}`);
    }
  }

  select(id: string): void {
    this.selectedId = id;
    this.renderList();
    if (typeof this.onSelect === 'function') this.onSelect(id);
  }

  private _handleRowClick(agentId: string, ev: PointerEvent | MouseEvent): void {
    const modified = ev.ctrlKey || ev.metaKey || ev.shiftKey;
    if (!modified) {
      // Plain click: clear any multi-selection, then navigate.
      if (this.multiSelection.size > 0) {
        this.multiSelection = new Set();
      }
      this.selectionAnchor = agentId;
      this.select(agentId);
      return;
    }
    // Modifier click: extend/toggle multi-selection without navigating.
    const order = this._visibleOrderedIds();
    const seed = this.multiSelection.size > 0
      ? this.multiSelection
      : (this.selectedId ? new Set([this.selectedId]) : new Set<string>());
    const { next, anchor } = computeSelection(
      seed,
      this.selectionAnchor || this.selectedId,
      agentId,
      { ctrlKey: ev.ctrlKey, metaKey: ev.metaKey, shiftKey: ev.shiftKey },
      order,
    );
    this.multiSelection = next;
    this.selectionAnchor = anchor;
    // If the user collapsed back to exactly one row, treat it like a normal
    // selection so the chat opens it.
    if (this.multiSelection.size === 1) {
      const only = [...this.multiSelection][0]!;
      this.multiSelection = new Set();
      this.selectedId = only;
      this.renderList();
      if (typeof this.onSelect === 'function') this.onSelect(only);
      return;
    }
    this.renderList();
  }

  private _showContextMenu(a: Agent, _clientX: number, _clientY: number): void {
    this._closeContextMenu();

    // Decide whether this menu acts on a single row or the multi-selection.
    // Right-clicking outside the current multi-selection clears it and acts
    // on the single clicked row, matching every familiar file manager.
    let targetIds: string[];
    if (this.multiSelection.size > 1 && this.multiSelection.has(a.id)) {
      targetIds = [...this.multiSelection];
    } else {
      if (this.multiSelection.size > 0) {
        this.multiSelection = new Set();
        this.renderList();
      }
      targetIds = [a.id];
    }
    const targetAgents = targetIds
      .map((id) => this.agents.find((x) => x.id === id))
      .filter((x): x is Agent => !!x);
    const bulk = targetAgents.length > 1;

    const items: HTMLElement[] = [];

    const mkItem = (label: string, run: () => void, opts?: {
      danger?: boolean;
      icon?: string;
      current?: boolean;
    }): HTMLElement => {
      return el('button', {
        class: [
          'ctx-sheet__item',
          opts?.danger ? 'is-danger' : '',
          opts?.current ? 'is-on' : '',
        ].filter(Boolean).join(' '),
        type: 'button',
        onclick: (ev: MouseEvent) => {
          ev.stopPropagation();
          this._closeContextMenu();
          run();
        },
      },
        el('span', { class: 'ctx-sheet__ico', html: opts?.icon ? iconHtml(opts.icon) : '' }),
        el('span', { class: 'ctx-sheet__lbl' }, label),
        opts?.current ? el('span', { class: 'ctx-sheet__check', html: iconHtml('check') }) : null,
      ) as HTMLElement;
    };

    const mkSep = (): HTMLElement => el('div', { class: 'ctx-sheet__sep' }) as HTMLElement;

    // Majority-vote on the current starred / archived state so the action
    // label reads naturally for the bulk case ("Star all" if most aren't
    // already starred).
    const starredCount   = targetAgents.filter((x) => !!x.starred).length;
    const archivedCount  = targetAgents.filter((x) => !!x.archived).length;
    const majorityStarred  = starredCount  > targetAgents.length / 2;
    const majorityArchived = archivedCount > targetAgents.length / 2;

    const starLabel = bulk
      ? (majorityStarred ? `Unstar ${targetAgents.length}` : `Star ${targetAgents.length}`)
      : (a.starred ? 'Unstar' : 'Star');
    items.push(mkItem(starLabel, async () => {
      const nextStarred = bulk ? !majorityStarred : !a.starred;
      try {
        await Promise.all(targetAgents.map((x) => api.updateAgent(x.id, { starred: nextStarred })));
        await this.refresh();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        alert(`star failed: ${msg}`);
      }
    }, { icon: 'star' }));

    if (!bulk) {
      items.push(mkItem('Rename', () => {
        const node = this.activeList.querySelector<HTMLElement>(
          `.agent-item[data-agent-id="${CSS.escape(a.id)}"] .agent-name`,
        );
        if (node) this.beginInlineRenameAgent(a, node);
      }, { icon: 'pencil' }));
    }

    items.push(mkSep());

    // Move to folder. Inline the candidate folders right in the menu (a single
    // flat list keeps the implementation small + works fine on touch). System
    // folders (Archived) are excluded; "Archive" handles that case.
    const moveTargets = this.folders.filter((f) => !f.system);
    const currentFolder = (() => {
      // For single-row, indicate the folder the row currently lives in.
      if (bulk) return null;
      for (const f of this.folders) if (f.agentIds.includes(a.id)) return f.id;
      return null;
    })();

    if (moveTargets.length > 0 || currentFolder) {
      const heading = bulk ? `Move ${targetAgents.length} to` : 'Move to';
      items.push(el('div', { class: 'ctx-sheet__heading' }, heading) as HTMLElement);
      items.push(mkItem('Top level', async () => {
        try {
          await Promise.all(targetAgents.map((x) => api.agents.setFolder(x.id, null)));
          await this.refreshFolders();
          this.renderList();
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          alert(`move failed: ${msg}`);
        }
      }, { icon: 'inbox', current: !bulk && !currentFolder }));
      for (const f of moveTargets) {
        items.push(mkItem(f.name, async () => {
          try {
            await Promise.all(targetAgents.map((x) => api.agents.setFolder(x.id, f.id)));
            await this.refreshFolders();
            this.renderList();
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            alert(`move failed: ${msg}`);
          }
        }, { icon: 'folder', current: !bulk && currentFolder === f.id }));
      }
      items.push(mkSep());
    }

    const archiveLabel = bulk
      ? (majorityArchived ? `Unarchive ${targetAgents.length}` : `Archive ${targetAgents.length}`)
      : (a.archived ? 'Unarchive' : 'Archive');
    items.push(mkItem(archiveLabel, async () => {
      const nextArchived = bulk ? !majorityArchived : !a.archived;
      try {
        await Promise.all(targetAgents.map((x) => api.updateAgent(x.id, { archived: nextArchived })));
        if (nextArchived) {
          for (const x of targetAgents) {
            if (this.selectedId === x.id) this.selectedId = null;
          }
        }
        await this.refresh();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        alert(`archive failed: ${msg}`);
      }
    }, { icon: 'archive' }));

    if (!bulk) {
      items.push(mkItem('Copy id', async () => {
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(a.id);
          } else {
            const ta = document.createElement('textarea');
            ta.value = a.id;
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); } catch { /* ignore */ }
            document.body.removeChild(ta);
          }
        } catch {
          alert('copy failed');
        }
      }, { icon: 'copy' }));
    }

    items.push(mkSep());

    const deleteLabel = bulk ? `Delete ${targetAgents.length}…` : 'Delete…';
    items.push(mkItem(deleteLabel, async () => {
      const prompt = bulk
        ? `Remove ${targetAgents.length} conversations from grok-remote. The official Grok session files are kept unless you opt in.`
        : DELETE_OVERLAY_CONFIRM;
      if (!confirm(prompt)) return;
      const deleteTuiSession = confirm(DELETE_TUI_CONFIRM);
      try {
        await Promise.all(targetAgents.map((x) => api.deleteAgent(x.id, { deleteTuiSession })));
        if (typeof this.onDelete === 'function') {
          for (const x of targetAgents) this.onDelete(x.id);
        }
        for (const x of targetAgents) {
          if (this.selectedId === x.id) this.selectedId = null;
        }
        if (bulk) this.multiSelection = new Set();
        await this.refresh();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        alert(`delete failed: ${msg}`);
      }
    }, { danger: true, icon: 'trash' }));

    const title = bulk
      ? `${targetAgents.length} conversations`
      : (a.name || a.id.slice(0, 8));
    const kicker = bulk ? 'Selected' : 'Conversation';

    const menu = el('div', {
      class: 'tui-sheet ctx-sheet',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': title,
      onclick: (ev: MouseEvent) => ev.stopPropagation(),
      oncontextmenu: (ev: MouseEvent) => { ev.preventDefault(); this._closeContextMenu(); },
    },
      el('div', {
        class: 'tui-sheet__backdrop ctx-sheet__backdrop',
        onclick: () => this._closeContextMenu(),
      }),
      el('div', { class: 'ctx-sheet__card' },
        el('div', { class: 'ctx-sheet__handle', 'aria-hidden': 'true' }),
        el('header', { class: 'ctx-sheet__head' },
          el('p', { class: 'ctx-sheet__kicker' }, kicker),
          el('h2', { class: 'ctx-sheet__title' }, title),
        ),
        el('div', { class: 'ctx-sheet__list', role: 'menu' }, ...items),
      ),
    ) as HTMLElement;

    document.body.appendChild(menu);
    this._ctxMenu = menu;

    const onDocPointerDown = (ev: PointerEvent): void => {
      const tgt = ev.target as Node | null;
      if (tgt && menu.contains(tgt)) return;
      this._closeContextMenu();
    };
    const onDocContextMenu = (ev: MouseEvent): void => {
      const tgt = ev.target as Node | null;
      if (tgt && menu.contains(tgt)) return;
      // Let a fresh contextmenu open the new one; just close this one now.
      this._closeContextMenu();
    };
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        this._closeContextMenu();
      }
    };
    // Fire on the *next* tick so the contextmenu event that opened us does
    // not immediately close it.
    setTimeout(() => {
      document.addEventListener('pointerdown', onDocPointerDown, true);
      document.addEventListener('contextmenu', onDocContextMenu, true);
      document.addEventListener('keydown', onKey, true);
    }, 0);
    this._ctxCleanup = () => {
      document.removeEventListener('pointerdown', onDocPointerDown, true);
      document.removeEventListener('contextmenu', onDocContextMenu, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }

  private _closeContextMenu(): void {
    if (this._ctxCleanup) { try { this._ctxCleanup(); } catch { /* ignore */ } this._ctxCleanup = null; }
    if (this._ctxMenu && this._ctxMenu.parentNode) this._ctxMenu.parentNode.removeChild(this._ctxMenu);
    this._ctxMenu = null;
  }
}
