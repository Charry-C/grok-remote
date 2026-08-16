// Resolve chat history for an agent: TUI updates.jsonl first, then
// ~/.grok-remote/agents/<id>/history.jsonl as a fallback.

import { readAll as readAgentHistory } from './history.js';
import {
  findTuiSessionDir,
  historyEventsToNdjson,
  tuiUpdatesToHistory,
} from './tui-bridge.js';

export interface SliceHistoryOptions {
  all: boolean;
  turns: number;
}

export interface SliceHistoryResult {
  text: string;
  totalTurns: number;
  returnedTurns: number;
  source: 'tui' | 'agent' | 'empty';
}

export function sliceHistoryByTurns(raw: string, { all, turns }: SliceHistoryOptions): SliceHistoryResult {
  if (!raw) return { text: '', totalTurns: 0, returnedTurns: 0, source: 'empty' };
  const lines = raw.split('\n').filter(Boolean);
  const userMessageIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] || '';
    if (line.indexOf('"user_message"') === -1) continue;
    try {
      const obj = JSON.parse(line) as { event?: string };
      if (obj && obj.event === 'user_message') userMessageIndices.push(i);
    } catch { /* skip malformed */ }
  }
  const totalTurns = userMessageIndices.length;
  if (all || totalTurns <= turns) {
    return { text: lines.join('\n') + (lines.length ? '\n' : ''), totalTurns, returnedTurns: totalTurns, source: 'empty' };
  }
  const cutoffLineIdx = userMessageIndices[totalTurns - turns];
  if (cutoffLineIdx == null) {
    return { text: lines.join('\n') + (lines.length ? '\n' : ''), totalTurns, returnedTurns: totalTurns, source: 'empty' };
  }
  const sliced = lines.slice(cutoffLineIdx);
  return { text: sliced.join('\n') + '\n', totalTurns, returnedTurns: turns, source: 'empty' };
}

export interface ResolveHistoryArgs {
  agentId: string;
  sessionId?: string | null;
  cwd?: string | null;
  all: boolean;
  turns: number;
}

export function resolveConversationHistory(args: ResolveHistoryArgs): SliceHistoryResult {
  const { agentId, sessionId, cwd, all, turns } = args;
  const sid = (sessionId || '').trim();
  if (sid && findTuiSessionDir(sid, cwd)) {
    const events = tuiUpdatesToHistory(cwd, sid);
    const sliced = sliceHistoryByTurns(historyEventsToNdjson(events), { all, turns });
    return { ...sliced, source: events.length || sliced.totalTurns ? 'tui' : 'tui' };
  }
  const fallback = sliceHistoryByTurns(readAgentHistory(agentId) || '', { all, turns });
  return { ...fallback, source: fallback.text ? 'agent' : 'empty' };
}
