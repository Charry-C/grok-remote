import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  encodeCwd,
  fallbackSessionTitle,
  findTuiSessionDir,
  liveEventFromUpdateRow,
  listTuiSessions,
  parseUpdatesJsonl,
  tuiSessionLooksLivedIn,
  tuiUpdatesToHistory,
} from '../lib/tui-bridge.js';

function updateLine(kind: string, extra: Record<string, unknown> = {}, ts = 1_786_791_558): string {
  return JSON.stringify({
    timestamp: ts,
    method: 'session/update',
    params: {
      update: { sessionUpdate: kind, ...extra },
    },
  });
}

const FIXTURE = [
  updateLine('user_message_chunk', { content: { type: 'text', text: 'hello' } }, 1000),
  updateLine('agent_thought_chunk', { content: { type: 'text', text: 'thinking ' } }, 1001),
  updateLine('agent_thought_chunk', { content: { type: 'text', text: 'now' } }, 1002),
  updateLine('agent_message_chunk', { content: { type: 'text', text: 'hi' } }, 1003),
  updateLine('turn_completed', { stop_reason: 'end_turn' }, 1004),
  updateLine('user_message_chunk', { content: { type: 'text', text: 'second' } }, 2000),
  updateLine('tool_call', { toolCallId: 't1', title: 'run' }, 2001),
  updateLine('tool_call_update', { toolCallId: 't1', status: 'completed' }, 2002),
  updateLine('agent_message_chunk', { content: { type: 'text', text: 'done' } }, 2003),
  updateLine('turn_completed', { stop_reason: 'end_turn' }, 2004),
].join('\n') + '\n';

test('parseUpdatesJsonl coalesces chunks into user/assistant turns and keeps tools', () => {
  const events = parseUpdatesJsonl(FIXTURE, 'sid-1');
  const names = events.map((e) => e.event);
  assert.deepEqual(names, [
    'user_message',
    'agent_thought_chunk',
    'agent_message_chunk',
    'user_message',
    'tool_call',
    'tool_call_update',
    'agent_message_chunk',
  ]);
  assert.equal(events[0]?.data['text'], 'hello');
  assert.equal(events[1]?.data['text'], 'thinking now');
  assert.equal(events[2]?.data['text'], 'hi');
  assert.equal(events[3]?.data['text'], 'second');
  const tool = events[4]?.data['update'] as { toolCallId?: string };
  assert.equal(tool && tool.toolCallId, 't1');
});

test('liveEventFromUpdateRow passes through chunk text for the live tail path', () => {
  const row = JSON.parse(updateLine('user_message_chunk', { content: { type: 'text', text: 'ping' } })) as Record<string, unknown>;
  const ev = liveEventFromUpdateRow(row);
  assert.ok(ev);
  assert.equal(ev!.event, 'user_message_chunk');
  assert.equal(ev!.data['text'], 'ping');
});

test('liveEventFromUpdateRow passes through task_backgrounded and task_completed', () => {
  const started = JSON.parse(updateLine('task_backgrounded', {
    task_id: 't-bg',
    command: 'sleep 1',
    cwd: '/work',
  })) as Record<string, unknown>;
  const evStart = liveEventFromUpdateRow(started);
  assert.ok(evStart);
  assert.equal(evStart!.event, 'task_backgrounded');
  assert.equal(evStart!.data['task_id'], 't-bg');
  assert.equal(evStart!.data['command'], 'sleep 1');

  const done = JSON.parse(updateLine('task_completed', {
    task_snapshot: { task_id: 't-bg', exit_code: 0 },
  })) as Record<string, unknown>;
  const evDone = liveEventFromUpdateRow(done);
  assert.ok(evDone);
  assert.equal(evDone!.event, 'task_completed');
  const snap = evDone!.data['task_snapshot'] as { task_id?: string };
  assert.equal(snap && snap.task_id, 't-bg');
});

function withGrokHome(fn: (home: string) => void): void {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-tui-'));
  const prev = process.env['GROK_HOME'];
  process.env['GROK_HOME'] = home;
  try { fn(home); }
  finally {
    if (prev === undefined) delete process.env['GROK_HOME'];
    else process.env['GROK_HOME'] = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('findTuiSessionDir hits cwd first, then scans other groups', () => {
  withGrokHome((home) => {
    const sid = '01a0test-0000-0000-0000-000000000001';
    const dir = path.join(home, 'sessions', encodeCwd('/work'), sid);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'updates.jsonl'), FIXTURE);
    fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({
      info: { id: sid, cwd: '/work' },
      generated_title: 'Fixture Chat',
      last_turn_summary: 'second turn',
      created_at: '2026-08-15T00:00:00Z',
      updated_at: '2026-08-15T01:00:00Z',
    }));

    assert.equal(findTuiSessionDir(sid, '/work'), dir);
    assert.equal(findTuiSessionDir(sid, '/wrong'), dir);
    assert.equal(findTuiSessionDir(sid), dir);
    assert.equal(findTuiSessionDir('missing-id'), null);
  });
});

test('tuiUpdatesToHistory reads via find and can slice to last N user turns', () => {
  withGrokHome(() => {
    const sid = '01a0test-0000-0000-0000-000000000002';
    const dir = path.join(process.env['GROK_HOME']!, 'sessions', encodeCwd('/work'), sid);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'updates.jsonl'), FIXTURE);

    const all = tuiUpdatesToHistory('/work', sid);
    assert.equal(all.filter((e) => e.event === 'user_message').length, 2);

    const last = tuiUpdatesToHistory('/work', sid, 1);
    assert.equal(last.filter((e) => e.event === 'user_message').length, 1);
    assert.equal(last[0]?.data['text'], 'second');
  });
});

test('listTuiSessions skips non-directory group entries', () => {
  withGrokHome((home) => {
    const sid = '01a0test-0000-0000-0000-000000000003';
    const dir = path.join(home, 'sessions', encodeCwd('/work'), sid);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(home, 'sessions', 'session_search.sqlite'), 'x');
    fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({
      info: { id: sid, cwd: '/work' },
      generated_title: 'Listed',
      last_turn_summary: 'ok',
      created_at: '2026-08-15T00:00:00Z',
      updated_at: '2026-08-15T01:00:00Z',
    }));
    const items = listTuiSessions(20);
    assert.equal(items.length, 1);
    assert.equal(items[0]?.sessionId, sid);
    assert.equal(items[0]?.title, 'Listed');
    assert.equal(items[0]?.cwd, '/work');
    assert.equal(items[0]?.sessionKind, 'main');
  });
});

test('listTuiSessions hides untitled handshake leftovers', () => {
  withGrokHome((home) => {
    const emptyId = '01a005b0-2f06-7992-86b6-94891c85d112';
    const realId = '01a0test-0000-0000-0000-000000000004';
    const emptyDir = path.join(home, 'sessions', encodeCwd('/tmp'), emptyId);
    const realDir = path.join(home, 'sessions', encodeCwd('/work'), realId);
    fs.mkdirSync(emptyDir, { recursive: true });
    fs.mkdirSync(realDir, { recursive: true });
    fs.writeFileSync(path.join(emptyDir, 'summary.json'), JSON.stringify({
      info: { id: emptyId, cwd: '/tmp' },
      session_summary: '',
      created_at: '2026-08-15T13:50:27Z',
      updated_at: '2026-08-15T13:50:29Z',
      num_messages: 0,
    }));
    fs.writeFileSync(path.join(realDir, 'summary.json'), JSON.stringify({
      info: { id: realId, cwd: '/work' },
      generated_title: 'Real conversation',
      last_turn_summary: 'did work',
      created_at: '2026-08-15T13:00:00Z',
      updated_at: '2026-08-15T13:10:00Z',
    }));

    const hidden = listTuiSessions(20);
    assert.equal(hidden.length, 1);
    assert.equal(hidden[0]?.sessionId, realId);

    const raw = listTuiSessions(20, { includeEmpty: true });
    assert.equal(raw.length, 2);
  });
});

test('listTuiSessions reads session_kind; missing defaults to main', () => {
  withGrokHome((home) => {
    const mainId = '01a0test-0000-0000-0000-000000000010';
    const subId = '01a0test-0000-0000-0000-000000000011';
    const mainDir = path.join(home, 'sessions', encodeCwd('/work'), mainId);
    const subDir = path.join(home, 'sessions', encodeCwd('/work'), subId);
    fs.mkdirSync(mainDir, { recursive: true });
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(mainDir, 'summary.json'), JSON.stringify({
      info: { id: mainId, cwd: '/work' },
      generated_title: 'Main chat',
      last_turn_summary: 'hello',
      created_at: '2026-08-15T00:00:00Z',
      updated_at: '2026-08-15T02:00:00Z',
    }));
    fs.writeFileSync(path.join(subDir, 'summary.json'), JSON.stringify({
      info: { id: subId, cwd: '/work' },
      session_kind: 'subagent',
      generated_title: 'Subagent run',
      last_turn_summary: 'did work',
      created_at: '2026-08-15T00:00:00Z',
      updated_at: '2026-08-15T01:00:00Z',
    }));

    const items = listTuiSessions(20);
    const byId = new Map(items.map((s) => [s.sessionId, s]));
    assert.equal(byId.get(mainId)?.sessionKind, 'main');
    assert.equal(byId.get(subId)?.sessionKind, 'subagent');
  });
});

test('tuiSessionLooksLivedIn treats the 8-char id fallback as empty', () => {
  const sid = '01a005b2-7f7b-7b00-8320-f6683d038b3d';
  assert.equal(fallbackSessionTitle(sid), '01a005b2');
  assert.equal(tuiSessionLooksLivedIn({ sessionId: sid, title: '01a005b2', summary: '' }), false);
  assert.equal(tuiSessionLooksLivedIn({ sessionId: sid, title: '01a005b2', summary: 'OK' }), true);
  assert.equal(tuiSessionLooksLivedIn({ sessionId: sid, title: 'Probe chat', summary: '' }), true);
});
