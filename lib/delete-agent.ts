// DELETE /api/agents/:id — overlay always; TUI dir only with deleteTuiSession=1.

import fs from 'node:fs';
import path from 'node:path';

import { findTuiSessionDir, sessionsRoot } from './tui-bridge.js';
import {
  holderForSession,
  isPidAlive,
  sessionHeldPayload,
  SessionHeldError,
  type HeldBy,
} from './session-ownership.js';

export interface DeleteAgentResult {
  status: number;
  body: { ok: boolean; error?: string; heldBy?: HeldBy };
  removedTui: boolean;
}

export interface WaitHooks {
  timeoutMs?: number;
  intervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  isAlive?: (pid: number) => boolean;
  holder?: (sessionId: string) => HeldBy;
}

export interface DeleteAgentInput {
  deleteTuiSession: boolean;
  heldBy: HeldBy;
  /** This process has an ACP client for the overlay (the writer). */
  hasLocalAcp: boolean;
  localPid?: number | null;
  sessionId: string | null;
  cwd?: string | null;
  overlayId: string;
  kill: () => Promise<boolean>;
  resolveTuiDir?: (sessionId: string, cwd?: string | null) => string | null;
  rmTui?: (dir: string) => void;
  wait?: WaitHooks;
}

const DEFAULT_WAIT_MS = 5000;
const DEFAULT_INTERVAL_MS = 50;

export function wantsDeleteTuiSession(url: string | undefined | null): boolean {
  try {
    return new URL(url || '/', 'http://127.0.0.1').searchParams.get('deleteTuiSession') === '1';
  } catch {
    return false;
  }
}

/** Resolved path only if it sits strictly under sessionsRoot(). */
export function tuiDirUnderSessionsRoot(dir: string | null | undefined): string | null {
  if (!dir) return null;
  const resolved = path.resolve(dir);
  const root = path.resolve(sessionsRoot());
  // sessionId can contain `..`; never rm outside ~/.grok/sessions.
  if (!resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

export function safeTuiDirForDelete(sessionId: string | null | undefined, cwd?: string | null): string | null {
  const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!sid) return null;
  return tuiDirUnderSessionsRoot(findTuiSessionDir(sid, cwd));
}

function sleepDefault(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Wait until pid is dead, or timeout. Missing pid is treated as already gone. */
export async function waitUntilPidGone(
  pid: number | null | undefined,
  hooks: WaitHooks = {},
): Promise<boolean> {
  if (!pid || pid <= 0) return true;
  const timeoutMs = hooks.timeoutMs ?? DEFAULT_WAIT_MS;
  const intervalMs = hooks.intervalMs ?? DEFAULT_INTERVAL_MS;
  const now = hooks.now ?? Date.now;
  const sleep = hooks.sleep ?? sleepDefault;
  const isAlive = hooks.isAlive ?? isPidAlive;
  const deadline = now() + timeoutMs;
  while (isAlive(pid)) {
    if (now() >= deadline) return false;
    await sleep(intervalMs);
  }
  return true;
}

/** Poll until holder is not `remote`, or timeout. */
export async function waitUntilHolderCleared(
  sessionId: string,
  hooks: WaitHooks = {},
): Promise<HeldBy> {
  const sid = String(sessionId || '').trim();
  const holder = hooks.holder ?? ((s: string) => holderForSession(s));
  if (!sid) return null;
  const timeoutMs = hooks.timeoutMs ?? DEFAULT_WAIT_MS;
  const intervalMs = hooks.intervalMs ?? DEFAULT_INTERVAL_MS;
  const now = hooks.now ?? Date.now;
  const sleep = hooks.sleep ?? sleepDefault;
  const deadline = now() + timeoutMs;
  for (;;) {
    const h = holder(sid);
    if (h !== 'remote') return h;
    if (now() >= deadline) return h;
    await sleep(intervalMs);
  }
}

function heldPayload(sessionId: string, overlayId: string, heldBy: HeldBy): DeleteAgentResult['body'] {
  if (heldBy === 'tui') {
    return sessionHeldPayload(new SessionHeldError(sessionId || overlayId));
  }
  return { ok: false, error: 'session is still held', heldBy: heldBy ?? undefined };
}

/**
 * Overlay delete, optionally removing the official TUI session dir.
 *
 * `heldBy === 'tui'` → 409, no kill, no rm.
 * This-process ACP (or `heldBy === 'remote'`) → kill, wait for the child /
 * holder to clear, re-check; TUI grab → 409 and keep TUI files.
 * Free session → kill overlay then rm TUI (when opted in and path is safe).
 */
export async function deleteAgentWithOptionalTui(input: DeleteAgentInput): Promise<DeleteAgentResult> {
  const sid = (input.sessionId || '').trim();
  if (input.heldBy === 'tui') {
    return { status: 409, body: heldPayload(sid, input.overlayId, 'tui'), removedTui: false };
  }

  if (!input.deleteTuiSession) {
    const ok = await input.kill();
    return { status: ok ? 200 : 404, body: { ok }, removedTui: false };
  }

  const resolve = input.resolveTuiDir ?? safeTuiDirForDelete;
  const safeDir = sid ? resolve(sid, input.cwd) : null;
  const weAreWriter = input.hasLocalAcp || input.heldBy === 'remote';

  const ok = await input.kill();
  if (!ok) return { status: 404, body: { ok: false }, removedTui: false };

  if (!safeDir) {
    return { status: 200, body: { ok: true }, removedTui: false };
  }

  if (weAreWriter) {
    await waitUntilPidGone(input.localPid, input.wait);
    const again = await waitUntilHolderCleared(sid, input.wait);
    if (again !== null) {
      return { status: 409, body: heldPayload(sid, input.overlayId, again), removedTui: false };
    }
  }

  const rm = input.rmTui ?? ((dir: string) => { fs.rmSync(dir, { recursive: true, force: true }); });
  rm(safeDir);
  return { status: 200, body: { ok: true }, removedTui: true };
}
