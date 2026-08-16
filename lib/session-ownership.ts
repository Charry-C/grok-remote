// Who currently holds write access to a Grok session.

import fs from 'node:fs';
import path from 'node:path';

import { grokHome } from './tui-bridge.js';

export type HeldBy = 'tui' | 'remote' | null;

export interface ActiveSessionRow {
  session_id: string;
  pid: number;
  cwd?: string;
  opened_at?: string;
}

export class SessionHeldError extends Error {
  heldBy: 'tui';
  statusCode: 409;

  constructor(sessionId: string) {
    super(`TUI is using this session (${sessionId.slice(0, 8)}…). Leave the terminal chat or send from there.`);
    this.name = 'SessionHeldError';
    this.heldBy = 'tui';
    this.statusCode = 409;
  }
}

export function activeSessionsPath(): string {
  return path.join(grokHome(), 'active_sessions.json');
}

export function readActiveSessions(file?: string): ActiveSessionRow[] {
  const p = file || activeSessionsPath();
  let raw = '';
  try { raw = fs.readFileSync(p, 'utf8'); } catch { return []; }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const out: ActiveSessionRow[] = [];
  for (const row of parsed) {
    if (!row || typeof row !== 'object') continue;
    const rec = row as { session_id?: unknown; pid?: unknown; cwd?: unknown };
    const sid = typeof rec.session_id === 'string' ? rec.session_id : '';
    const pid = typeof rec.pid === 'number' ? rec.pid : Number(rec.pid);
    if (!sid || !Number.isFinite(pid) || pid <= 0) continue;
    out.push({
      session_id: sid,
      pid,
      cwd: typeof rec.cwd === 'string' ? rec.cwd : undefined,
      opened_at: typeof (rec as { opened_at?: unknown }).opened_at === 'string'
        ? (rec as { opened_at: string }).opened_at
        : undefined,
    });
  }
  return out;
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readCmdline(pid: number): string {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
  } catch {
    return '';
  }
}

export function isTuiPagerCmd(cmdline: string): boolean {
  if (!cmdline) return false;
  if (/\bagent\b/.test(cmdline)) return false;
  return /(^|[/\s])grok(\s|$)/.test(cmdline);
}

export function isRemoteAgentCmd(cmdline: string): boolean {
  return /\bgrok\b/.test(cmdline) && /\bagent\b/.test(cmdline);
}

export function sessionHeldPayload(err: SessionHeldError): { ok: false; error: string; heldBy: 'tui' } {
  return { ok: false, error: err.message, heldBy: err.heldBy };
}

export function holderForSession(
  sessionId: string,
  remotePids: Iterable<number> = [],
  rows?: ActiveSessionRow[],
  readCmd: (pid: number) => string = readCmdline,
): HeldBy {
  const sid = String(sessionId || '').trim();
  if (!sid) return null;
  const remote = new Set<number>();
  for (const p of remotePids) remote.add(p);
  const list = rows || readActiveSessions();
  const tuiByPid = new Map<number, ActiveSessionRow[]>();
  let ours = false;
  for (const row of list) {
    if (!isPidAlive(row.pid)) continue;
    if (remote.has(row.pid)) {
      if (row.session_id === sid) ours = true;
      continue;
    }
    const cmd = readCmd(row.pid);
    if (isRemoteAgentCmd(cmd)) {
      if (row.session_id === sid) ours = true;
      continue;
    }
    if (!isTuiPagerCmd(cmd)) continue;
    const arr = tuiByPid.get(row.pid) || [];
    arr.push(row);
    tuiByPid.set(row.pid, arr);
  }
  for (const group of tuiByPid.values()) {
    let current = group[0]!;
    for (const row of group) {
      if (String(row.opened_at || '') > String(current.opened_at || '')) current = row;
    }
    if (current.session_id === sid) return 'tui';
  }
  if (ours) return 'remote';
  return null;
}
