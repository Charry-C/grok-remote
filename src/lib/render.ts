// Pure-ish DOM helpers + markdown-light renderers.
// No external libraries. All functions return DOM nodes or strings.

import type { TokenMeta } from './token-usage';
import { hasTurnLedger } from './token-usage';
import { fmtUsd, fmtUsdFromTicks } from './format';
export type { TokenMeta };

type ElChild = Node | string | number | boolean | null | undefined | ElChild[];
type ElAttrs = Record<string, unknown> | null;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: ElAttrs,
  ...children: ElChild[]
): HTMLElementTagNameMap[K];
export function el(tag: string, attrs?: ElAttrs, ...children: ElChild[]): HTMLElement;
export function el(tag: string, attrs?: ElAttrs, ...children: ElChild[]): HTMLElement {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class')      node.className = String(v);
      else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v as object);
      else if (k === 'dataset' && typeof v === 'object') Object.assign(node.dataset, v as object);
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (k === 'html')  node.innerHTML = String(v);
      else node.setAttribute(k, String(v));
    }
  }
  for (const c of children) appendChild(node, c);
  return node;
}

function appendChild(parent: Node, c: ElChild): void {
  if (c == null || c === false) return;
  if (Array.isArray(c)) { for (const x of c) appendChild(parent, x); return; }
  if (c instanceof Node) { parent.appendChild(c); return; }
  parent.appendChild(document.createTextNode(String(c)));
}

export function escapeHtml(s: unknown): string {
  return String(s).replace(/[&<>"]/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
  }[c] as string));
}

type MdPart =
  | { type: 'code'; lang: string; code: string }
  | { type: 'text'; text: string };

export function renderMarkdownLight(text: string): HTMLElement {
  const container = el('div', { class: 'md' });
  if (!text) return container;
  for (const part of splitFences(String(text))) {
    if (part.type === 'code') container.appendChild(renderFence(part.lang, part.code));
    else renderBlocks(container, part.text);
  }
  return container;
}

function splitFences(src: string): MdPart[] {
  const out: MdPart[] = [];
  const re = /```([a-zA-Z0-9_+-]*)[ \t]*\r?\n?([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (m.index > last) out.push({ type: 'text', text: src.slice(last, m.index) });
    out.push({ type: 'code', lang: m[1] || '', code: trimFenceCode(m[2] || '') });
    last = m.index + m[0].length;
  }
  const rest = src.slice(last);
  const open = rest.match(/^```([a-zA-Z0-9_+-]*)[ \t]*\r?\n?([\s\S]*)$/);
  if (open) out.push({ type: 'code', lang: open[1] || '', code: open[2] || '' });
  else if (rest) out.push({ type: 'text', text: rest });
  return out;
}

function trimFenceCode(code: string): string {
  return code.replace(/\n$/, '');
}

function renderFence(lang: string, code: string): HTMLElement {
  const pre = el('pre', { class: 'md-code' },
    el('code', { class: lang ? `lang-${lang}` : '' }, code),
  );
  if (lang) pre.dataset.lang = lang;
  return pre;
}

function isBlockStart(line: string): boolean {
  return /^(#{1,6}\s|```|[-*+]\s|\d+\.\s|>\s?|(-{3,}|\*{3,}|_{3,})$|\|)/.test(line.trimStart())
    || /^\|.+\|$/.test(line.trim());
}

function renderBlocks(root: HTMLElement, text: string): void {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] || '';
    if (!line.trim()) { i++; continue; }

    const hm = /^(#{1,6})\s+(.+)$/.exec(line);
    if (hm && hm[1] && hm[2]) {
      const level = hm[1].length;
      root.appendChild(el(`h${level}`, { class: `md-h md-h${level}`, html: inlineMd(hm[2]) }));
      i++;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      root.appendChild(el('hr', { class: 'md-hr' }));
      i++;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i] || '')) {
        buf.push((lines[i] || '').replace(/^>\s?/, ''));
        i++;
      }
      const quote = el('blockquote', { class: 'md-quote' });
      renderBlocks(quote, buf.join('\n'));
      root.appendChild(quote);
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const ul = el('ul', { class: 'md-list' });
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i] || '')) {
        ul.appendChild(el('li', { html: inlineMd((lines[i] || '').replace(/^\s*[-*+]\s+/, '')) }));
        i++;
      }
      root.appendChild(ul);
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const ol = el('ol', { class: 'md-list md-list--ol' });
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i] || '')) {
        ol.appendChild(el('li', { html: inlineMd((lines[i] || '').replace(/^\s*\d+\.\s+/, '')) }));
        i++;
      }
      root.appendChild(ol);
      continue;
    }

    if (isTableHeader(lines, i)) {
      const parsed = parseTable(lines, i);
      root.appendChild(parsed.node);
      i = parsed.next;
      continue;
    }

    const buf: string[] = [];
    while (i < lines.length) {
      const cur = lines[i] || '';
      if (!cur.trim()) break;
      if (buf.length && isBlockStart(cur)) break;
      buf.push(cur);
      i++;
    }
    root.appendChild(el('p', { class: 'md-p', html: inlineMd(buf.join('\n')) }));
  }
}

function isTableHeader(lines: string[], i: number): boolean {
  const a = (lines[i] || '').trim();
  const b = (lines[i + 1] || '').trim();
  return a.startsWith('|') && a.endsWith('|') && /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(b);
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

function parseTable(lines: string[], i: number): { node: HTMLElement; next: number } {
  const headers = splitRow(lines[i] || '');
  i += 2;
  const rows: string[][] = [];
  while (i < lines.length && (lines[i] || '').trim().startsWith('|')) {
    rows.push(splitRow(lines[i] || ''));
    i++;
  }
  const thead = el('thead', {},
    el('tr', {}, headers.map((h) => el('th', { html: inlineMd(h) }))),
  );
  const tbody = el('tbody', {}, rows.map((r) =>
    el('tr', {}, headers.map((_, idx) => el('td', { html: inlineMd(r[idx] || '') }))),
  ));
  return { node: el('table', { class: 'md-table' }, thead, tbody), next: i };
}

function inlineMd(s: string): string {
  let out = escapeHtml(s);
  out = out.replace(/!\[([^\]]*)\]\((https?:[^)\s]+)\)/g,
    (_m, alt, href) => `<img class="md-img" alt="${alt}" src="${href}" loading="lazy" />`);
  out = out.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
    (_m, label, href) => `<a class="md-a" href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`);
  out = out.replace(/`([^`\n]+)`/g, (_m, g1) => `<code class="md-inline-code">${g1}</code>`);
  out = out.replace(/\*\*\*([^*\n]+)\*\*\*/g, (_m, g1) => `<strong><em>${g1}</em></strong>`);
  out = out.replace(/\*\*([^*\n]+)\*\*/g, (_m, g1) => `<strong>${g1}</strong>`);
  out = out.replace(/__([^_\n]+)__/g, (_m, g1) => `<strong>${g1}</strong>`);
  out = out.replace(/(^|[^\*])\*([^*\n]+)\*/g, (_m, pre, g1) => `${pre}<em>${g1}</em>`);
  out = out.replace(/~~([^~\n]+)~~/g, (_m, g1) => `<del>${g1}</del>`);
  out = out.replace(/\n/g, '<br/>');
  return out;
}

function fmtClock(d: Date): string {
  if (!(d instanceof Date) || isNaN(d.getTime())) return '';
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

function basename(p: unknown): string {
  return String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';
}

export interface Attachment {
  mimeType?: string;
  dataUrl?: string;
  dataBase64?: string;
  rel?: string;
  name?: string;
  size?: number | null;
}

export interface AttachmentThumb {
  name: string;
  mimeType: string;
  size: number | null;
  src: string;
}

export interface UserAttachmentOpts {
  agentId?: string;
}

export function userAttachmentThumbnails(
  attachments: Attachment[] = [],
  { agentId }: UserAttachmentOpts = {},
): AttachmentThumb[] {
  const out: AttachmentThumb[] = [];
  for (const att of attachments || []) {
    if (!att || typeof att !== 'object') continue;
    const mimeType = String(att.mimeType || '');
    if (!mimeType.startsWith('image/')) continue;

    let src = '';
    if (typeof att.dataUrl === 'string' && att.dataUrl) {
      src = att.dataUrl;
    } else if (typeof att.dataBase64 === 'string' && att.dataBase64) {
      src = `data:${mimeType || 'image/png'};base64,${att.dataBase64}`;
    } else if (agentId && typeof att.rel === 'string' && att.rel) {
      src = `/api/agents/${encodeURIComponent(agentId)}/files/raw?path=${encodeURIComponent(att.rel)}`;
    }
    if (!src) continue;

    out.push({
      name: att.name || basename(att.rel) || 'attached image',
      mimeType,
      size: att.size ?? null,
      src,
    });
  }
  return out;
}

function looksLikeGeneratedAttachmentBlock(text: string): boolean {
  const lines = String(text || '').split('\n');
  if (lines[0] !== 'Attached files:') return false;
  const fileLines = lines.slice(1).filter(Boolean);
  return fileLines.length > 0 && fileLines.every(line => /^- .+ \([^,]+, .+\)$/.test(line));
}

export function stripGeneratedAttachmentBlock(text: string, attachments: Attachment[] = []): string {
  const s = String(text || '');
  if (!attachments || !attachments.length || !s) return s;

  const marker = 'Attached files:\n';
  const withGap = `\n\n${marker}`;
  const gapIdx = s.lastIndexOf(withGap);
  if (gapIdx >= 0) {
    const block = s.slice(gapIdx + 2);
    if (looksLikeGeneratedAttachmentBlock(block)) return s.slice(0, gapIdx);
  }

  if (s.startsWith(marker) && looksLikeGeneratedAttachmentBlock(s)) return '';
  return s;
}

function renderUserAttachments(attachments: Attachment[] | undefined, agentId: string | undefined): HTMLElement | null {
  const thumbs = userAttachmentThumbnails(attachments, { agentId });
  if (!thumbs.length) return null;
  return el('div', { class: 'msg-attachments' }, thumbs.map((att) =>
    el('a', {
      class: 'msg-attachment',
      href: att.src,
      target: '_blank',
      rel: 'noopener noreferrer',
      title: att.name,
      onclick: (ev: MouseEvent) => {
        if (ev.button !== 0) return;
        if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
        ev.preventDefault();
        void import('./image-lightbox.js').then((m) => m.openImageLightbox(att.src, att.name));
      },
    },
      el('img', {
        class: 'msg-attachment-thumb',
        src: att.src,
        alt: att.name,
        loading: 'lazy',
      }),
      el('span', { class: 'msg-attachment-name' }, att.name),
    )
  ));
}

export interface UserBubbleOpts {
  attachments?: Attachment[];
  agentId?: string;
}

export function renderUserBubble(text: string, ts?: number | string | Date, opts: UserBubbleOpts = {}): HTMLElement | null {
  const when = ts ? new Date(ts) : new Date();
  const attachments = Array.isArray(opts.attachments) ? opts.attachments : [];
  const visibleText = stripGeneratedAttachmentBlock(text, attachments);
  const attachmentGrid = renderUserAttachments(attachments, opts.agentId);
  if (!visibleText && !attachmentGrid) return null;

  const body = el('div', { class: 'msg-body' });
  if (visibleText) body.appendChild(renderMarkdownLight(visibleText));
  if (attachmentGrid) body.appendChild(attachmentGrid);

  return el('div', { class: 'msg msg--user' },
    el('div', { class: 'msg-head' },
      el('span', { class: 'msg-role' }, 'you'),
      el('span', { class: 'msg-time', title: when.toISOString() }, fmtClock(when)),
    ),
    body,
  );
}

export interface AssistantBubble {
  node: HTMLElement;
  append(text: string): void;
  text(): string;
  finalize(): void;
}

export function renderAssistantBubble(ts?: number | string | Date): AssistantBubble {
  const when = ts ? new Date(ts) : new Date();
  const body = el('div', { class: 'msg-body' });
  const timeEl = el('span', { class: 'msg-time', title: when.toISOString() }, fmtClock(when));
  const node = el('div', { class: 'msg msg--assistant' },
    el('div', { class: 'msg-head' },
      el('span', { class: 'msg-role' }, 'grok'),
      timeEl,
    ),
    body,
  );
  let buf = '';
  return {
    node,
    append(text: string): void {
      buf += text;
      body.replaceChildren(renderMarkdownLight(buf));
    },
    text(): string { return buf; },
    finalize(): void {
      node.classList.add('msg--done');
      const now = new Date();
      timeEl.textContent = fmtClock(now);
      timeEl.title = now.toISOString();
    },
  };
}

export interface ThinkingPane {
  node: HTMLElement;
  append(text: string): void;
  finalize(): void;
  text(): string;
  isActive(): boolean;
}

export function isTerminalToolStatus(s: unknown): boolean {
  const k = String(s || '').trim().toLowerCase();
  return k === 'completed' || k === 'failed' || k === 'canceled' || k === 'cancelled'
    || k === 'success' || k === 'succeeded' || k === 'error' || k === 'errored'
    || k === 'done';
}

export type ToolRowPhase = 'live' | 'done' | 'todo';

export function toolRowPhase(status: unknown, isTodo?: boolean): ToolRowPhase {
  if (isTodo) return 'todo';
  return isTerminalToolStatus(status) ? 'done' : 'live';
}

export const WORK_ROW_SETTLE_MS = 2000;

export function workRowHideAt(opts: {
  phase: ToolRowPhase;
  settle: boolean;
  prevHideAt: number | null;
  now: number;
  holdMs?: number;
}): number | null {
  if (opts.phase !== 'done') return null;
  if (opts.prevHideAt != null) return opts.prevHideAt;
  return opts.settle ? opts.now + (opts.holdMs ?? WORK_ROW_SETTLE_MS) : 0;
}

export function workRowIsHolding(hideAt: number | null, now: number): boolean {
  return hideAt != null && hideAt > now;
}

export function collapseKindRuns(kinds: string[]): { kind: string; n: number }[] {
  const out: { kind: string; n: number }[] = [];
  for (const raw of kinds) {
    const kind = String(raw || 'tool').trim() || 'tool';
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.n += 1;
    else out.push({ kind, n: 1 });
  }
  return out;
}

export interface WorkLogHead {
  title: string;
  count: string;
  chips: { kind: string; n: number }[];
}

export function formatWorkLogHead(input: {
  done: number;
  live: number;
  kinds: string[];
  open: boolean;
}): WorkLogHead {
  const done = Number(input && input.done) || 0;
  const live = Number(input && input.live) || 0;
  const chips = collapseKindRuns((input && input.kinds) || []);
  if (input && input.open) {
    const total = done + live;
    return {
      title: total === 1 ? '1 tool' : `${total} tools`,
      count: '',
      chips: [],
    };
  }
  if (live && done) {
    return {
      title: '',
      count: done === 1 ? '1 done' : `${done} done`,
      chips,
    };
  }
  if (live && !done) {
    return {
      title: live === 1 ? 'working' : `${live} working`,
      count: '',
      chips: [],
    };
  }
  return {
    title: '',
    count: done === 1 ? '1 tool' : `${done} tools`,
    chips,
  };
}

function displayToolTitle(update: ToolPayload): string {
  const ri = update && update.rawInput;
  if (ri) {
    const loc = ri.target_file || ri.path || ri.file_path || ri.url || ri.command || ri.cmd
      || (ri as { query?: unknown }).query;
    if (loc) return String(loc);
  }
  const raw = inferToolTitle(update || {});
  const tick = raw.match(/`([^`]+)`/);
  if (tick && tick[1]) return tick[1];
  return raw;
}

export function renderThinkingPane(): ThinkingPane {
  const caret = el('span', { class: 'work-thought__caret', 'aria-hidden': 'true' }, '›');
  const mark = el('span', { class: 'work-thought__mark work-thought__mark--live', 'aria-hidden': 'true' });
  const label = el('span', { class: 'work-thought__label' }, 'thought');
  const hint = el('span', { class: 'work-thought__hint' }, '');
  const toggle = el('button', {
    type: 'button',
    class: 'work-thought__toggle',
    'aria-expanded': 'false',
    onclick: () => setOpen(!open),
  }, caret, mark, label, hint);
  const body = el('pre', { class: 'work-thought__body thinking-body' });
  const node = el('div', {
    class: 'work-thought thinking work-thought--live',
    role: 'group',
    'aria-label': 'Thought',
  }, toggle, body);

  let buf = '';
  let active = true;
  let open = false;

  function setOpen(next: boolean): void {
    open = next;
    node.classList.toggle('work-thought--open', open);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  return {
    node,
    append(text: string): void {
      buf += text;
      body.textContent = buf;
    },
    finalize(): void {
      active = false;
      node.classList.remove('work-thought--live');
      node.classList.add('work-thought--done');
      mark.className = 'work-thought__mark work-thought__mark--done';
      hint.textContent = '';
    },
    text(): string { return buf; },
    isActive(): boolean { return active; },
  };
}

interface StatusStyle { cls: string; label: string }

const PENDING_STYLE: StatusStyle = { cls: 'tool-status--pending', label: 'pending' };
const STATUS_STYLES: Record<string, StatusStyle> = {
  Pending:   PENDING_STYLE,
  Running:   { cls: 'tool-status--running',   label: 'running'   },
  Completed: { cls: 'tool-status--completed', label: 'completed' },
  Failed:    { cls: 'tool-status--failed',    label: 'failed'    },
  Canceled:  { cls: 'tool-status--canceled',  label: 'canceled'  },
};

function normalizeStatus(s: unknown): string | null {
  if (!s) return null;
  const k = String(s).trim().toLowerCase();
  switch (k) {
    case 'pending':                  return 'Pending';
    case 'running':
    case 'in_progress':
    case 'inprogress':               return 'Running';
    case 'completed':
    case 'success':
    case 'succeeded':
    case 'done':                     return 'Completed';
    case 'failed':
    case 'error':
    case 'errored':                  return 'Failed';
    case 'canceled':
    case 'cancelled':                return 'Canceled';
    default:                         return null;
  }
}

interface ToolPayload {
  toolCallId?: string;
  kind?: string;
  title?: string;
  status?: string;
  rawInput?: Record<string, unknown> & { variant?: string; command?: string; cmd?: string; todos?: unknown[]; merge?: boolean };
  rawOutput?: unknown;
  content?: unknown;
  _meta?: { updateParams?: { status?: string } };
  [k: string]: unknown;
}

function readStatus(payload: ToolPayload | null | undefined): string | null {
  if (!payload) return null;
  const meta = payload._meta && payload._meta.updateParams && payload._meta.updateParams.status;
  return normalizeStatus(meta) || normalizeStatus(payload.status) || null;
}

function fmtDur(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m${s ? ` ${s}s` : ''}`;
}

function inferToolTitle(update: ToolPayload): string {
  const title = update.title;
  const cmd = update.rawInput && (update.rawInput.command || update.rawInput.cmd);
  if (cmd) return String(cmd);
  if (title) return title;
  if (update.kind) return update.kind;
  return 'tool call';
}

export function isTodoWriteToolCall(data: ToolPayload | null | undefined): boolean {
  return !!(data && data.rawInput && data.rawInput.variant === 'TodoWrite');
}

export interface ToolCard {
  node: HTMLElement;
  applyUpdate(payload: ToolPayload): void;
  appendDelta(payload: unknown): void;
  getStatus(): string;
  getKind(): string;
  /** Stop the live duration clock. Used when the turn ends without a terminal update. */
  finalize(status?: string): void;
  ingestExternal?: (payload: ToolPayload) => void;
  isTodo?: boolean;
}

/** True when a work-row should keep ticking its duration. */
export function toolDurationShouldTick(status: unknown, live: boolean): boolean {
  return !!live && !isTerminalToolStatus(status);
}

function paintRowMark(markEl: HTMLElement, canonical: string): void {
  const k = String(canonical || '').toLowerCase();
  markEl.className = 'work-row__mark';
  markEl.textContent = '';
  if (k === 'failed' || k === 'error' || k === 'errored') {
    markEl.classList.add('work-row__mark--fail');
    markEl.textContent = '×';
  } else if (k === 'completed' || k === 'canceled' || k === 'cancelled' || k === 'done') {
    markEl.classList.add('work-row__mark--done');
  } else {
    markEl.classList.add('work-row__mark--live');
  }
}

export function renderToolCard(initial: ToolPayload, opts?: { live?: boolean }): ToolCard {
  if (isTodoWriteToolCall(initial)) return renderTodoWriteCard(initial);
  let status = readStatus(initial) || 'Pending';
  let kind = String((initial && initial.kind) || 'tool');
  const live = !opts || opts.live !== false;
  const startedAt = Date.now();
  let endedAt: number | null = null;

  const markEl  = el('span', { class: 'work-row__mark', 'aria-hidden': 'true' });
  const kindEl  = el('span', { class: 'work-row__kind tool-pill__kind' }, kind);
  const titleEl = el('span', { class: 'work-row__title tool-title tool-pill__label' }, displayToolTitle(initial || {}));
  const durEl   = el('span', { class: 'work-row__dur tool-pill__dur' }, '');
  paintRowMark(markEl, status);

  const rawInputBody = el('pre', { class: 'work-row__pre tool-raw-body tool-pill-body__pre' });
  rawInputBody.textContent = initial && initial.rawInput ? JSON.stringify(initial.rawInput, null, 2) : '{}';
  const outputBody = el('pre', { class: 'work-row__pre tool-output-body tool-pill-body__pre' });

  const inputSection = el('div', { class: 'work-row__section tool-pill-body__section' },
    el('div', { class: 'work-row__kicker tool-pill-body__title' }, 'input'),
    rawInputBody,
  );
  const outputSection = el('div', { class: 'work-row__section work-row__section--output tool-pill-body__section' },
    el('div', { class: 'work-row__kicker tool-pill-body__title' }, 'output'),
    outputBody,
  );
  const body = el('div', { class: 'work-row__body tool-pill__body', hidden: true }, inputSection, outputSection);

  const head = el('button', {
    type: 'button',
    class: 'work-row__head tool-pill__head',
    title: displayToolTitle(initial || {}),
    onclick: () => {
      body.hidden = !body.hidden;
      node.classList.toggle('work-row--open', !body.hidden);
      node.classList.toggle('tool-pill--open', !body.hidden);
    },
  }, markEl, kindEl, titleEl, durEl);

  const node = el('div', {
    class: 'work-row tool-pill',
    dataset: { toolId: (initial && initial.toolCallId) || '' },
  }, head, body);

  let outputBuf = '';

  let durTimer: ReturnType<typeof setInterval> | null = null;
  if (isTerminalToolStatus(status)) {
    endedAt = startedAt;
    durEl.textContent = '';
  } else if (toolDurationShouldTick(status, live)) {
    durTimer = setInterval(() => {
      if (endedAt) { if (durTimer) clearInterval(durTimer); durTimer = null; return; }
      durEl.textContent = fmtDur(Date.now() - startedAt);
    }, 500);
  }

  function stopClock(paintDuration: boolean): void {
    if (durTimer) { clearInterval(durTimer); durTimer = null; }
    if (endedAt) return;
    endedAt = Date.now();
    if (paintDuration && live) {
      // Freeze the last painted value if the interval already wrote one;
      // otherwise compute from startedAt (wire completion of a live card).
      if (!durEl.textContent) durEl.textContent = fmtDur(endedAt - startedAt);
    } else if (!live) {
      durEl.textContent = '';
    }
  }

  function setStatus(canonical: string): void {
    status = canonical;
    paintRowMark(markEl, canonical);
    if (isTerminalToolStatus(canonical)) stopClock(true);
  }

  function finalize(nextStatus?: string): void {
    if (isTerminalToolStatus(status)) {
      stopClock(false);
      return;
    }
    const canonical = readStatus({ status: nextStatus } as ToolPayload) || 'Completed';
    status = canonical;
    paintRowMark(markEl, canonical);
    stopClock(true);
  }

  function applyUpdate(payload: ToolPayload): void {
    const canonical = readStatus(payload);
    if (canonical) setStatus(canonical);
    if (payload.title || (payload.rawInput && (payload.rawInput.command || payload.rawInput.cmd
      || payload.rawInput.target_file || payload.rawInput.path || payload.rawInput.file_path))) {
      const nextTitle = displayToolTitle(payload);
      titleEl.textContent = nextTitle;
      head.title = nextTitle;
    }
    if (payload.kind) {
      kind = String(payload.kind);
      kindEl.textContent = kind;
    }
    if (payload.rawInput) {
      rawInputBody.textContent = JSON.stringify(payload.rawInput, null, 2);
    }
    if (Array.isArray(payload.content) && payload.content.length) {
      const chunks: string[] = [];
      for (const c of payload.content as Array<unknown>) {
        if (!c) continue;
        if (typeof c === 'string') chunks.push(c);
        else if (typeof c === 'object') {
          const co = c as { type?: string; text?: unknown; content?: unknown };
          if (co.type === 'text' && typeof co.text === 'string') chunks.push(co.text);
          else if (co.text) chunks.push(String(co.text));
          else if (co.content) chunks.push(typeof co.content === 'string' ? co.content : JSON.stringify(co.content));
          else chunks.push(JSON.stringify(c));
        }
      }
      const joined = chunks.join('\n');
      if (joined.length > outputBuf.length) {
        outputBuf = joined;
        outputBody.textContent = outputBuf;
      }
    }
  }

  function appendDelta(payload: unknown): void {
    let chunk = '';
    if (typeof payload === 'string') chunk = payload;
    else if (payload && typeof payload === 'object') {
      const p = payload as { text?: unknown; content?: unknown; delta?: unknown };
      if (typeof p.text === 'string') chunk = p.text;
      else if (p.content) {
        if (typeof p.content === 'string') chunk = p.content;
        else if (typeof (p.content as { text?: unknown }).text === 'string') chunk = (p.content as { text: string }).text;
      } else if (p.delta) {
        chunk = typeof p.delta === 'string' ? p.delta : JSON.stringify(p.delta);
      } else {
        chunk = JSON.stringify(payload);
      }
    } else {
      chunk = JSON.stringify(payload);
    }
    outputBuf += chunk;
    outputBody.textContent = outputBuf;
  }

  return {
    node,
    applyUpdate,
    appendDelta,
    getStatus: () => (STATUS_STYLES[status] || PENDING_STYLE).label,
    getKind: () => kind,
    finalize,
  };
}

interface TodoEntry { content: string; status: string }

export function renderTodoWriteCard(initial: ToolPayload): ToolCard {
  const startedAt = Date.now();
  let endedAt: number | null = null;
  let todoStatus = 'running';
  void startedAt; void endedAt;
  const todos = new Map<string, TodoEntry>();

  const summaryEl = el('span', { class: 'todo-card__summary' }, '0/0');
  const titleEl   = el('span', { class: 'todo-card__title' }, 'plan');
  const statusEl  = el('span', { class: 'todo-card__status' }, 'running');
  void titleEl;
  const head      = el('div', { class: 'todo-card__head' },
    el('span', { class: 'todo-card__ico' }, '☑'),
    titleEl,
    summaryEl,
    el('span', { class: 'todo-card__spacer' }),
    statusEl,
  );
  const list = el('ol', { class: 'todo-card__list' });
  const node = el('div', { class: 'work-row work-row--todo tool-pill tool-pill--todo todo-card' }, head, list);

  function statusGlyph(s: string | undefined): string {
    if (s === 'completed')   return '✓';
    if (s === 'in_progress') return '◐';
    if (s === 'cancelled' || s === 'canceled') return '×';
    return '○';
  }

  function ingest(payload: ToolPayload): void {
    const ri = payload && payload.rawInput;
    if (!ri || !Array.isArray(ri.todos)) return;
    const merge = !!ri.merge;
    if (!merge) todos.clear();
    for (const t of ri.todos as Array<{ id?: string | number; content?: unknown; status?: unknown } | null>) {
      if (!t || t.id == null) continue;
      const key = String(t.id);
      const cur = todos.get(key) || { content: '', status: 'pending' };
      if (t.content != null) cur.content = String(t.content);
      if (t.status  != null) cur.status  = String(t.status);
      todos.set(key, cur);
    }
  }

  function render(): void {
    let done = 0, inProgress = 0;
    list.replaceChildren();
    for (const [id, t] of todos) {
      if (t.status === 'completed') done++;
      else if (t.status === 'in_progress') inProgress++;
      const item = el('li', {
        class: `todo-item todo-item--${(t.status || 'pending').replace(/_/g, '-')}`,
        dataset: { id },
      },
        el('span', { class: 'todo-item__indicator' }, statusGlyph(t.status)),
        el('span', { class: 'todo-item__content' }, t.content || '(no description)'),
      );
      list.appendChild(item);
    }
    const total = todos.size;
    summaryEl.textContent = inProgress
      ? `${done}/${total} done · ${inProgress} in progress`
      : `${done}/${total} done`;
  }

  function applyStatus(payload: ToolPayload): void {
    const canonical = readStatus(payload);
    if (!canonical) return;
    if (canonical === 'Completed' || canonical === 'Failed' || canonical === 'Canceled') {
      if (!endedAt) endedAt = Date.now();
      statusEl.textContent = 'done';
      statusEl.classList.remove('todo-card__status--running');
      statusEl.classList.add('todo-card__status--done');
      todoStatus = 'completed';
    } else {
      statusEl.textContent = 'running';
      statusEl.classList.add('todo-card__status--running');
      statusEl.classList.remove('todo-card__status--done');
      todoStatus = 'running';
    }
  }

  function applyUpdate(payload: ToolPayload): void {
    ingest(payload);
    applyStatus(payload);
    render();
  }

  ingest(initial);
  applyStatus(initial);
  render();

  return {
    node,
    applyUpdate,
    appendDelta: (): void => { /* TodoWrite uses rawInput, not delta chunks */ },
    getStatus: (): string => todoStatus,
    getKind: (): string => 'plan',
    ingestExternal: (payload: ToolPayload): void => { ingest(payload); applyStatus(payload); render(); },
    finalize: (nextStatus?: string): void => {
      applyStatus({ status: nextStatus || 'completed' });
    },
    isTodo: true,
  };
}

export interface ToolLog {
  node: HTMLElement;
  add(card: ToolCard, opts?: { settle?: boolean }): void;
  replace(prev: ToolCard, next: ToolCard): void;
  refresh(): void;
  isOpen(): boolean;
}

const WORK_LOG_CHIP_CAP = 6;

interface ToolLogEntry {
  card: ToolCard;
  settle: boolean;
  hideAt: number | null;
}

export function renderToolLog(): ToolLog {
  const caret = el('span', { class: 'work-log__caret', 'aria-hidden': 'true' }, '›');
  const titleEl = el('span', { class: 'work-log__title' }, '');
  const chipsEl = el('span', { class: 'work-log__chips' });
  const countEl = el('span', { class: 'work-log__count' }, '');
  const toggle = el('button', {
    type: 'button',
    class: 'work-log__toggle',
    'aria-expanded': 'false',
    onclick: () => setOpen(!open),
  }, caret, titleEl, chipsEl, countEl);
  const list = el('div', { class: 'work-log__list' });
  const node = el('div', {
    class: 'work-log',
    role: 'group',
    'aria-label': 'Tools',
  }, toggle, list);

  let open = false;
  const entries: ToolLogEntry[] = [];
  let hideTimer: ReturnType<typeof setTimeout> | null = null;

  function setOpen(next: boolean): void {
    open = next;
    node.classList.toggle('work-log--open', open);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    refresh();
  }

  function mount(card: ToolCard): void {
    card.node.classList.add('work-row');
    if (card.isTodo) card.node.classList.add('work-row--todo');
    list.appendChild(card.node);
  }

  function add(card: ToolCard, opts?: { settle?: boolean }): void {
    entries.push({
      card,
      settle: !!(opts && opts.settle),
      hideAt: null,
    });
    mount(card);
    refresh();
  }

  function replace(prev: ToolCard, next: ToolCard): void {
    const i = entries.findIndex((e) => e.card === prev);
    const prevEntry = i >= 0 ? entries[i] : undefined;
    const settle = !!(prevEntry && prevEntry.settle);
    const nextEntry: ToolLogEntry = { card: next, settle, hideAt: null };
    if (i >= 0) entries[i] = nextEntry;
    else entries.push(nextEntry);
    if (prev.node && prev.node.parentNode) prev.node.parentNode.replaceChild(next.node, prev.node);
    else mount(next);
    next.node.classList.add('work-row');
    if (next.isTodo) next.node.classList.add('work-row--todo');
    refresh();
  }

  function scheduleHide(): void {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    const now = Date.now();
    let nextAt = Infinity;
    for (const e of entries) {
      if (e.hideAt != null && e.hideAt > now && e.hideAt < nextAt) nextAt = e.hideAt;
    }
    if (nextAt < Infinity) {
      hideTimer = setTimeout(() => {
        hideTimer = null;
        refresh();
      }, Math.max(0, nextAt - now));
    }
  }

  function refresh(): void {
    const kinds: string[] = [];
    let done = 0;
    let live = 0;
    const now = Date.now();
    for (const e of entries) {
      const c = e.card;
      const status = c.getStatus ? c.getStatus() : '';
      const phase = toolRowPhase(status, c.isTodo);
      e.hideAt = workRowHideAt({
        phase,
        settle: e.settle,
        prevHideAt: e.hideAt,
        now,
      });
      const holding = workRowIsHolding(e.hideAt, now);
      c.node.classList.toggle('work-row--done', phase === 'done');
      c.node.classList.toggle('work-row--live', phase === 'live');
      c.node.classList.toggle('work-row--todo', phase === 'todo' || !!c.isTodo);
      c.node.classList.toggle('work-row--hold', holding);
      if (phase === 'done') {
        done += 1;
        kinds.push((c.getKind && c.getKind()) || 'tool');
      } else if (phase === 'live') {
        live += 1;
      }
    }
    const head = formatWorkLogHead({ done, live, kinds, open });
    titleEl.textContent = head.title;
    titleEl.hidden = !head.title;
    countEl.textContent = head.count;
    countEl.hidden = !head.count;
    chipsEl.replaceChildren();
    const shown = head.chips.slice(0, WORK_LOG_CHIP_CAP);
    const hidden = head.chips.slice(WORK_LOG_CHIP_CAP).reduce((sum, ch) => sum + ch.n, 0);
    for (const ch of shown) {
      const label = ch.n > 1 ? `${ch.kind} ×${ch.n}` : ch.kind;
      chipsEl.appendChild(el('span', { class: 'work-log__chip' }, label));
    }
    if (hidden) chipsEl.appendChild(el('span', { class: 'work-log__chip work-log__chip--more' }, `+${hidden}`));
    chipsEl.hidden = chipsEl.childNodes.length === 0;
    node.classList.toggle('work-log--has-live', live > 0);
    node.hidden = entries.length === 0;
    scheduleHide();
  }

  return { node, add, replace, refresh, isOpen: () => open };
}

export function renderTokenFooter(meta: TokenMeta | null | undefined): HTMLElement | null {
  if (!hasTurnLedger(meta) || !meta) return null;

  const chips: HTMLElement[] = [];
  const pushNum = (label: string, n: number | undefined) => {
    if (typeof n === 'number' && Number.isFinite(n)) chips.push(chip(label, n));
  };
  pushNum('in', meta.inputTokens ?? meta.input_tokens);
  pushNum('out', meta.outputTokens ?? meta.output_tokens);
  pushNum('cached', meta.cachedReadTokens ?? meta.cached_read_tokens ?? meta.cachedTokens);
  pushNum('think', meta.reasoningTokens ?? meta.reasoning_tokens);
  pushNum('total', (meta.totalTokens ?? meta.total_tokens) ?? undefined);

  const ticks = meta.costUsdTicks ?? meta.cost_usd_ticks ?? meta.total_cost_usd_ticks;
  const usd = meta.costUSD ?? meta.costUsd ?? meta.cost_usd ?? meta.total_cost_usd;
  const cost = typeof ticks === 'number' && Number.isFinite(ticks)
    ? fmtUsdFromTicks(ticks)
    : (typeof usd === 'number' && Number.isFinite(usd) ? fmtUsd(usd) : '');
  if (cost) chips.push(chip('cost', cost));

  if (!chips.length) return null;
  return el('div', { class: 'turn-footer' }, ...chips);
}

function chip(label: string, value: unknown): HTMLElement {
  return el('span', { class: 'chip' },
    el('span', { class: 'chip-label' }, label),
    el('span', { class: 'chip-value' }, String(value)),
  );
}

export function renderCompactedPill(text: string | undefined): HTMLElement {
  return el('div', { class: 'compacted-pill' },
    el('span', { class: 'compacted-pill-label' }, 'context compacted'),
    text ? el('span', { class: 'compacted-pill-text' }, ' · ', text.slice(0, 120)) : null,
  );
}

export function renderErrorBanner(text: string | undefined): HTMLElement {
  return el('div', { class: 'error-banner' },
    el('span', { class: 'error-banner-label' }, 'error'),
    el('span', { class: 'error-banner-text' }, text || 'unknown error'),
  );
}

export function renderToast(text: string, kind?: string): HTMLElement {
  return el('div', { class: `toast toast--${kind || 'info'}` }, text);
}
