// Designed prompt / confirm sheet. Replaces window.prompt and window.confirm
// for sidebar chrome (new folder, delete folder) so mobile never drops into
// the browser's native dialog.

import { el } from '../lib/render.js';
import { iconHtml } from '../lib/icons.js';

const SHEET_ID = 'prompt-sheet';
let keyHandler: ((ev: KeyboardEvent) => void) | null = null;

export interface OpenPromptSheetOpts {
  title: string;
  hint?: string;
  icon?: 'folder' | 'none';
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  defaultValue?: string;
  danger?: boolean;
  /** When false, confirm/cancel only — no text field. */
  ask?: boolean;
}

export function closePromptSheet(): void {
  document.getElementById(SHEET_ID)?.remove();
  if (keyHandler) {
    document.removeEventListener('keydown', keyHandler);
    keyHandler = null;
  }
}

export function openPromptSheet(opts: OpenPromptSheetOpts): Promise<string | null> {
  closePromptSheet();

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      closePromptSheet();
      resolve(value);
    };

    const ask = opts.ask !== false;
    const input = ask
      ? el('input', {
          class: 'prompt-sheet__input inp',
          type: 'text',
          placeholder: opts.placeholder || '',
          value: opts.defaultValue || '',
          autocomplete: 'off',
          spellcheck: 'false',
          maxlength: '80',
          'aria-label': opts.title,
        }) as HTMLInputElement
      : null;

    const errEl = el('p', { class: 'tui-sheet__error prompt-sheet__error', hidden: true });

    const apply = () => {
      if (!ask) {
        finish('');
        return;
      }
      const value = (input?.value || '').trim();
      if (!value) {
        errEl.hidden = false;
        errEl.textContent = 'Give it a name first.';
        input?.focus();
        return;
      }
      finish(value);
    };

    const confirmBtn = el('button', {
      class: `btn btn--primary prompt-sheet__confirm${opts.danger ? ' prompt-sheet__confirm--danger' : ''}`,
      type: 'button',
      onclick: () => apply(),
    }, opts.confirmLabel || 'Create') as HTMLButtonElement;

    const cancelBtn = el('button', {
      class: 'btn btn--ghost prompt-sheet__cancel',
      type: 'button',
      onclick: () => finish(null),
    }, opts.cancelLabel || 'Cancel');

    const iconName = opts.icon === 'none' ? '' : (opts.icon || (ask ? 'folder' : ''));
    const mark = iconName
      ? el('div', {
          class: `prompt-sheet__mark${opts.danger ? ' prompt-sheet__mark--danger' : ''}`,
          html: iconHtml(iconName),
        })
      : null;

    const sheet = el('div', {
      id: SHEET_ID,
      class: 'tui-sheet prompt-sheet',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': opts.title,
    },
      el('div', { class: 'tui-sheet__backdrop', onclick: () => finish(null) }),
      el('div', { class: 'tui-sheet__card prompt-sheet__card' },
        el('header', { class: 'prompt-sheet__head' },
          mark,
          el('div', { class: 'prompt-sheet__copy' },
            el('h2', { class: 'prompt-sheet__title' }, opts.title),
            opts.hint ? el('p', { class: 'prompt-sheet__hint' }, opts.hint) : null,
          ),
          el('button', {
            class: 'tui-sheet__close',
            type: 'button',
            onclick: () => finish(null),
            'aria-label': 'Close',
          }, '×'),
        ),
        el('div', { class: 'prompt-sheet__body' },
          input,
          errEl,
          el('div', { class: 'prompt-sheet__actions' }, cancelBtn, confirmBtn),
        ),
      ),
    );

    document.body.appendChild(sheet);
    if (input) {
      input.focus();
      input.select();
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          apply();
        }
      });
    } else {
      confirmBtn.focus();
    }
    keyHandler = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') finish(null);
    };
    document.addEventListener('keydown', keyHandler);
  });
}
