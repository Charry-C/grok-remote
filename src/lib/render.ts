// Pure-ish DOM helpers + markdown-light renderers.
// No external libraries. All functions return DOM nodes or strings.

import type { TokenMeta } from './token-usage';
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

export function renderThinkingPane(): ThinkingPane {
  const dots = el('span', { class: 'thinking-dots' }, '...');
  const summary = el('summary', { class: 'thinking-summary' },
    el('span', { class: 'thinking-label' }, 'thinking'),
    dots,
  );
  const body = el('pre', { class: 'thinking-body' });
  const details = el('details', { class: 'thinking' }, summary, body);
  let buf = '';
  let active = true;
  return {
    node: details,
    append(text: string): void {
      buf += text;
      body.textContent = buf;
    },
    finalize(): void {
      active = false;
      dots.textContent = '';
      summary.classList.add('thinking-summary--done');
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
    case 'succeeded':                return 'Completed';
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
  ingestExternal?: (payload: ToolPayload) => void;
  isTodo?: boolean;
}

export function renderToolCard(initial: ToolPayload): ToolCard {
  if (isTodoWriteToolCall(initial)) return renderTodoWriteCard(initial);
  const status = readStatus(initial) || 'Pending';
  const styleInfo = STATUS_STYLES[status] || PENDING_STYLE;
  const startedAt = Date.now();
  let endedAt: number | null = null;

  const kindEl   = el('span', { class: 'tool-pill__kind' }, (initial && initial.kind) || 'tool');
  const titleEl  = el('span', { class: 'tool-pill__label' }, inferToolTitle(initial || {}));
  const durEl    = el('span', { class: 'tool-pill__dur' }, '');
  const statusEl = el('span', { class: `tool-pill__status ${styleInfo.cls}` }, styleInfo.label);
  const caretEl  = el('span', { class: 'tool-pill__caret' }, '▸');

  const rawInputBody = el('pre', { class: 'tool-pill-body__pre' });
  rawInputBody.textContent = initial && initial.rawInput ? JSON.stringify(initial.rawInput, null, 2) : '{}';
  const outputBody = el('pre', { class: 'tool-pill-body__pre' });

  const inputSection = el('div', { class: 'tool-pill-body__section' },
    el('div', { class: 'tool-pill-body__title' }, 'input'),
    rawInputBody,
  );
  const outputSection = el('div', { class: 'tool-pill-body__section tool-pill-body__section--output' },
    el('div', { class: 'tool-pill-body__title' }, 'output'),
    outputBody,
  );
  const body = el('div', { class: 'tool-pill__body', hidden: true }, inputSection, outputSection);

  const head = el('button', {
    type: 'button',
    class: 'tool-pill__head',
    title: inferToolTitle(initial || {}),
    onclick: () => {
      body.hidden = !body.hidden;
      caretEl.textContent = body.hidden ? '▸' : '▾';
      node.classList.toggle('tool-pill--open', !body.hidden);
    },
  }, caretEl, kindEl, titleEl, durEl, statusEl);

  const node = el('div', { class: 'tool-pill', dataset: { toolId: (initial && initial.toolCallId) || '' } },
    head,
    body,
  );

  let outputBuf = '';

  let durTimer: ReturnType<typeof setInterval> | null = null;
  const isTerminal = (status === 'Completed' || status === 'Failed' || status === 'Canceled');
  if (isTerminal) {
    endedAt = startedAt;
    durEl.textContent = '';
  } else {
    durTimer = setInterval(() => {
      if (endedAt) { if (durTimer) clearInterval(durTimer); durTimer = null; return; }
      durEl.textContent = fmtDur(Date.now() - startedAt) + '…';
    }, 500);
  }

  function setStatus(canonical: string): void {
    const info = STATUS_STYLES[canonical] || styleInfo;
    statusEl.className = `tool-pill__status ${info.cls}`;
    statusEl.textContent = info.label;
    if ((canonical === 'Completed' || canonical === 'Failed' || canonical === 'Canceled') && !endedAt) {
      endedAt = Date.now();
      if (durTimer) { clearInterval(durTimer); durTimer = null; }
      durEl.textContent = fmtDur(endedAt - startedAt);
    }
  }

  function applyUpdate(payload: ToolPayload): void {
    const canonical = readStatus(payload);
    if (canonical) setStatus(canonical);
    if (payload.title || (payload.rawInput && payload.rawInput.command)) {
      titleEl.textContent = inferToolTitle(payload);
      head.title = inferToolTitle(payload);
    }
    if (payload.kind) kindEl.textContent = payload.kind;
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

  return { node, applyUpdate, appendDelta, getStatus: () => statusEl.textContent || '' };
}

interface TodoEntry { content: string; status: string }

export function renderTodoWriteCard(initial: ToolPayload): ToolCard {
  const startedAt = Date.now();
  let endedAt: number | null = null;
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
  const node = el('div', { class: 'tool-pill tool-pill--todo todo-card' }, head, list);

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
    } else {
      statusEl.textContent = 'running';
      statusEl.classList.add('todo-card__status--running');
      statusEl.classList.remove('todo-card__status--done');
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
    getStatus: (): string => statusEl.textContent || '',
    ingestExternal: (payload: ToolPayload): void => { ingest(payload); applyStatus(payload); render(); },
    isTodo: true,
  };
}

export function renderTokenFooter(meta: TokenMeta | null | undefined): HTMLElement {
  if (!meta) return el('div', { class: 'turn-footer' }, 'turn complete');
  const inputT  = meta.inputTokens     ?? meta.input_tokens     ?? '·';
  const outputT = meta.outputTokens    ?? meta.output_tokens    ?? '·';
  const cachedT = meta.cachedReadTokens ?? meta.cached_read_tokens ?? meta.cachedTokens ?? '·';
  const reasonT = meta.reasoningTokens ?? meta.reasoning_tokens ?? '·';
  const total   = meta.totalTokens     ?? meta.total_tokens     ?? null;
  const model   = meta.modelId         ?? meta.model_id         ?? meta.model ?? null;
  const stop    = meta.stopReason      ?? meta.stop_reason      ?? null;

  const chips = [
    chip('in',     inputT),
    chip('out',    outputT),
    chip('cached', cachedT),
    chip('think',  reasonT),
  ];
  if (total != null) chips.push(chip('total', total));
  if (model) chips.push(chip('model', model));
  if (stop)  chips.push(chip('stop', stop));
  chips.push(chip('cost', 'n/a'));

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
