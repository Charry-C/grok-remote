// Read official Grok TUI sessions from ~/.grok/sessions and adapt them
// for grok-remote (conversation history + usage rollup).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface TuiSession {
  sessionId: string;
  cwd: string;
  title: string;
  summary: string;
  createdAt: string;
  updatedAt: string;
  model: string | null;
  turns: number;
  contextTokensUsed: number;
  contextWindowTokens: number;
  contextWindowUsage: number;
  toolCallCount: number;
  sessionKind: 'main' | 'subagent';
  source: 'tui';
}

export interface HistoryEvent {
  at: string;
  event: string;
  data: Record<string, unknown>;
}

type Turn = {
  at: string;
  user: string;
  thought: string;
  assistant: string;
  tools: HistoryEvent[];
  completed: HistoryEvent | null;
};

function emptyTurn(): Turn {
  return { at: new Date().toISOString(), user: '', thought: '', assistant: '', tools: [], completed: null };
}

export function grokHome(): string {
  return process.env['GROK_HOME'] || path.join(os.homedir(), '.grok');
}

export function sessionsRoot(): string {
  return path.join(grokHome(), 'sessions');
}

/** Sidebar fallback when a session has no generated title or summary. */
export function fallbackSessionTitle(sessionId: string): string {
  return String(sessionId || '').slice(0, 8);
}

/**
 * True when the session looks like a conversation a user would resume.
 * `session/new` writes summary.json immediately, so handshake leftovers and
 * ACP probes show up as untitled 8-char ids unless we ignore them.
 */
export function tuiSessionLooksLivedIn(s: {
  sessionId?: string;
  title?: string;
  summary?: string;
}): boolean {
  const prefix = fallbackSessionTitle(s.sessionId || '');
  const title = String(s.title || '').trim();
  const summary = String(s.summary || '').trim();
  if (summary && summary !== prefix) return true;
  if (title && title !== prefix) return true;
  return false;
}

export function encodeCwd(cwd: string): string {
  return encodeURIComponent(path.resolve(cwd));
}

export function tuiSessionDir(cwd: string, sessionId: string): string {
  return path.join(sessionsRoot(), encodeCwd(cwd), sessionId);
}

function sessionLooksPresent(dir: string): boolean {
  try {
    return fs.existsSync(path.join(dir, 'updates.jsonl'))
        || fs.existsSync(path.join(dir, 'summary.json'));
  } catch {
    return false;
  }
}

export function findTuiSessionDir(sessionId: string, cwd?: string | null): string | null {
  const sid = String(sessionId || '').trim();
  if (!sid) return null;
  if (cwd) {
    const dir = tuiSessionDir(cwd, sid);
    if (sessionLooksPresent(dir)) return dir;
  }
  let groups: string[] = [];
  try { groups = fs.readdirSync(sessionsRoot()); } catch { return null; }
  for (const group of groups) {
    const groupDir = path.join(sessionsRoot(), group);
    try {
      if (!fs.statSync(groupDir).isDirectory()) continue;
    } catch { continue; }
    const dir = path.join(groupDir, sid);
    if (sessionLooksPresent(dir)) return dir;
  }
  return null;
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function listTuiSessions(limit = 40, opts?: { includeEmpty?: boolean }): TuiSession[] {
  const root = sessionsRoot();
  const out: TuiSession[] = [];
  let groups: string[] = [];
  try { groups = fs.readdirSync(root); } catch { return out; }

  for (const group of groups) {
    const groupDir = path.join(root, group);
    let ids: string[] = [];
    try {
      if (!fs.statSync(groupDir).isDirectory()) continue;
      ids = fs.readdirSync(groupDir);
    } catch { continue; }
    for (const id of ids) {
      const summary = readJson(path.join(groupDir, id, 'summary.json'));
      if (!summary) continue;
      const info = (summary['info'] || {}) as { id?: string; cwd?: string };
      const signals = readJson(path.join(groupDir, id, 'signals.json')) || {};
      const sessionId = String(info.id || id);
      const cwd = String(info.cwd || '');
      out.push({
        sessionId,
        cwd,
        title: String(summary['generated_title'] || summary['session_summary'] || fallbackSessionTitle(sessionId)),
        summary: String(summary['last_turn_summary'] || summary['session_summary'] || ''),
        createdAt: String(summary['created_at'] || ''),
        updatedAt: String(summary['updated_at'] || summary['last_active_at'] || ''),
        model: (summary['current_model_id'] as string) || (signals['primaryModelId'] as string) || null,
        turns: Number(signals['turnCount'] || 0),
        contextTokensUsed: Number(signals['contextTokensUsed'] || 0),
        contextWindowTokens: Number(signals['contextWindowTokens'] || 0),
        contextWindowUsage: Number(signals['contextWindowUsage'] || 0),
        toolCallCount: Number(signals['toolCallCount'] || 0),
        sessionKind: summary['session_kind'] === 'subagent' ? 'subagent' : 'main',
        source: 'tui',
      });
    }
  }

  out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const cap = Number.isFinite(limit) ? Math.max(1, Math.min(limit, 200)) : 40;
  const visible = opts?.includeEmpty ? out : out.filter(tuiSessionLooksLivedIn);
  return visible.slice(0, cap);
}

export function isoFromTs(ts: unknown): string {
  if (typeof ts === 'number' && ts > 1e12) return new Date(ts).toISOString();
  if (typeof ts === 'number' && ts > 1e9) return new Date(ts * 1000).toISOString();
  if (typeof ts === 'string' && ts.trim()) {
    const n = Number(ts);
    if (Number.isFinite(n)) return isoFromTs(n);
    const parsed = Date.parse(ts);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return new Date().toISOString();
}

function textFromUpdate(update: Record<string, unknown>): string {
  const c = update['content'];
  if (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string') {
    return (c as { text: string }).text;
  }
  return '';
}

export function parseUpdatesJsonl(raw: string, sessionId = ''): HistoryEvent[] {
  const turns: Turn[] = [];
  let cur: Turn = emptyTurn();

  const flush = (): void => {
    if (!cur.user && !cur.assistant && !cur.thought && !cur.tools.length) return;
    turns.push(cur);
    cur = emptyTurn();
  };

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try { row = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    applyUpdateRow(row, cur, flush, sessionId);
  }
  flush();
  return turnsToEvents(turns);
}

function applyUpdateRow(
  row: Record<string, unknown>,
  cur: Turn,
  flush: () => void,
  sessionId: string,
): void {
  const method = String(row['method'] || '');
  const params = (row['params'] || {}) as Record<string, unknown>;
  const update = (params['update'] || {}) as Record<string, unknown>;
  const kind = String(update['sessionUpdate'] || '');
  const at = isoFromTs(row['timestamp']);
  const text = textFromUpdate(update);

  if (kind === 'user_message_chunk') {
    if (cur.user || cur.assistant || cur.tools.length) flush();
    cur.at = at;
    cur.user += text;
  } else if (kind === 'agent_thought_chunk') {
    cur.thought += text;
  } else if (kind === 'agent_message_chunk') {
    cur.assistant += text;
  } else if (kind === 'tool_call' || kind === 'tool_call_update') {
    cur.tools.push({
      at,
      event: kind,
      data: { update, _meta: params['_meta'] || null, sessionId },
    });
  } else if (kind === 'turn_completed' || method.endsWith('prompt_complete')) {
    // Keep the usage ledger on the turn so history replay can paint the
    // per-turn footer. `update` is the ACP sessionUpdate object (has `.usage`).
    if (kind === 'turn_completed' || (update && Object.keys(update).length)) {
      cur.completed = { at, event: 'turn_completed', data: update };
    }
    flush();
  }
}

function turnsToEvents(turns: Turn[]): HistoryEvent[] {
  const events: HistoryEvent[] = [];
  for (const t of turns) {
    if (t.user) events.push({ at: t.at, event: 'user_message', data: { text: t.user } });
    if (t.thought) events.push({ at: t.at, event: 'agent_thought_chunk', data: { text: t.thought } });
    events.push(...t.tools);
    if (t.assistant) events.push({ at: t.at, event: 'agent_message_chunk', data: { text: t.assistant } });
    if (t.completed) events.push(t.completed);
  }
  return events;
}

/** Live passthrough of one updates.jsonl row (no turn coalescing). */
export function liveEventFromUpdateRow(row: Record<string, unknown>, sessionId = ''): HistoryEvent | null {
  const params = (row['params'] || {}) as Record<string, unknown>;
  const update = (params['update'] || {}) as Record<string, unknown>;
  const kind = String(update['sessionUpdate'] || '');
  if (!kind) return null;
  const at = isoFromTs(row['timestamp']);
  if (kind === 'user_message_chunk' || kind === 'agent_thought_chunk' || kind === 'agent_message_chunk') {
    const text = textFromUpdate(update);
    if (!text && kind === 'user_message_chunk') return null;
    return { at, event: kind, data: { ...update, text } };
  }
  if (kind === 'tool_call' || kind === 'tool_call_update') {
    return { at, event: kind, data: { update, _meta: params['_meta'] || null, sessionId } };
  }
  if (
    kind === 'turn_completed'
    || kind === 'session_summary_generated'
    || kind === 'plan'
    || kind === 'task_backgrounded'
    || kind === 'task_completed'
  ) {
    return { at, event: kind, data: update };
  }
  return null;
}

export function tuiUpdatesToHistory(
  cwd: string | null | undefined,
  sessionId: string,
  maxTurns = Number.POSITIVE_INFINITY,
): HistoryEvent[] {
  const dir = findTuiSessionDir(sessionId, cwd);
  if (!dir) return [];
  let raw = '';
  try { raw = fs.readFileSync(path.join(dir, 'updates.jsonl'), 'utf8'); } catch { return []; }
  const events = parseUpdatesJsonl(raw, sessionId);
  if (!Number.isFinite(maxTurns) || maxTurns <= 0 || maxTurns === Number.POSITIVE_INFINITY) return events;
  // Slice by user_message turns, keeping preceding non-user events of the window.
  const userIdx: number[] = [];
  for (let i = 0; i < events.length; i++) {
    if (events[i]?.event === 'user_message') userIdx.push(i);
  }
  if (userIdx.length <= maxTurns) return events;
  const cut = userIdx[userIdx.length - maxTurns];
  return events.slice(cut ?? 0);
}

export function historyEventsToNdjson(events: HistoryEvent[]): string {
  if (!events.length) return '';
  return events.map((e) => JSON.stringify(e)).join('\n') + '\n';
}
