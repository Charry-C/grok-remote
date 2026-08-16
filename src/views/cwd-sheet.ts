// Bottom sheet: pick the working directory for new chats.

import { api } from '../lib/api.js';
import { el } from '../lib/render.js';

const SHEET_ID = 'cwd-sheet';
let keyHandler: ((ev: KeyboardEvent) => void) | null = null;

export function closeCwdSheet(): void {
  document.getElementById(SHEET_ID)?.remove();
  if (keyHandler) {
    document.removeEventListener('keydown', keyHandler);
    keyHandler = null;
  }
}

export interface OpenCwdSheetOpts {
  current?: string;
  onApply?: (cwd: string) => void | Promise<void>;
}

export async function openCwdSheet(opts: OpenCwdSheetOpts = {}): Promise<string | null> {
  closeCwdSheet();

  return new Promise((resolve) => {
    let settled = false;
    const finish = (cwd: string | null) => {
      if (settled) return;
      settled = true;
      closeCwdSheet();
      resolve(cwd);
    };

    const input = el('input', {
      class: 'tui-sheet__input inp',
      type: 'text',
      placeholder: '/path/to/project',
      value: opts.current || '',
      autocomplete: 'off',
      spellcheck: 'false',
    }) as HTMLInputElement;

    const errEl = el('p', { class: 'tui-sheet__error', hidden: true });

    const apply = async () => {
      const cwd = input.value.trim();
      if (!cwd) {
        errEl.hidden = false;
        errEl.textContent = 'Pick a working directory first.';
        input.focus();
        return;
      }
      try {
        await api.patchSettings({ defaultCwd: cwd });
      } catch { /* still apply locally; spawn will 400 if unusable */ }
      if (opts.onApply) await opts.onApply(cwd);
      finish(cwd);
    };

    const saveBtn = el('button', {
      class: 'btn btn--primary',
      type: 'button',
      onclick: () => { void apply(); },
    }, 'Use this directory');

    const sheet = el('div', {
      id: SHEET_ID,
      class: 'tui-sheet cwd-sheet',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': 'Working directory',
    },
      el('div', { class: 'tui-sheet__backdrop', onclick: () => finish(null) }),
      el('div', { class: 'tui-sheet__card' },
        el('header', { class: 'tui-sheet__head' },
          el('h2', { class: 'tui-sheet__title' }, 'Working directory'),
          el('button', {
            class: 'tui-sheet__close',
            type: 'button',
            onclick: () => finish(null),
            'aria-label': 'Close',
          }, '×'),
        ),
        el('div', { class: 'tui-sheet__body' },
          el('p', { class: 'tui-sheet__hint' },
            'New chats start in this folder on the TUI host. Long-press + new to change it later.'),
          input,
          errEl,
          el('div', { class: 'tui-sheet__actions' }, saveBtn),
        ),
      ),
    );

    document.body.appendChild(sheet);
    input.focus();
    input.select();
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        void apply();
      }
    });
    keyHandler = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') finish(null);
    };
    document.addEventListener('keydown', keyHandler);
  });
}
