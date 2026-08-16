import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isPruneableUntitledImport,
  pickOverlayForSession,
  planTuiReconcile,
} from '../lib/tui-reconcile.js';
import type { TuiSession } from '../lib/tui-bridge.js';

function sess(id: string, title = `Chat ${id}`, extra: Partial<TuiSession> = {}): TuiSession {
  return {
    sessionId: id,
    cwd: '/root',
    title,
    summary: title,
    createdAt: '2026-08-15T00:00:00Z',
    updatedAt: '2026-08-15T01:00:00Z',
    model: 'grok-4.6',
    turns: 1,
    contextTokensUsed: 0,
    contextWindowTokens: 0,
    contextWindowUsage: 0,
    toolCallCount: 0,
    sessionKind: 'main',
    source: 'tui',
    ...extra,
  };
}

function emptySess(id: string): TuiSession {
  return {
    ...sess(id, id.slice(0, 8)),
    summary: '',
    turns: 0,
  };
}

test('pickOverlayForSession prefers live, then oldest createdAt', () => {
  assert.equal(pickOverlayForSession([]), null);
  const archivedOld = { id: 'arch-old', archived: true, createdAt: '2026-01-01T00:00:00Z' };
  const archivedNew = { id: 'arch-new', archived: true, createdAt: '2026-03-01T00:00:00Z' };
  const liveNew = { id: 'live-new', archived: false, createdAt: '2026-04-01T00:00:00Z' };
  const liveOld = { id: 'live-old', archived: false, createdAt: '2026-02-01T00:00:00Z' };
  assert.equal(pickOverlayForSession([archivedOld, liveNew, liveOld])?.id, 'live-old');
  assert.equal(pickOverlayForSession([archivedNew, archivedOld])?.id, 'arch-old');
  const undated = { id: 'no-date' };
  assert.equal(pickOverlayForSession([undated])?.id, 'no-date');
});

test('planTuiReconcile updates existing lastSessionId matches and creates the rest', () => {
  const plan = planTuiReconcile(
    [
      { id: 'agent-a', lastSessionId: 'sid-a' },
      { id: 'agent-b', lastSessionId: 'sid-b', archived: true },
      { id: 'agent-c', lastSessionId: null },
    ],
    [sess('sid-a', 'Known'), sess('sid-b', 'Archived match'), sess('sid-new', 'Fresh')],
  );
  assert.deepEqual(plan.update.map((u) => u.agentId), ['agent-a', 'agent-b']);
  assert.deepEqual(plan.create.map((s) => s.sessionId), ['sid-new']);
  assert.deepEqual(plan.drop, []);
});

test('planTuiReconcile claims sid with the live twin when archived+live coexist', () => {
  const plan = planTuiReconcile(
    [
      { id: 'arch', lastSessionId: 'sid-1', archived: true, createdAt: '2026-01-01T00:00:00Z' },
      { id: 'live', lastSessionId: 'sid-1', createdAt: '2026-02-01T00:00:00Z' },
    ],
    [sess('sid-1', 'Twins')],
  );
  assert.deepEqual(plan.update.map((u) => u.agentId), ['live']);
  assert.deepEqual(plan.create, []);
});

test('planTuiReconcile does not create subagent overlays', () => {
  const plan = planTuiReconcile(
    [],
    [
      sess('sid-sub', 'Background task', { sessionKind: 'subagent' }),
      sess('sid-new', 'Fresh'),
    ],
  );
  assert.deepEqual(plan.create.map((s) => s.sessionId), ['sid-new']);
  assert.deepEqual(plan.update, []);
});

test('planTuiReconcile still updates an already-imported subagent overlay', () => {
  const plan = planTuiReconcile(
    [{ id: 'already', lastSessionId: 'sid-sub' }],
    [sess('sid-sub', 'Background task', { sessionKind: 'subagent' })],
  );
  assert.deepEqual(plan.update.map((u) => u.agentId), ['already']);
  assert.deepEqual(plan.create, []);
  assert.deepEqual(plan.drop, []);
});

test('planTuiReconcile does not duplicate a session already claimed', () => {
  const plan = planTuiReconcile(
    [{ id: 'one', lastSessionId: 'sid-1' }],
    [sess('sid-1'), sess('sid-1')],
  );
  assert.equal(plan.update.length, 2);
  assert.equal(plan.create.length, 0);
  assert.deepEqual(plan.drop, []);
});

test('planTuiReconcile does not import untitled handshake leftovers', () => {
  const plan = planTuiReconcile(
    [],
    [emptySess('01a005b0-2f06-7992-86b6-94891c85d112'), sess('sid-real', 'Real chat')],
  );
  assert.deepEqual(plan.create.map((s) => s.sessionId), ['sid-real']);
  assert.deepEqual(plan.drop, []);
});

test('planTuiReconcile drops unused untitled auto-imports', () => {
  const sid = '01a005b2-7f7b-7b00-8320-f6683d038b3d';
  const plan = planTuiReconcile(
    [{
      id: 'junk',
      lastSessionId: sid,
      name: sid.slice(0, 8),
      autoNamed: true,
      wantedConnected: false,
    }],
    [emptySess(sid)],
  );
  assert.deepEqual(plan.update, []);
  assert.deepEqual(plan.create, []);
  assert.deepEqual(plan.drop, ['junk']);
});

test('planTuiReconcile keeps starred, renamed, or connected untitled imports', () => {
  const sid = '01a005b1-11a9-73b3-a402-f4a4f984c004';
  const empty = emptySess(sid);
  const base = { lastSessionId: sid, name: sid.slice(0, 8), autoNamed: true, wantedConnected: false };
  const plan = planTuiReconcile(
    [
      { id: 'starred', ...base, starred: true },
      { id: 'renamed', ...base, autoNamed: false, name: 'Keep me' },
      { id: 'live', ...base, connected: true },
      { id: 'wanted', ...base, wantedConnected: true },
    ],
    [empty, empty, empty, empty],
  );
  assert.deepEqual(plan.drop, []);
});

test('isPruneableUntitledImport requires the 8-char session-id name', () => {
  const sid = '01a005b0-d0be-7cc3-bb71-ce0734ef155f';
  assert.equal(isPruneableUntitledImport({
    id: 'a', lastSessionId: sid, name: 'agent-deadbeef', autoNamed: true,
  }, sid), false);
  assert.equal(isPruneableUntitledImport({
    id: 'b', lastSessionId: sid, name: sid.slice(0, 8), autoNamed: true,
  }, sid), true);
});
