// Join official TUI sessions with overlay pointers for the Sessions page.

import { holderForSession, type HeldBy } from './session-ownership.js';
import { listTuiSessions, tuiSessionLooksLivedIn, type TuiSession } from './tui-bridge.js';
import { pickOverlayForSession } from './tui-reconcile.js';

export interface SessionItem {
  sessionId: string;
  created: string;
  updated: string;
  status: string;
  summary: string;
  cwd: string;
  title: string;
}

export interface OverlayListItem {
  id: string;
  lastSessionId?: string | null;
  sessionId?: string | null;
  archived?: boolean;
  createdAt?: string;
  starred?: boolean;
  heldBy?: HeldBy;
}

export interface JoinedSessionItem extends SessionItem {
  overlayId: string | null;
  heldBy: HeldBy;
  starred: boolean;
  archived: boolean;
  livedIn: boolean;
  sessionKind: 'main' | 'subagent';
  source: 'tui';
}

export function clampLimit(raw: string | null): number {
  const n = parseInt(raw || '', 10);
  if (!Number.isFinite(n) || n <= 0) return 20;
  if (n > 200) return 200;
  return n;
}

export function filterSessions<T extends SessionItem>(items: T[], q: string): T[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return items;
  return items.filter((it) => {
    return it.sessionId.toLowerCase().includes(needle)
        || it.summary.toLowerCase().includes(needle)
        || it.title.toLowerCase().includes(needle)
        || it.cwd.toLowerCase().includes(needle);
  });
}

export function parseSessionsQuery(reqUrl: string): {
  q: string;
  limit: number;
  includeEmpty: boolean;
} {
  const urlObj = new URL(reqUrl || '/', 'http://x');
  return {
    q: (urlObj.searchParams.get('q') || '').trim(),
    limit: clampLimit(urlObj.searchParams.get('limit')),
    includeEmpty: urlObj.searchParams.get('includeEmpty') === '1',
  };
}

export function joinTuiAndOverlays(
  sessions: TuiSession[],
  overlays: OverlayListItem[],
  lookupHeldBy: (sessionId: string) => HeldBy = holderForSession,
): JoinedSessionItem[] {
  const bySid = new Map<string, OverlayListItem[]>();
  for (const a of overlays) {
    const keys = new Set<string>();
    if (a.lastSessionId) keys.add(a.lastSessionId);
    if (a.sessionId) keys.add(a.sessionId);
    for (const sid of keys) {
      const arr = bySid.get(sid);
      if (arr) arr.push(a);
      else bySid.set(sid, [a]);
    }
  }

  return sessions.map((s) => {
    const pick = pickOverlayForSession(bySid.get(s.sessionId) || []);
    return {
      sessionId: s.sessionId,
      overlayId: pick ? pick.id : null,
      title: s.title || '',
      summary: s.summary || s.title || '',
      cwd: s.cwd || '',
      created: (s.createdAt || '').slice(0, 10),
      updated: (s.updatedAt || '').slice(0, 10),
      status: 'local',
      heldBy: pick ? (pick.heldBy ?? null) : lookupHeldBy(s.sessionId),
      starred: !!(pick && pick.starred),
      archived: !!(pick && pick.archived),
      livedIn: tuiSessionLooksLivedIn(s),
      sessionKind: s.sessionKind === 'subagent' ? 'subagent' : 'main',
      source: 'tui' as const,
    };
  });
}

export function listJoinedSystemSessions(
  reqUrl: string,
  overlays: OverlayListItem[],
  listTui: (limit: number, opts?: { includeEmpty?: boolean }) => TuiSession[] = listTuiSessions,
): { ok: true; items: JoinedSessionItem[]; raw: '' } {
  // Parse req.url (query still attached). createServer strips '?' before
  // handleSystem, so this must run on the raw request URL.
  const { q, limit, includeEmpty } = parseSessionsQuery(reqUrl);
  const tui = listTui(200, { includeEmpty });
  const items = filterSessions(joinTuiAndOverlays(tui, overlays), q).slice(0, limit);
  return { ok: true, items, raw: '' };
}
