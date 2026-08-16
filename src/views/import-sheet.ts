// Bottom sheet: search leftover official TUI sessions on this host.

import { api } from '../lib/api.js';
import { el } from '../lib/render.js';

const SHEET_ID = 'import-sheet';
let keyHandler: ((ev: KeyboardEvent) => void) | null = null;

interface SessionItem {
  sessionId: string;
  created?: string;
  status?: string;
  summary?: string;
  cwd?: string;
  title?: string;
  overlayId?: string | null;
  livedIn?: boolean;
  sessionKind?: string;
}

export function closeImportSheet(): void {
  document.getElementById(SHEET_ID)?.remove();
  if (keyHandler) {
    document.removeEventListener('keydown', keyHandler);
    keyHandler = null;
  }
}

export interface OpenImportSheetOpts {
  onOpen?: (overlayId: string) => void;
}

export function openImportSheet(opts: OpenImportSheetOpts = {}): void {
  closeImportSheet();

  const listHost = el('div', { class: 'tui-sheet__list' },
    el('p', { class: 'tui-sheet__loading' }, 'Loading sessions…'),
  );
  const search = el('input', {
    class: 'tui-sheet__input inp',
    type: 'search',
    placeholder: 'search title, id, or cwd',
    autocomplete: 'off',
  }) as HTMLInputElement;

  const sheet = el('div', {
    id: SHEET_ID,
    class: 'tui-sheet import-sheet',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': 'Import session',
  },
    el('div', { class: 'tui-sheet__backdrop', onclick: closeImportSheet }),
    el('div', { class: 'tui-sheet__card' },
      el('header', { class: 'tui-sheet__head' },
        el('h2', { class: 'tui-sheet__title' }, 'Import session'),
        el('button', {
          class: 'tui-sheet__close',
          type: 'button',
          onclick: closeImportSheet,
          'aria-label': 'Close',
        }, '×'),
      ),
      el('div', { class: 'tui-sheet__body' },
        el('p', { class: 'tui-sheet__hint' },
          'Official sessions on this TUI host. Import does not take the write lock.'),
        search,
        listHost,
      ),
    ),
  );

  document.body.appendChild(sheet);
  search.focus();
  keyHandler = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') closeImportSheet();
  };
  document.addEventListener('keydown', keyHandler);

  let timer = 0;
  const load = async (q: string) => {
    listHost.replaceChildren(el('p', { class: 'tui-sheet__loading' }, 'Loading sessions…'));
    try {
      const data = await api.sessions.list({
        q,
        limit: 40,
        includeEmpty: true,
      }) as { items?: SessionItem[] };
      const items = (data && Array.isArray(data.items)) ? data.items : [];
      listHost.replaceChildren();
      if (!items.length) {
        listHost.appendChild(el('p', { class: 'tui-sheet__empty' }, 'No sessions matched.'));
        return;
      }
      for (const it of items) {
        const title = it.title || it.summary || it.sessionId.slice(0, 8);
        const meta = [it.cwd, it.sessionKind || it.status, it.created].filter(Boolean).join(' · ');
        const label = it.overlayId ? 'Open' : 'Import';
        const btn = el('button', {
          class: 'tui-sheet__item',
          type: 'button',
        },
          el('span', { class: 'tui-sheet__item-title' }, title),
          meta ? el('span', { class: 'tui-sheet__item-meta' }, meta) : null,
          el('span', { class: 'tui-sheet__item-action' }, label),
        ) as HTMLButtonElement;
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          try {
            const rec = await api.createAgent({
              resumeSessionId: it.sessionId,
              connect: false,
              cwd: it.cwd,
              name: it.title || it.summary || undefined,
            }) as { id?: string };
            if (!rec || typeof rec.id !== 'string') throw new Error('import failed');
            closeImportSheet();
            if (opts.onOpen) opts.onOpen(rec.id);
            else window.location.hash = `#/agents/${encodeURIComponent(rec.id)}`;
          } catch (err) {
            btn.disabled = false;
            listHost.prepend(el('p', { class: 'tui-sheet__error' },
              err instanceof Error ? err.message : String(err)));
          }
        });
        listHost.appendChild(btn);
      }
    } catch (err) {
      listHost.replaceChildren(el('p', { class: 'tui-sheet__error' },
        err instanceof Error ? err.message : String(err)));
    }
  };

  void load('');
  search.addEventListener('input', () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => { void load(search.value.trim()); }, 220);
  });
}
