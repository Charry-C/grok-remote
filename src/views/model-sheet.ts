// Bottom sheet: pick a TUI model and reasoning effort for the current chat.

import { api } from '../lib/api.js';
import { el } from '../lib/render.js';
import { REASONING_EFFORTS, prettyModelId } from '../lib/model-label.js';

export interface ModelChoice {
  model: string;
  reasoningEffort: string;
  displayName?: string;
}

export interface OpenModelSheetOpts {
  currentModel?: string;
  currentEffort?: string;
  onApply: (choice: ModelChoice) => void | Promise<void>;
}

const SHEET_ID = 'model-sheet';

let keyHandler: ((ev: KeyboardEvent) => void) | null = null;

export function closeModelSheet(): void {
  document.getElementById(SHEET_ID)?.remove();
  if (keyHandler) {
    document.removeEventListener('keydown', keyHandler);
    keyHandler = null;
  }
}

export async function openModelSheet(opts: OpenModelSheetOpts): Promise<void> {
  closeModelSheet();

  let currentModel = (opts.currentModel || '').trim();
  let currentEffort = (opts.currentEffort || '').trim();
  const names = new Map<string, string>();
  let applied = false;

  const apply = (next: Partial<ModelChoice> = {}): void => {
    if (applied) return;
    if (next.model != null) currentModel = String(next.model).trim();
    if (next.reasoningEffort != null) currentEffort = String(next.reasoningEffort).trim();
    const displayName = next.displayName
      || names.get(currentModel)
      || prettyModelId(currentModel)
      || undefined;
    applied = true;
    closeModelSheet();
    void opts.onApply({
      model: currentModel,
      reasoningEffort: currentEffort,
      displayName,
    });
  };

  const effortRow = el('div', {
    class: 'model-sheet__effort',
    role: 'group',
    'aria-label': 'Reasoning effort',
  });

  const paintEffort = (): void => {
    effortRow.replaceChildren();
    for (const e of REASONING_EFFORTS) {
      effortRow.appendChild(el('button', {
        class: `model-sheet__effort-btn${e.id === currentEffort ? ' is-on' : ''}`,
        type: 'button',
        onclick: () => apply({ reasoningEffort: e.id }),
      }, e.label));
    }
  };
  paintEffort();

  const listHost = el('div', { class: 'tui-sheet__list' },
    el('p', { class: 'tui-sheet__loading' }, 'Loading models…'),
  );

  const body = el('div', { class: 'tui-sheet__body' },
    el('p', { class: 'tui-sheet__hint' },
      'Applies immediately to this conversation.'),
    effortRow,
    listHost,
  );

  const sheet = el('div', {
    id: SHEET_ID,
    class: 'tui-sheet model-sheet',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': 'Select model',
  },
    el('div', { class: 'tui-sheet__backdrop', onclick: closeModelSheet }),
    el('div', { class: 'tui-sheet__card' },
      el('header', { class: 'tui-sheet__head' },
        el('h2', { class: 'tui-sheet__title' }, 'Model'),
        el('button', {
          class: 'tui-sheet__close',
          type: 'button',
          onclick: closeModelSheet,
          'aria-label': 'Close',
        }, '×'),
      ),
      body,
    ),
  );

  document.body.appendChild(sheet);
  keyHandler = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') closeModelSheet();
  };
  document.addEventListener('keydown', keyHandler);

  const paintList = (items: { id: string; name?: string }[], err?: string): void => {
    listHost.replaceChildren();
    if (err) {
      listHost.appendChild(el('p', { class: 'tui-sheet__error' }, err));
    }
    if (!items.length && !err) {
      listHost.appendChild(el('p', { class: 'tui-sheet__empty' }, 'No models reported by grok.'));
    }
    for (const it of items) {
      const id = it.id;
      const pretty = (it.name && it.name !== id) ? it.name : prettyModelId(id);
      if (pretty && pretty !== id) names.set(id, pretty);
      listHost.appendChild(el('button', {
        class: `tui-sheet__item model-sheet__row${id === currentModel ? ' is-on' : ''}`,
        type: 'button',
        onclick: () => apply({ model: id, displayName: pretty }),
      },
        el('span', { class: 'tui-sheet__item-title' }, pretty || id),
        pretty && pretty !== id
          ? el('span', { class: 'tui-sheet__item-meta' }, id)
          : null,
      ));
    }
  };

  try {
    const data = await api.systemModels.get() as { items?: { id?: string; name?: string }[] };
    if (!document.getElementById(SHEET_ID)) return;
    const items: { id: string; name?: string }[] = [];
    const seen = new Set<string>();
    for (const raw of (data && Array.isArray(data.items) ? data.items : [])) {
      const id = raw && typeof raw.id === 'string' ? raw.id.trim() : '';
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const name = raw && typeof raw.name === 'string' ? raw.name.trim() : '';
      items.push({ id, name: name || undefined });
    }
    if (currentModel && !seen.has(currentModel)) {
      items.unshift({ id: currentModel, name: prettyModelId(currentModel) });
    }
    paintList(items);
  } catch (err) {
    if (!document.getElementById(SHEET_ID)) return;
    const fallback = currentModel
      ? [{ id: currentModel, name: prettyModelId(currentModel) }]
      : [];
    paintList(fallback, err instanceof Error ? err.message : String(err));
  }
}
