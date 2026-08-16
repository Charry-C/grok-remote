import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveConversationHistory, sliceHistoryByTurns } from '../lib/conversation-history.js';
import { encodeCwd, historyEventsToNdjson } from '../lib/tui-bridge.js';
import { append, historyPath, readAll } from '../lib/history.js';
import { AgentManager } from '../lib/agent-manager.js';
import { filterSessions, type SessionItem } from '../lib/routes/system/sessions.js';

test('sliceHistoryByTurns keeps the last N user_message events and their tails', () => {
  const lines = [
    JSON.stringify({ event: 'agent_created', data: {} }),
    JSON.stringify({ event: 'user_message', data: { text: 'one' } }),
    JSON.stringify({ event: 'agent_message_chunk', data: { text: 'a' } }),
    JSON.stringify({ event: 'user_message', data: { text: 'two' } }),
    JSON.stringify({ event: 'agent_message_chunk', data: { text: 'b' } }),
    JSON.stringify({ event: 'user_message', data: { text: 'three' } }),
    JSON.stringify({ event: 'agent_message_chunk', data: { text: 'c' } }),
  ];
  const raw = lines.join('\n') + '\n';
  const sliced = sliceHistoryByTurns(raw, { all: false, turns: 2 });
  assert.equal(sliced.totalTurns, 3);
  assert.equal(sliced.returnedTurns, 2);
  assert.match(sliced.text, /"two"/);
  assert.match(sliced.text, /"three"/);
  assert.doesNotMatch(sliced.text, /"one"/);
});

test('resolveConversationHistory prefers TUI updates.jsonl over agent history.jsonl', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-hist-'));
  const prev = process.env['GROK_HOME'];
  process.env['GROK_HOME'] = home;
  try {
    const sid = '01a0hist-0000-0000-0000-000000000009';
    const dir = path.join(home, 'sessions', encodeCwd('/root'), sid);
    fs.mkdirSync(dir, { recursive: true });
    const tui = historyEventsToNdjson([
      { at: '2026-08-15T00:00:00.000Z', event: 'user_message', data: { text: 'from tui 1' } },
      { at: '2026-08-15T00:01:00.000Z', event: 'user_message', data: { text: 'from tui 2' } },
      { at: '2026-08-15T00:02:00.000Z', event: 'user_message', data: { text: 'from tui 3' } },
    ]);
    // Write as updates.jsonl in TUI row shape so the parser, not the helper, is exercised.
    const updates = [
      JSON.stringify({ timestamp: 1_700_000_000, method: 'session/update', params: { update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'from tui 1' } } } }),
      JSON.stringify({ timestamp: 1_700_000_010, method: 'session/update', params: { update: { sessionUpdate: 'turn_completed' } } }),
      JSON.stringify({ timestamp: 1_700_000_020, method: 'session/update', params: { update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'from tui 2' } } } }),
      JSON.stringify({ timestamp: 1_700_000_030, method: 'session/update', params: { update: { sessionUpdate: 'turn_completed' } } }),
      JSON.stringify({ timestamp: 1_700_000_040, method: 'session/update', params: { update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'from tui 3' } } } }),
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(dir, 'updates.jsonl'), updates);
    void tui;

    const resolved = resolveConversationHistory({
      agentId: 'does-not-matter',
      sessionId: sid,
      cwd: '/root',
      all: true,
      turns: 50,
    });
    assert.equal(resolved.source, 'tui');
    assert.equal(resolved.totalTurns, 3);
    assert.match(resolved.text, /from tui 3/);
  } finally {
    if (prev === undefined) delete process.env['GROK_HOME'];
    else process.env['GROK_HOME'] = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

function withHomes(fn: (remote: string, grok: string) => void | Promise<void>): Promise<void> | void {
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-remote-hist-'));
  const grok = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-home-hist-'));
  const prevRemote = process.env['GROK_REMOTE_HOME'];
  const prevGrok = process.env['GROK_HOME'];
  process.env['GROK_REMOTE_HOME'] = remote;
  process.env['GROK_HOME'] = grok;
  const done = (): void => {
    if (prevRemote === undefined) delete process.env['GROK_REMOTE_HOME'];
    else process.env['GROK_REMOTE_HOME'] = prevRemote;
    if (prevGrok === undefined) delete process.env['GROK_HOME'];
    else process.env['GROK_HOME'] = prevGrok;
    fs.rmSync(remote, { recursive: true, force: true });
    fs.rmSync(grok, { recursive: true, force: true });
  };
  try {
    const out = fn(remote, grok);
    if (out && typeof (out as Promise<void>).then === 'function') {
      return (out as Promise<void>).finally(done);
    }
    done();
  } catch (err) {
    done();
    throw err;
  }
}

test('append writes overlay jsonl during handshake (no tuiPresent)', () => {
  withHomes(() => {
    const id = 'handshake-1';
    append(id, { event: 'user_message', data: { text: 'hi' } });
    append(id, { event: 'user_message', data: { text: 'again' } });
    const raw = readAll(id);
    assert.match(raw, /"hi"/);
    assert.match(raw, /"again"/);
    assert.ok(fs.existsSync(historyPath(id)));
  });
});

test('append is a no-op when tuiPresent and does not delete an existing history.jsonl', () => {
  withHomes(() => {
    const id = 'shadow-1';
    append(id, { event: 'user_message', data: { text: 'keep me' } });
    const before = readAll(id);
    assert.match(before, /keep me/);
    append(id, { event: 'user_message', data: { text: 'should not land' } }, { tuiPresent: true });
    assert.equal(readAll(id), before);
    assert.ok(fs.existsSync(historyPath(id)));

    const missing = 'never-created';
    append(missing, { event: 'user_message', data: { text: 'nope' } }, { tuiPresent: true });
    assert.equal(fs.existsSync(historyPath(missing)), false);
  });
});

test('SSE historyAppend is a no-op once findTuiSessionDir hits', async () => {
  await withHomes(async (remote, grok) => {
    const id = 'live-skip-1';
    const sid = '01a0skip-0000-0000-0000-000000000001';
    const overlay = path.join(remote, 'agents', id);
    fs.mkdirSync(overlay, { recursive: true });
    fs.writeFileSync(path.join(overlay, 'meta.json'), JSON.stringify({
      id,
      name: 'skip-write',
      cwd: '/work',
      lastSessionId: sid,
      wantedConnected: false,
      createdAt: '2026-08-15T00:00:00.000Z',
      lastSeen: '2026-08-15T00:00:00.000Z',
    }));
    const leftover = '{"event":"user_message","data":{"text":"stale overlay"}}\n';
    fs.writeFileSync(path.join(overlay, 'history.jsonl'), leftover);

    const tuiDir = path.join(grok, 'sessions', encodeCwd('/work'), sid);
    fs.mkdirSync(tuiDir, { recursive: true });
    const updates = path.join(tuiDir, 'updates.jsonl');
    fs.writeFileSync(updates, '');

    const mgr = new AgentManager({ autoStart: true, defaultCwd: '' });
    try {
      const stop = mgr.beginView(id);
      fs.appendFileSync(updates, JSON.stringify({
        timestamp: 1_700_000_100,
        method: 'session/update',
        params: { update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'from tail' } } },
      }) + '\n');
      mgr.pollUpdateTails();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(fs.readFileSync(path.join(overlay, 'history.jsonl'), 'utf8'), leftover);
      stop();
    } finally {
      await mgr.shutdownAll();
    }
  });
});

test('filterSessions matches id, title, summary, and cwd', () => {
  const items: SessionItem[] = [
    { sessionId: 'aaa', created: '', updated: '', status: 'local', summary: 'Traffic check', cwd: '/root', title: 'Today Server' },
    { sessionId: 'bbb', created: '', updated: '', status: 'local', summary: 'other', cwd: '/tmp', title: 'Hello' },
  ];
  assert.equal(filterSessions(items, 'traffic').length, 1);
  assert.equal(filterSessions(items, 'bbb').length, 1);
  assert.equal(filterSessions(items, '/tmp').length, 1);
  assert.equal(filterSessions(items, 'nope').length, 0);
  assert.equal(filterSessions(items, '').length, 2);
});
