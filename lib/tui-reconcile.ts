// Diff TUI sessions against existing grok-remote agents (by lastSessionId).

import { fallbackSessionTitle, tuiSessionLooksLivedIn, type TuiSession } from './tui-bridge.js';

export interface ReconcileAgentRef {
  id: string;
  lastSessionId: string | null;
  name?: string;
  archived?: boolean;
  autoNamed?: boolean;
  starred?: boolean;
  wantedConnected?: boolean;
  connected?: boolean;
  createdAt?: string;
}

export interface ReconcilePlan {
  update: Array<{ agentId: string; session: TuiSession }>;
  create: TuiSession[];
  drop: string[];
}

export interface OverlayDedupeAction {
  lastSessionId: string;
  kept: string;
  dropped: string;
}

function agentById(agents: ReconcileAgentRef[]): Map<string, ReconcileAgentRef> {
  return new Map(agents.map((a) => [a.id, a]));
}

export function createdAtMs(rec: { createdAt?: string }): number {
  const t = Date.parse(rec.createdAt || '');
  return Number.isFinite(t) ? t : 0;
}

/** Prefer a non-archived match; if still tied, oldest createdAt. */
export function pickOverlayForSession<T extends {
  id: string;
  archived?: boolean;
  createdAt?: string;
}>(matches: T[]): T | null {
  if (!matches.length) return null;
  const live = matches.filter((m) => !m.archived);
  const pool = live.length ? live : matches;
  return pool.slice().sort((a, b) => createdAtMs(a) - createdAtMs(b))[0] || null;
}

/** Untitled auto-imports that the user never opened, starred, or renamed. */
export function isPruneableUntitledImport(a: ReconcileAgentRef, sessionId: string): boolean {
  if (a.archived || a.starred) return false;
  if (a.autoNamed === false) return false;
  if (a.wantedConnected || a.connected) return false;
  const name = String(a.name || '').trim();
  if (name && name !== fallbackSessionTitle(sessionId)) return false;
  return true;
}

/** Auto-import clone that is safe to kill when a lastSessionId twin exists. */
function isPureAutoImport(a: {
  archived?: boolean;
  autoNamed?: boolean;
  starred?: boolean;
  wantedConnected?: boolean;
}): boolean {
  if (a.archived) return false;
  if (a.autoNamed === false) return false;
  if (a.starred) return false;
  if (a.wantedConnected === true) return false;
  return true;
}

function groupByLastSessionId<T extends { lastSessionId?: string | null }>(
  agents: T[],
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const a of agents) {
    const sid = a.lastSessionId;
    if (!sid) continue;
    const list = groups.get(sid);
    if (list) list.push(a);
    else groups.set(sid, [a]);
  }
  return groups;
}

export function planTuiReconcile(agents: ReconcileAgentRef[], sessions: TuiSession[]): ReconcilePlan {
  const bySid = new Map<string, string>();
  for (const [sid, matches] of groupByLastSessionId(agents)) {
    const pick = pickOverlayForSession(matches);
    if (pick) bySid.set(sid, pick.id);
  }
  const known = agentById(agents);
  const update: ReconcilePlan['update'] = [];
  const create: TuiSession[] = [];
  const drop: string[] = [];
  for (const s of sessions) {
    if (!s.sessionId) continue;
    const livedIn = tuiSessionLooksLivedIn(s);
    const id = bySid.get(s.sessionId);
    if (id) {
      if (livedIn) {
        update.push({ agentId: id, session: s });
      } else {
        const rec = known.get(id);
        if (rec && isPruneableUntitledImport(rec, s.sessionId)) drop.push(id);
      }
    } else if (livedIn && s.sessionKind !== 'subagent') {
      create.push(s);
    }
  }
  return { update, create, drop };
}

/**
 * One-shot lastSessionId twin cleanup. Archived rows keep the claim;
 * only pure auto-import clones are dropped. Renamed / starred / wanted
 * seconds copies stay.
 */
export function planOverlayDedupe<T extends {
  id: string;
  lastSessionId?: string | null;
  archived?: boolean;
  autoNamed?: boolean;
  starred?: boolean;
  wantedConnected?: boolean;
  createdAt?: string;
}>(agents: T[]): OverlayDedupeAction[] {
  const out: OverlayDedupeAction[] = [];
  for (const [lastSessionId, group] of groupByLastSessionId(agents)) {
    if (group.length < 2) continue;
    const archived = group.filter((a) => a.archived);
    const live = group.filter((a) => !a.archived);
    const dropped = new Set<string>();

    if (archived.length && live.length) {
      const kept = pickOverlayForSession(archived);
      if (kept) {
        for (const twin of live) {
          if (!isPureAutoImport(twin)) continue;
          out.push({ lastSessionId, kept: kept.id, dropped: twin.id });
          dropped.add(twin.id);
        }
      }
    }

    const remainingLive = live.filter((a) => !dropped.has(a.id));
    if (remainingLive.length < 2) continue;
    const starred = remainingLive.filter((a) => a.starred);
    const pool = starred.length ? starred : remainingLive;
    const keeper = pool.slice().sort((a, b) => createdAtMs(a) - createdAtMs(b))[0];
    if (!keeper) continue;
    for (const other of remainingLive) {
      if (other.id === keeper.id) continue;
      if (!isPureAutoImport(other)) continue;
      out.push({ lastSessionId, kept: keeper.id, dropped: other.id });
    }
  }
  return out;
}
