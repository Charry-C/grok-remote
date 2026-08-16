// grok-remote dashboard entry point.

import Split from 'split.js';
import { api } from './lib/api.js';
import { AgentsSidebar } from './views/agents.js';
import { ChatView } from './views/chat.js';
import { el } from './lib/render.js';
import { registerPwa } from './lib/pwa.js';
import { applyTheme, getTheme } from './lib/themes.js';
import { iconHtml } from './lib/icons.js';
import { loadLastAgent } from './lib/last-agent.js';
import {
  PRODUCT_NAME,
  type TopbarContext,
  connectionActionFor,
  connectionConfirmFor,
  contextFromAgent,
  documentTitleFor,
} from './lib/topbar.js';
import { openPromptSheet } from './views/prompt-sheet.js';

interface Agent {
  id: string;
  name?: string;
  status?: string;
  inFlight?: number;
  lastSessionId?: string | null;
  sessionId?: string | null;
  heldBy?: string | null;
  [k: string]: unknown;
}

type Route =
  | { name: 'home' }
  | { name: 'chat'; agentId: string }
  | { name: 'redirect'; to: string };

applyTheme(getTheme());

function syncThemeToggle(name: string): void {
  document.querySelectorAll<HTMLElement>('[data-appearance]').forEach((node) => {
    const on = node.getAttribute('data-appearance') === name;
    node.classList.toggle('is-on', on);
    node.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

window.addEventListener('storage', (ev: StorageEvent) => {
  if (ev.key === 'grok-remote.theme') {
    applyTheme(getTheme());
    syncThemeToggle(getTheme());
  }
});
window.addEventListener('grok-remote:theme-change', () => {
  syncThemeToggle(getTheme());
});

function setStatus(kind: string, text: string): void {
  const status = document.getElementById('status');
  const pill = document.getElementById('status-pill');
  const txt  = document.getElementById('status-text');
  if (!status || !pill || !txt) return;
  status.className = `status status--${kind}`;
  status.title = text;
  pill.className = `status-dot status-dot--${kind}`;
  pill.textContent = '';
  txt.textContent = kind === 'ok' ? 'ok' : text;
}

let lastTopbarCtx: TopbarContext = { kind: 'home', title: PRODUCT_NAME };
let anyAgentBusy = false;

function paintDocumentTitle(): void {
  const want = documentTitleFor(lastTopbarCtx, anyAgentBusy);
  if (document.title !== want) document.title = want;
}

function applyTopbar(ctx: TopbarContext): void {
  lastTopbarCtx = ctx;
  const root = document.querySelector('.topbar');
  const titleEl = document.getElementById('topbar-title') as HTMLButtonElement | null;
  const titleRow = document.getElementById('topbar-title-row');
  const metaEl = document.getElementById('topbar-meta') as HTMLElement | null;
  const liveEl = document.getElementById('topbar-live') as HTMLButtonElement | null;
  const liveLabel = document.getElementById('topbar-live-label');
  const modelEl = document.getElementById('topbar-model') as HTMLElement | null;
  const cwdBtn = document.getElementById('topbar-cwd') as HTMLButtonElement | null;

  if (root) root.setAttribute('data-kind', ctx.kind);

  if (titleEl) {
    titleEl.textContent = ctx.title;
    titleEl.disabled = true;
    if (titleRow) titleRow.classList.remove('is-action');
    titleEl.removeAttribute('title');
    titleEl.setAttribute('aria-label', ctx.title);
  }

  const showLive = !!(ctx.kind === 'chat' && ctx.live);
  if (liveEl && liveLabel) {
    liveEl.hidden = !showLive;
    if (ctx.live) {
      liveEl.className = `topbar-live topbar-live--${ctx.live.kind}`;
      liveLabel.textContent = ctx.live.label;
      const action = ctx.connectionAction || 'none';
      liveEl.disabled = action === 'none';
      const title = action === 'connect'
        ? 'Reconnect this conversation'
        : action === 'disconnect'
          ? 'Disconnect this conversation'
          : (ctx.live.label === 'TUI · 只读'
            ? 'TUI is using this session · read-only'
            : ctx.live.label);
      liveEl.title = title;
      liveEl.setAttribute('aria-label', title);
    }
  }

  if (modelEl) {
    modelEl.hidden = true;
    modelEl.textContent = '';
  }
  if (cwdBtn) {
    cwdBtn.hidden = true;
    cwdBtn.dataset.cwd = '';
  }

  if (metaEl) metaEl.hidden = true;
  paintDocumentTitle();
}

async function pingHello(): Promise<void> {
  try {
    await api.hello();
    setStatus('ok', 'api up');
  } catch {
    setStatus('fail', 'api unreachable');
  }
}

function parseRoute(): Route {
  const h = (location.hash || '#/').replace(/^#/, '');
  const parts = h.split('/').filter(Boolean);
  if (!parts.length) return { name: 'home' };
  if (parts[0] === 'agents' && parts[1]) return { name: 'chat', agentId: parts[1] };
  if (parts[0] === 'settings' || parts[0] === 'memory' || parts[0] === 'leaders'
      || parts[0] === 'sessions' || parts[0] === 'health' || parts[0] === 'skills'
      || parts[0] === 'subagents' || parts[0] === 'hooks' || parts[0] === 'plugins'
      || parts[0] === 'marketplaces' || parts[0] === 'mcp' || parts[0] === 'lsp'
      || parts[0] === 'models' || parts[0] === 'worktrees' || parts[0] === 'import'
      || parts[0] === 'setup' || parts[0] === 'flow' || parts[0] === 'trace') {
    return { name: 'redirect', to: '#/' };
  }
  return { name: 'home' };
}

function navigate(hash: string): void {
  if (location.hash === hash) {
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    location.hash = hash;
  }
}

function lockDrawerViewport(): void {
  // Snapshot the chat column — not the window — so the topbar is not
  // counted twice. Search-focus keyboard resize then cannot lift the
  // composer into the gap beside the drawer.
  const app = document.getElementById('app');
  const h = app ? Math.round(app.getBoundingClientRect().height) : window.innerHeight;
  document.documentElement.style.setProperty('--drawer-lock-h', `${h}px`);
}
function unlockDrawerViewport(): void {
  document.documentElement.style.removeProperty('--drawer-lock-h');
}

function openDrawer(): void {
  lockDrawerViewport();
  document.body.setAttribute('data-drawer-open', '');
  const btn = document.getElementById('hamburger-btn');
  if (btn) btn.setAttribute('aria-expanded', 'true');
  const bd = document.getElementById('drawer-backdrop') as HTMLElement | null;
  if (bd) bd.hidden = false;
}
function closeDrawer(): void {
  document.body.removeAttribute('data-drawer-open');
  unlockDrawerViewport();
  const btn = document.getElementById('hamburger-btn');
  if (btn) btn.setAttribute('aria-expanded', 'false');
  const bd = document.getElementById('drawer-backdrop') as HTMLElement | null;
  if (bd) bd.hidden = true;
}
function toggleDrawer(): void {
  if (document.body.hasAttribute('data-drawer-open')) closeDrawer();
  else openDrawer();
}

function mountDashboard(): void {
  const host = document.getElementById('app');
  if (!host) return;
  host.replaceChildren();
  const backdrop = el('div', {
    class: 'drawer-backdrop',
    id: 'drawer-backdrop',
    hidden: true,
  });
  host.appendChild(backdrop);

  let currentAgent: Agent | null = null;
  const chat = new ChatView();
  const sidebar = new AgentsSidebar({
    onSelect: (id: string) => {
      chat.focusConversation();
      navigate(`#/agents/${encodeURIComponent(id)}`);
    },
    onCreate: () => { chat.focusConversation(); },
    onDelete: (id: string) => {
      if (currentAgent && currentAgent.id === id) {
        currentAgent = null;
        navigate('#/');
      }
    },
  });

  const mainHost = el('div', { class: 'main-pane' });
  const shell = el('div', { class: 'dashboard' });
  host.appendChild(shell);

  const splitHost   = el('div', { class: 'split-host' });
  const sidebarPane = el('div', { class: 'sidebar-pane' });
  const mainPane    = el('div', { class: 'main-pane-wrap' });
  sidebar.mount(sidebarPane);
  mainPane.appendChild(mainHost);
  splitHost.appendChild(sidebarPane);
  splitHost.appendChild(mainPane);
  shell.appendChild(splitHost);

  installOuterSplit(splitHost, sidebarPane, mainPane);

  const brandLink = document.getElementById('brand-link');
  if (brandLink) {
    brandLink.addEventListener('click', (ev) => {
      ev.preventDefault();
      navigate('#/');
      closeDrawer();
    });
  }

  const liveEl = document.getElementById('topbar-live') as HTMLButtonElement | null;
  let connectionConfirmOpen = false;
  if (liveEl) {
    liveEl.addEventListener('click', async (ev) => {
      ev.preventDefault();
      if (liveEl.disabled || connectionConfirmOpen) return;
      const copy = connectionConfirmFor(lastTopbarCtx.connectionAction || 'none');
      if (!copy) {
        document.dispatchEvent(new CustomEvent('grok-remote:toggle-connection'));
        return;
      }
      connectionConfirmOpen = true;
      try {
        const ok = await openPromptSheet({
          title: copy.title,
          hint: copy.hint,
          icon: 'none',
          ask: false,
          danger: copy.danger,
          confirmLabel: copy.confirmLabel,
        });
        if (ok == null) return;
        document.dispatchEvent(new CustomEvent('grok-remote:toggle-connection'));
      } finally {
        connectionConfirmOpen = false;
      }
    });
  }

  document.addEventListener('grok-remote:topbar-context', (ev: Event) => {
    const detail = (ev as CustomEvent<TopbarContext>).detail;
    if (detail && detail.kind) applyTopbar(detail);
  });
  document.addEventListener('grok-remote:agents-refresh', (ev: Event) => {
    const list = ((ev as CustomEvent).detail || []) as Agent[];
    anyAgentBusy = list.some((a) =>
      (typeof a?.inFlight === 'number' && a.inFlight > 0) ||
      (a?.status === 'running')
    );
    paintDocumentTitle();
  });

  shell.addEventListener('click', (ev) => {
    if (!document.body.hasAttribute('data-drawer-open')) return;
    const target = ev.target as Element | null;
    if (target && target.closest && target.closest('.sidebar .agent-item')) {
      closeDrawer();
    }
  });

  function renderRoute(): void {
    const route = parseRoute();
    if (route.name === 'redirect') {
      location.replace(location.pathname + location.search + route.to);
      return;
    }
    mainHost.replaceChildren();
    if (route.name === 'chat') {
      chat.mount(mainHost);
      let want = route.agentId;
      try { want = decodeURIComponent(route.agentId); } catch { /* keep raw */ }
      const found = sidebar.agents.find((a: Agent) =>
        a.id === want || a.lastSessionId === want || a.sessionId === want);
      if (found) {
        currentAgent = found;
        sidebar.selectedId = found.id;
        sidebar.renderList();
        applyTopbar({
          ...contextFromAgent(found),
          connectionAction: connectionActionFor(found),
        });
        chat.setAgent(found);
      } else {
        applyTopbar(contextFromAgent({ id: route.agentId }));
        api.getAgent(route.agentId).then((a: unknown) => {
          currentAgent = (a as Agent | null) || { id: route.agentId };
          sidebar.selectedId = currentAgent.id;
          sidebar.renderList();
          applyTopbar({
            ...contextFromAgent(currentAgent),
            connectionAction: connectionActionFor(currentAgent),
          });
          chat.setAgent(currentAgent);
        }).catch(() => {
          currentAgent = { id: route.agentId };
          applyTopbar(contextFromAgent(currentAgent));
          chat.setAgent(currentAgent);
        });
      }
      return;
    }
    applyTopbar({ kind: 'home', title: PRODUCT_NAME });
    chat.mount(mainHost);
    chat.setAgent(null);
  }

  window.addEventListener('hashchange', renderRoute);
  const first = parseRoute();
  if (first.name === 'home') {
    const last = loadLastAgent();
    if (last) {
      location.hash = `#/agents/${encodeURIComponent(last)}`;
      return;
    }
  }
  renderRoute();
}

document.addEventListener('DOMContentLoaded', () => {
  void pingHello();
  setInterval(() => { void pingHello(); }, 10000);

  mountDashboard();

  syncThemeToggle(getTheme());

  const ham = document.getElementById('hamburger-btn');
  if (ham) {
    ham.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      toggleDrawer();
    });
  }
  const backdrop = document.getElementById('drawer-backdrop');
  if (backdrop) {
    backdrop.addEventListener('click', () => closeDrawer());
  }
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && document.body.hasAttribute('data-drawer-open')) {
      closeDrawer();
    }
  });
  document.addEventListener('grok-remote:close-drawer', () => closeDrawer());
  document.addEventListener('grok-remote:open-drawer', () => openDrawer());
  document.addEventListener('click', (ev) => {
    if (!document.body.hasAttribute('data-drawer-open')) return;
    // composedPath is captured at dispatch. Sidebar clicks that re-render
    // the list (folder collapse) detach ev.target, so closest('.sidebar')
    // would falsely look like an outside tap and slam the drawer shut.
    const path = ev.composedPath();
    const inside = path.some((n) => {
      if (!(n instanceof Element)) return false;
      if (n.classList.contains('sidebar')) return true;
      if (n.id === 'hamburger-btn' || n.id === 'drawer-backdrop') return true;
      if (n.classList.contains('tui-sheet') || n.classList.contains('prompt-sheet') || n.classList.contains('ctx-sheet') || n.classList.contains('filter-sheet')) return true;
      if (n.classList.contains('sidebar-sort-menu')) return true;
      return false;
    });
    if (inside) return;
    closeDrawer();
  });

  registerPwa();
});

const SIDEBAR_SIZES_KEY = 'grok-remote.split.sidebar';
const SIDEBAR_COLLAPSED_KEY = 'grok-remote.split.sidebar.collapsed';
const SIDEBAR_DEFAULT_SIZES: [number, number] = [22, 78];
const MOBILE_MAX = 720;

function isMobileViewport(): boolean {
  return window.innerWidth <= MOBILE_MAX;
}

function readSidebarSizes(): [number, number] {
  try {
    const raw = localStorage.getItem(SIDEBAR_SIZES_KEY);
    if (!raw) return [...SIDEBAR_DEFAULT_SIZES] as [number, number];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length === 2 &&
        parsed.every((n) => typeof n === 'number' && isFinite(n) && n >= 0 && n <= 100)) {
      return parsed as [number, number];
    }
  } catch { /* ignore */ }
  return [...SIDEBAR_DEFAULT_SIZES] as [number, number];
}

function isSidebarCollapsed(): boolean {
  try { return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1'; } catch { return false; }
}

function installOuterSplit(splitHost: HTMLElement, sidebarPane: HTMLElement, mainPane: HTMLElement): void {
  const topbarBtn = document.getElementById('topbar-sidebar-left') as HTMLElement | null;

  if (isMobileViewport()) {
    if (topbarBtn) topbarBtn.hidden = true;
    let wasMobile = true;
    window.addEventListener('resize', () => {
      const nowMobile = isMobileViewport();
      if (wasMobile !== nowMobile) {
        wasMobile = nowMobile;
        location.reload();
      }
    });
    return;
  }

  if (topbarBtn) topbarBtn.hidden = false;

  let collapsed = isSidebarCollapsed();
  let lastExpandedSizes = readSidebarSizes();
  let split: ReturnType<typeof Split> | null = null;

  function persistSizes(sizes: number[]): void {
    try { localStorage.setItem(SIDEBAR_SIZES_KEY, JSON.stringify(sizes)); } catch { /* ignore */ }
  }
  function persistCollapsed(v: boolean): void {
    try { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, v ? '1' : '0'); } catch { /* ignore */ }
  }

  function updateTopbarBtn(): void {
    if (!topbarBtn) return;
    topbarBtn.innerHTML = iconHtml(collapsed ? 'panel-left-open' : 'panel-left-close');
    topbarBtn.title = collapsed ? 'show conversations sidebar' : 'hide conversations sidebar';
    topbarBtn.setAttribute('aria-label', collapsed ? 'show conversations sidebar' : 'hide conversations sidebar');
  }

  function buildSplit(initialSizes: number[]): void {
    split = Split([sidebarPane, mainPane], {
      sizes: initialSizes,
      minSize: [220, 480],
      maxSize: [560, Infinity],
      gutterSize: 6,
      snapOffset: 0,
      expandToMin: true,
      direction: 'horizontal',
      elementStyle: (_dim: string, size: number, gutterSize: number) => ({
        'flex-basis': `calc(${size}% - ${gutterSize}px)`,
      }),
      gutterStyle: (_dim: string, gutterSize: number) => ({ 'flex-basis': `${gutterSize}px` }),
      onDragEnd: (sizes: number[]) => {
        lastExpandedSizes = sizes as [number, number];
        persistSizes(sizes);
      },
    });
  }

  function destroySplit(): void {
    if (split) {
      try { split.destroy(); } catch { /* ignore */ }
      split = null;
    }
  }

  function applyCollapsedState(): void {
    splitHost.classList.toggle('sidebar-collapsed', collapsed);
    if (collapsed) {
      destroySplit();
    } else if (!split) {
      buildSplit(lastExpandedSizes);
    }
    updateTopbarBtn();
  }

  function setCollapsed(next: boolean): void {
    if (collapsed === next) return;
    collapsed = next;
    persistCollapsed(collapsed);
    applyCollapsedState();
  }

  if (collapsed) {
    splitHost.classList.add('sidebar-collapsed');
  } else {
    buildSplit(lastExpandedSizes);
  }
  updateTopbarBtn();

  if (topbarBtn) {
    topbarBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      setCollapsed(!collapsed);
    });
  }
  document.addEventListener('grok-remote:sidebar-toggle', () => setCollapsed(!collapsed));

  let wasMobile = false;
  window.addEventListener('resize', () => {
    const nowMobile = isMobileViewport();
    if (wasMobile !== nowMobile) {
      wasMobile = nowMobile;
      location.reload();
    }
  });
}
