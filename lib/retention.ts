// Periodic cleanup of stale overlay pointers under ~/.grok-remote/agents/.
//
// Triggered by settings.retentionDays (0 disables). Never auto-prunes starred
// or archived rows, or overlays whose official TUI session still looks lived-in.
// May remove an overlay only when the TUI directory is already gone.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  fallbackSessionTitle,
  findTuiSessionDir,
  tuiSessionLooksLivedIn,
} from './tui-bridge.js';

function agentsRoot(): string {
  const override = process.env['GROK_REMOTE_HOME'];
  return path.join(override || path.join(os.homedir(), '.grok-remote'), 'agents');
}

export interface AgentMeta {
  starred?: boolean;
  archived?: boolean;
  lastSeen?: string;
  updatedAt?: string;
  createdAt?: string;
  lastSessionId?: string | null;
  cwd?: string;
  [key: string]: unknown;
}

export interface AgentLiveRecord {
  id: string;
  status?: string;
  [key: string]: unknown;
}

export interface AgentManagerLike {
  list(): AgentLiveRecord[];
  kill(id: string): Promise<unknown> | unknown;
}

export interface SweepInputs {
  days?: number;
  manager?: AgentManagerLike | null;
  now?: number;
  /** Test override. Production uses GROK_REMOTE_HOME or ~/.grok-remote/agents. */
  agentsRoot?: string;
  debug?: boolean;
}

export interface SweepResult {
  scanned: number;
  removed: number;
  skipped: number;
}

export interface RetentionTimerInputs {
  getSettings?: () => { retentionDays?: number; debug?: boolean } | null | undefined;
  manager?: AgentManagerLike | null;
  intervalMs?: number;
}

export interface RetentionTimer {
  stop(): void;
  tick(): void;
}

function readMeta(root: string, id: string): AgentMeta | null {
  try {
    const raw = fs.readFileSync(path.join(root, id, 'meta.json'), 'utf8');
    return JSON.parse(raw) as AgentMeta;
  } catch { return null; }
}

function dirMtimeMs(root: string, id: string): number {
  try { return fs.statSync(path.join(root, id)).mtimeMs; }
  catch { return 0; }
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** True when the official TUI session dir exists and looks like a real conversation. */
function tuiSessionIsLivedIn(meta: AgentMeta): { sessionId: string; dir: string | null; livedIn: boolean } {
  const sessionId = typeof meta.lastSessionId === 'string' ? meta.lastSessionId.trim() : '';
  const cwd = typeof meta.cwd === 'string' ? meta.cwd : '';
  if (!sessionId) return { sessionId: '', dir: null, livedIn: false };
  const dir = findTuiSessionDir(sessionId, cwd);
  if (!dir) return { sessionId, dir: null, livedIn: false };
  const summary = readJson(path.join(dir, 'summary.json'));
  const title = String(summary?.['generated_title'] || summary?.['session_summary'] || fallbackSessionTitle(sessionId));
  const text = String(summary?.['last_turn_summary'] || summary?.['session_summary'] || '');
  return {
    sessionId,
    dir,
    livedIn: tuiSessionLooksLivedIn({ sessionId, title, summary: text }),
  };
}

export function sweepOnce(
  { days, manager, now = Date.now(), agentsRoot: agentsRootOverride, debug = false }: SweepInputs = {},
): SweepResult {
  const n = Number(days);
  if (!Number.isFinite(n) || n <= 0) return { scanned: 0, removed: 0, skipped: 0 };
  const cutoffMs = now - n * 24 * 60 * 60 * 1000;
  const root = agentsRootOverride || agentsRoot();

  let entries: string[];
  try { entries = fs.readdirSync(root); }
  catch { return { scanned: 0, removed: 0, skipped: 0 }; }

  let scanned = 0, removed = 0, skipped = 0;
  const active = manager
    ? new Map<string, AgentLiveRecord>(manager.list().map((r) => [r.id, r]))
    : new Map<string, AgentLiveRecord>();

  for (const id of entries) {
    const metaPath = path.join(root, id, 'meta.json');
    if (!fs.existsSync(metaPath)) continue;
    scanned++;
    const meta = readMeta(root, id) || {};
    // Starred / archived overlays are UI pointers the user asked to keep.
    if (meta.starred || meta.archived) { skipped++; continue; }
    const live = active.get(id);
    if (live && live.status && live.status !== 'disconnected') { skipped++; continue; }

    const tui = tuiSessionIsLivedIn(meta);
    // TUI dir still present: overlay is only a pointer. Lived-in sessions are
    // never auto-removed; handshake leftovers are left for reconcile drop.
    if (tui.dir) {
      if (tui.livedIn && debug) {
        process.stderr.write(`[retention] skip lived-in session=${tui.sessionId}\n`);
      }
      skipped++;
      continue;
    }

    const t = Date.parse(meta.lastSeen || meta.updatedAt || meta.createdAt || '');
    const lastMs = Number.isFinite(t) ? t : dirMtimeMs(root, id);
    if (lastMs >= cutoffMs) { skipped++; continue; }

    try {
      if (manager) {
        Promise.resolve(manager.kill(id)).catch(() => { /* ignore */ });
      } else {
        const dir = path.join(root, id);
        if (dir.startsWith(root + path.sep)) {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      }
      process.stderr.write(`[retention] removed overlay=${id} reason=tui-gone\n`);
      removed++;
    } catch {
      skipped++;
    }
  }
  return { scanned, removed, skipped };
}

// Start a daily sweep timer. Returns a stop() handle.
export function startRetentionTimer(
  { getSettings, manager, intervalMs = 24 * 60 * 60 * 1000 }: RetentionTimerInputs = {},
): RetentionTimer {
  const tick = (): void => {
    try {
      const s = typeof getSettings === 'function' ? getSettings() : null;
      const days = Number(s && s.retentionDays);
      if (Number.isFinite(days) && days > 0) {
        const r = sweepOnce({ days, manager, debug: !!(s && s.debug) });
        if (r.removed > 0) {
          process.stderr.write(`[retention] swept: removed=${r.removed} scanned=${r.scanned} skipped=${r.skipped}\n`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[retention] sweep failed: ${msg}\n`);
    }
  };
  const initial = setTimeout(tick, 30_000);
  const handle = setInterval(tick, intervalMs);
  return {
    stop(): void { clearTimeout(initial); clearInterval(handle); },
    tick,
  };
}
