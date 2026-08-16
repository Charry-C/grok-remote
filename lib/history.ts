// Per-agent append-only JSONL history at ~/.grok-remote/agents/<id>/history.jsonl.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { load as loadSettings } from './settings.js';

function agentsRoot(): string {
  const override = process.env['GROK_REMOTE_HOME'];
  return path.join(override || path.join(os.homedir(), '.grok-remote'), 'agents');
}

export function agentDir(agentId: string): string {
  return path.join(agentsRoot(), agentId);
}

export function historyPath(agentId: string): string {
  return path.join(agentDir(agentId), 'history.jsonl');
}

export function ensureAgentDirs(agentId: string): string {
  const dir = agentDir(agentId);
  // Overlay holds meta.json (and leftover history.jsonl). Never invent a
  // sandbox cwd/ — recorded session cwd is a pointer and may not exist.
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Persistable cwd string. Empty stays empty; never path.resolve(''). */
export function recordedCwd(raw?: string | null): string {
  const s = typeof raw === 'string' ? raw.trim() : '';
  return s ? path.resolve(s) : '';
}

/** Existing dir for ACP start: recorded cwd, else settings.defaultCwd. */
export function resolveStartCwd(recordCwd?: string | null, defaultCwd?: string | null): string {
  const recorded = recordedCwd(recordCwd);
  if (recorded && fs.existsSync(recorded)) return recorded;
  const fallback = recordedCwd(defaultCwd);
  if (fallback && fs.existsSync(fallback)) return fallback;
  return '';
}

/** One-shot GC of leftover empty overlay sandbox dirs. Non-empty dirs stay. */
export function removeEmptyOverlayCwds(): number {
  let n = 0;
  let names: string[];
  try { names = fs.readdirSync(agentsRoot()); } catch { return 0; }
  for (const name of names) {
    const cwdDir = path.join(agentsRoot(), name, 'cwd');
    try {
      const st = fs.lstatSync(cwdDir);
      if (!st.isDirectory()) continue;
      if (fs.readdirSync(cwdDir).length > 0) continue;
      fs.rmdirSync(cwdDir);
      n += 1;
    } catch { /* missing, not a dir, or raced non-empty */ }
  }
  return n;
}

let _skipLog = 0;
let _debugSkip: boolean | null = null;

function shouldLogSkip(): boolean {
  if (_debugSkip === null) {
    try { _debugSkip = !!loadSettings().debug; } catch { _debugSkip = false; }
  }
  if (!_debugSkip) return false;
  return (_skipLog++ % 32) === 0;
}

/** Overlay fallback. No-op once the caller has seen a TUI session dir. */
export function append(agentId: string, event: unknown, opts?: { tuiPresent?: boolean }): void {
  if (opts?.tuiPresent) {
    if (shouldLogSkip()) {
      process.stderr.write(`[history] skip append (tui present) agent=${agentId}\n`);
    }
    return;
  }
  try {
    ensureAgentDirs(agentId);
    fs.appendFileSync(historyPath(agentId), JSON.stringify(event) + '\n');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[history] append failed for ${agentId}: ${msg}\n`);
  }
}

export function readAll(agentId: string): string {
  try {
    return fs.readFileSync(historyPath(agentId), 'utf8');
  } catch {
    return '';
  }
}
