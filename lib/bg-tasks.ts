// Hydrate grok background-shell tasks from TUI updates.jsonl or overlay history.

import fs from 'node:fs';
import path from 'node:path';

import { historyPath } from './history.js';
import { findTuiSessionDir } from './tui-bridge.js';

export interface BgTask {
  id: string;
  tool_call_id: string | null;
  command: string;
  cwd: string;
  output_file: string;
  startedAt: number;
  completed: boolean;
  exit_code: number | null;
  signal: NodeJS.Signals | string | null;
  endedAt?: number;
  kind: 'grok-bg';
  cached_output?: string;
}

/**
 * Pull the session update object out of the wrappers we actually see:
 * overlay history (`data.params.update` / `data.update`), TUI
 * `updates.jsonl` (`params.update`), a bare `update`, or the update itself.
 */
export function extractSessionUpdate(row: unknown): Record<string, unknown> | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;

  const asObj = (v: unknown): Record<string, unknown> | null =>
    v && typeof v === 'object' ? v as Record<string, unknown> : null;

  const data = asObj(r['data']);
  if (data) {
    const nested = asObj(asObj(data['params'])?.['update']);
    if (nested) return nested;
    const dataUpdate = asObj(data['update']);
    if (dataUpdate) return dataUpdate;
    if (typeof data['sessionUpdate'] === 'string') return data;
  }

  const fromParams = asObj(asObj(r['params'])?.['update']);
  if (fromParams) return fromParams;

  const top = asObj(r['update']);
  if (top) return top;

  if (typeof r['sessionUpdate'] === 'string') return r;
  return null;
}

function atMs(at: unknown): number {
  if (typeof at === 'number' && Number.isFinite(at)) {
    if (at > 1e12) return at;
    if (at > 1e9) return at * 1000;
    return at;
  }
  if (typeof at === 'string' && at.trim()) {
    const n = Number(at);
    if (Number.isFinite(n) && !at.includes('T') && !at.includes('-')) return atMs(n);
    const parsed = Date.parse(at);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

/** Apply one session update onto a bg-task map. Returns true when the map changed. */
export function applyBgTaskUpdate(
  out: Map<string, BgTask>,
  upd: Record<string, unknown>,
  opts?: { at?: unknown; defaultCwd?: string },
): boolean {
  const kind = String(upd['sessionUpdate'] || '');
  if (kind === 'task_backgrounded') {
    const tid = upd['task_id'] as string | undefined;
    if (!tid) return false;
    out.set(tid, {
      id: tid,
      tool_call_id: (upd['tool_call_id'] as string) || null,
      command: (upd['command'] as string) || '',
      cwd: (upd['cwd'] as string) || opts?.defaultCwd || '',
      output_file: (upd['output_file'] as string) || '',
      startedAt: atMs(opts?.at),
      completed: false,
      exit_code: null,
      signal: null,
      kind: 'grok-bg',
    });
    return true;
  }
  if (kind === 'task_completed') {
    const snap = (upd['task_snapshot'] as Record<string, unknown>) || {};
    const tid = snap['task_id'] as string | undefined;
    if (!tid || !out.has(tid)) return false;
    const entry = out.get(tid)!;
    entry.completed = true;
    entry.exit_code = snap['exit_code'] != null ? (snap['exit_code'] as number) : null;
    entry.signal = (snap['signal'] as string) || null;
    entry.endedAt = atMs(opts?.at);
    return true;
  }
  const ro = upd['rawOutput'] as Record<string, unknown> | undefined;
  if (ro && ro['type'] === 'TaskOutput' && ro['Result']) {
    const result = ro['Result'] as Record<string, unknown>;
    const tid = result['task_id'] as string | undefined;
    if (!tid) return false;
    const entry = out.get(tid);
    if (entry && typeof result['output'] === 'string' && result['output'].length) {
      entry.cached_output = result['output'] as string;
      return true;
    }
  }
  return false;
}

export function hydrateBgTasksFromEvents(lines: Iterable<string>): Map<string, BgTask> {
  const out = new Map<string, BgTask>();
  for (const line of lines) {
    const trimmed = String(line || '').trim();
    if (!trimmed) continue;
    if (
      trimmed.indexOf('task_backgrounded') === -1 &&
      trimmed.indexOf('task_completed') === -1 &&
      trimmed.indexOf('TaskOutput') === -1
    ) continue;
    let ev: Record<string, unknown>;
    try { ev = JSON.parse(trimmed) as Record<string, unknown>; } catch { continue; }
    const upd = extractSessionUpdate(ev);
    if (!upd) continue;
    applyBgTaskUpdate(out, upd, { at: ev['at'] ?? ev['timestamp'] });
  }
  return out;
}

/** TUI updates.jsonl first; overlay history.jsonl only if TUI had no tasks. */
export function hydrateBgTasksForAgent(opts: {
  agentId: string;
  sessionId?: string | null;
  cwd?: string | null;
}): Map<string, BgTask> {
  const sid = String(opts.sessionId || '').trim();
  if (sid) {
    const dir = findTuiSessionDir(sid, opts.cwd);
    if (dir) {
      let raw = '';
      try { raw = fs.readFileSync(path.join(dir, 'updates.jsonl'), 'utf8'); } catch { raw = ''; }
      const fromTui = hydrateBgTasksFromEvents(raw.split('\n'));
      if (fromTui.size > 0) return fromTui;
    }
  }
  try {
    return hydrateBgTasksFromEvents(fs.readFileSync(historyPath(opts.agentId), 'utf8').split('\n'));
  } catch {
    return new Map();
  }
}
