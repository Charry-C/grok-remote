// Sessions page.

import { api } from '../../lib/api.js';

interface SessionItem {
  sessionId: string;
  created?: string;
  status?: string;
  summary?: string;
  cwd?: string;
  title?: string;
  overlayId?: string | null;
  heldBy?: string | null;
  archived?: boolean;
  livedIn?: boolean;
  sessionKind?: string;
}

interface OverlayRef {
  id: string;
  sessionId?: string;
  lastSessionId?: string;
  archived?: boolean;
  createdAt?: string;
}

interface SessionsState {
  q: string;
  limit: number;
  loading: boolean;
  error: string | null;
  items: SessionItem[];
  overlayBySid: Map<string, string>;
  toast: string;
  toastTimer: number;
  opening: string | null;
}

let activeContainer: HTMLElement | null = null;
let state: SessionsState = freshState();

function freshState(): SessionsState {
  return {
    q: '',
    limit: 20,
    loading: false,
    error: null,
    items: [],
    overlayBySid: new Map(),
    toast: '',
    toastTimer: 0,
    opening: null,
  };
}

export function mount(container: HTMLElement): void {
  activeContainer = container;
  state = freshState();
  render();
  void loadAgents();
  void load();
}

export function unmount(): void {
  if (state.toastTimer) {
    clearTimeout(state.toastTimer);
    state.toastTimer = 0;
  }
  if (activeContainer) {
    activeContainer.replaceChildren();
    activeContainer = null;
  }
}

function pickOverlay(matches: OverlayRef[]): OverlayRef | null {
  if (!matches.length) return null;
  const live = matches.filter((m) => !m.archived);
  const pool = live.length ? live : matches;
  return pool.slice().sort((a, b) => {
    const ta = Date.parse(a.createdAt || '') || 0;
    const tb = Date.parse(b.createdAt || '') || 0;
    return ta - tb;
  })[0] || null;
}

async function loadAgents(): Promise<void> {
  try {
    const list = await api.listAgents() as OverlayRef[] | null;
    const bySid = new Map<string, OverlayRef[]>();
    if (Array.isArray(list)) {
      for (const a of list) {
        if (!a || typeof a.id !== 'string' || !a.id) continue;
        for (const sid of [a.lastSessionId, a.sessionId]) {
          if (typeof sid !== 'string' || !sid) continue;
          const arr = bySid.get(sid);
          if (arr) arr.push(a);
          else bySid.set(sid, [a]);
        }
      }
    }
    const overlayBySid = new Map<string, string>();
    for (const [sid, matches] of bySid) {
      const pick = pickOverlay(matches);
      if (pick) overlayBySid.set(sid, pick.id);
    }
    state.overlayBySid = overlayBySid;
    if (activeContainer) render();
  } catch {
    /* non-fatal */
  }
}

async function load(): Promise<void> {
  state.loading = true;
  state.error = null;
  render();
  try {
    // includeEmpty=1 so leftover/hidden TUI sessions are importable here.
    const data = await api.sessions.list({
      q: state.q,
      limit: state.limit,
      includeEmpty: true,
    }) as { items?: SessionItem[] };
    state.items = (data && Array.isArray(data.items)) ? data.items : [];
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
    state.items = [];
  } finally {
    state.loading = false;
    if (activeContainer) render();
  }
}

function showToast(msg: string): void {
  state.toast = msg;
  if (state.toastTimer) clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    state.toast = '';
    state.toastTimer = 0;
    if (activeContainer) render();
  }, 1800) as unknown as number;
  render();
}

function escapeHtml(s: unknown): string {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function truncId(sid: string | null | undefined): string {
  if (!sid) return '';
  if (sid.length <= 18) return sid;
  return `${sid.slice(0, 8)}...${sid.slice(-4)}`;
}

async function openSession(sid: string): Promise<void> {
  if (state.opening) return;
  state.opening = sid;
  render();
  try {
    const item = state.items.find((it) => it.sessionId === sid);
    // Import-only: connect:false never takes the ACP write lock / spawn().
    const rec = await api.createAgent({
      resumeSessionId: sid,
      connect: false,
      cwd: item?.cwd,
      name: item?.title || item?.summary || undefined,
    }) as { id?: string };
    if (!rec || typeof rec.id !== 'string' || !rec.id) throw new Error('import failed');
    window.location.hash = `#/agents/${rec.id}`;
  } catch (err) {
    showToast(err instanceof Error ? err.message : String(err));
  } finally {
    state.opening = null;
    if (activeContainer) render();
  }
}

function render(): void {
  if (!activeContainer) return;
  const rowsHtml = state.items.length
    ? state.items.map((it) => {
        const overlayId = it.overlayId || state.overlayBySid.get(it.sessionId) || '';
        const opening = state.opening === it.sessionId;
        const hidden = it.livedIn === false;
        return `
          <tr class="sessions-row${hidden ? ' sessions-row--hidden' : ''}" data-sid="${escapeHtml(it.sessionId)}">
            <td class="sessions-id"  title="${escapeHtml(it.sessionId)}"><code>${escapeHtml(truncId(it.sessionId))}</code></td>
            <td class="sessions-cre">${escapeHtml(it.created)}</td>
            <td class="sessions-st">${escapeHtml(it.sessionKind || it.status || '')}${hidden ? ' <span class="sessions-hidden">hidden</span>' : ''}</td>
            <td class="sessions-sum">${escapeHtml(it.summary)}</td>
            <td class="sessions-act">
              <button class="sessions-use" data-sid="${escapeHtml(it.sessionId)}" type="button"${opening ? ' disabled' : ''}>
                ${opening ? 'opening…' : (overlayId ? 'open' : 'import')}
              </button>
            </td>
          </tr>
        `;
      }).join('')
    : '';

  const empty = !state.loading && !state.error && state.items.length === 0;

  activeContainer.innerHTML = `
    <section class="system-page sessions-page">
      <h2 class="system-page-title">Sessions</h2>
      <p class="system-page-sub">
        Official Grok sessions on this machine (<code>~/.grok/sessions</code>),
        including leftover/hidden ones. Search, open, or import without taking
        the ACP write lock.
      </p>

      <div class="sessions-controls">
        <input
          type="text"
          class="sessions-q"
          placeholder="search sessions..."
          value="${escapeHtml(state.q)}"
        />
        <input
          type="number"
          class="sessions-limit"
          min="1"
          max="200"
          step="1"
          value="${escapeHtml(String(state.limit))}"
          title="max rows to return"
        />
        <button class="sessions-refresh" type="button">${state.loading ? 'loading...' : 'refresh'}</button>
        ${state.toast ? `<span class="sessions-toast">${escapeHtml(state.toast)}</span>` : ''}
      </div>

      ${state.error ? `<div class="sessions-error">${escapeHtml(state.error)}</div>` : ''}

      <div class="sessions-table-wrap">
        <table class="sessions-table">
          <thead>
            <tr>
              <th>session id</th>
              <th>created</th>
              <th>status</th>
              <th>summary</th>
              <th></th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
        ${empty ? `
          <div class="sessions-empty">
            no sessions matched. try a broader query.
          </div>
        ` : ''}
      </div>
    </section>
  `;

  wire();
}

function wire(): void {
  if (!activeContainer) return;
  const qInput     = activeContainer.querySelector('.sessions-q') as HTMLInputElement | null;
  const limitInput = activeContainer.querySelector('.sessions-limit') as HTMLInputElement | null;
  const refreshBtn = activeContainer.querySelector('.sessions-refresh') as HTMLButtonElement | null;

  if (qInput) {
    qInput.addEventListener('input', (e: Event) => { state.q = (e.target as HTMLInputElement).value; });
    qInput.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void load();
      }
    });
  }
  if (limitInput) {
    limitInput.addEventListener('input', (e: Event) => {
      const n = parseInt((e.target as HTMLInputElement).value, 10);
      state.limit = Number.isFinite(n) && n > 0 ? n : 20;
    });
    limitInput.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void load();
      }
    });
  }
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => void load());
  }

  const useBtns = activeContainer.querySelectorAll('.sessions-use');
  useBtns.forEach((btn) => {
    btn.addEventListener('click', (e: Event) => {
      e.stopPropagation();
      const sid = btn.getAttribute('data-sid');
      if (sid) void openSession(sid);
    });
  });
}
