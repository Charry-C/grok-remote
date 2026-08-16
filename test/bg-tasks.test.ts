import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AgentManager } from '../lib/agent-manager.js';
import {
  applyBgTaskUpdate,
  extractSessionUpdate,
  hydrateBgTasksForAgent,
  hydrateBgTasksFromEvents,
} from '../lib/bg-tasks.js';
import { encodeCwd } from '../lib/tui-bridge.js';

function withHomes(fn: (remote: string, grok: string) => void | Promise<void>): Promise<void> | void {
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-remote-bg-'));
  const grok = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-home-bg-'));
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

const overlayLine = JSON.stringify({
  at: '2026-08-15T00:00:00.000Z',
  event: 'x.ai/session/update',
  data: { params: { update: { sessionUpdate: 'task_backgrounded', task_id: 'from-data-params', command: 'overlay' } } },
});
const tuiLine = JSON.stringify({
  timestamp: 1_700_000_000,
  method: 'session/update',
  params: { update: { sessionUpdate: 'task_backgrounded', task_id: 'from-params', command: 'tui' } },
});
const topUpdateLine = JSON.stringify({
  update: { sessionUpdate: 'task_backgrounded', task_id: 'from-top-update', command: 'bare' },
});

test('extractSessionUpdate reads data.params.update, params.update, and update', () => {
  const a = extractSessionUpdate(JSON.parse(overlayLine));
  assert.equal(a && a['task_id'], 'from-data-params');
  const b = extractSessionUpdate(JSON.parse(tuiLine));
  assert.equal(b && b['task_id'], 'from-params');
  const c = extractSessionUpdate(JSON.parse(topUpdateLine));
  assert.equal(c && c['task_id'], 'from-top-update');
  const d = extractSessionUpdate({ sessionUpdate: 'task_backgrounded', task_id: 'bare' });
  assert.equal(d && d['task_id'], 'bare');
});

test('hydrateBgTasksFromEvents applies backgrounded, completed, and TaskOutput', () => {
  const lines = [
    overlayLine,
    JSON.stringify({
      at: '2026-08-15T00:00:10.000Z',
      event: 'x.ai/session/update',
      data: { params: { update: { sessionUpdate: 'task_completed', task_snapshot: { task_id: 'from-data-params', exit_code: 0 } } } },
    }),
    JSON.stringify({
      event: 'tool_call_update',
      data: { update: { sessionUpdate: 'tool_call_update', rawOutput: { type: 'TaskOutput', Result: { task_id: 'from-data-params', output: 'hello out' } } } },
    }),
  ];
  const map = hydrateBgTasksFromEvents(lines);
  const t = map.get('from-data-params');
  assert.ok(t);
  assert.equal(t!.completed, true);
  assert.equal(t!.exit_code, 0);
  assert.equal(t!.cached_output, 'hello out');
  assert.equal(t!.command, 'overlay');
});

test('hydrateBgTasksForAgent prefers TUI updates.jsonl and ignores overlay tasks', () => {
  withHomes((remote, grok) => {
    const id = 'bg-pref-1';
    const sid = '01a0bg00-0000-0000-0000-000000000001';
    const overlay = path.join(remote, 'agents', id);
    fs.mkdirSync(overlay, { recursive: true });
    fs.writeFileSync(path.join(overlay, 'history.jsonl'), overlayLine + '\n');
    const tuiDir = path.join(grok, 'sessions', encodeCwd('/work'), sid);
    fs.mkdirSync(tuiDir, { recursive: true });
    fs.writeFileSync(path.join(tuiDir, 'updates.jsonl'), tuiLine + '\n');

    const map = hydrateBgTasksForAgent({ agentId: id, sessionId: sid, cwd: '/work' });
    assert.equal(map.has('from-params'), true);
    assert.equal(map.has('from-data-params'), false);
    assert.equal(map.get('from-params')?.command, 'tui');
  });
});

test('hydrateBgTasksForAgent falls back to overlay when TUI has no tasks', () => {
  withHomes((remote, grok) => {
    const id = 'bg-fb-1';
    const sid = '01a0bg00-0000-0000-0000-000000000002';
    const overlay = path.join(remote, 'agents', id);
    fs.mkdirSync(overlay, { recursive: true });
    fs.writeFileSync(path.join(overlay, 'history.jsonl'), overlayLine + '\n');
    const tuiDir = path.join(grok, 'sessions', encodeCwd('/work'), sid);
    fs.mkdirSync(tuiDir, { recursive: true });
    fs.writeFileSync(path.join(tuiDir, 'updates.jsonl'), '{}\n');
    fs.writeFileSync(path.join(tuiDir, 'summary.json'), JSON.stringify({ info: { id: sid, cwd: '/work' } }));

    const map = hydrateBgTasksForAgent({ agentId: id, sessionId: sid, cwd: '/work' });
    assert.equal(map.has('from-data-params'), true);
    assert.equal(map.get('from-data-params')?.command, 'overlay');
  });
});

test('hydrateBgTasksForAgent uses overlay when there is no TUI dir', () => {
  withHomes((remote) => {
    const id = 'bg-overlay-only';
    fs.mkdirSync(path.join(remote, 'agents', id), { recursive: true });
    fs.writeFileSync(path.join(remote, 'agents', id, 'history.jsonl'), overlayLine + '\n');
    const map = hydrateBgTasksForAgent({ agentId: id, sessionId: 'missing', cwd: '/work' });
    assert.equal(map.has('from-data-params'), true);
  });
});

test('AgentManager hydrate reads TUI updates first', async () => {
  await withHomes(async (remote, grok) => {
    const id = 'bg-mgr-1';
    const sid = '01a0bg00-0000-0000-0000-000000000003';
    const overlay = path.join(remote, 'agents', id);
    fs.mkdirSync(overlay, { recursive: true });
    fs.writeFileSync(path.join(overlay, 'meta.json'), JSON.stringify({
      id,
      name: 'hydrated-bg',
      cwd: '/work',
      lastSessionId: sid,
      wantedConnected: false,
      createdAt: '2026-08-15T00:00:00.000Z',
      lastSeen: '2026-08-15T00:00:00.000Z',
    }));
    fs.writeFileSync(path.join(overlay, 'history.jsonl'), overlayLine + '\n');
    const tuiDir = path.join(grok, 'sessions', encodeCwd('/work'), sid);
    fs.mkdirSync(tuiDir, { recursive: true });
    fs.writeFileSync(path.join(tuiDir, 'updates.jsonl'), tuiLine + '\n');

    const mgr = new AgentManager({ autoStart: true, defaultCwd: '' });
    try {
      const rec = mgr.getRaw(id);
      assert.ok(rec?.bgTasks?.has('from-params'));
      assert.equal(rec?.bgTasks?.has('from-data-params'), false);
    } finally {
      await mgr.shutdownAll();
    }
  });
});

test('observed tail applies task_backgrounded onto the bg panel map', async () => {
  await withHomes(async (remote, grok) => {
    const id = 'bg-live-1';
    const sid = '01a0bg00-0000-0000-0000-000000000004';
    const overlay = path.join(remote, 'agents', id);
    fs.mkdirSync(overlay, { recursive: true });
    fs.writeFileSync(path.join(overlay, 'meta.json'), JSON.stringify({
      id,
      name: 'live-bg',
      cwd: '/work',
      lastSessionId: sid,
      wantedConnected: false,
      createdAt: '2026-08-15T00:00:00.000Z',
      lastSeen: '2026-08-15T00:00:00.000Z',
    }));
    const tuiDir = path.join(grok, 'sessions', encodeCwd('/work'), sid);
    fs.mkdirSync(tuiDir, { recursive: true });
    const updates = path.join(tuiDir, 'updates.jsonl');
    fs.writeFileSync(updates, '');

    const mgr = new AgentManager({ autoStart: true, defaultCwd: '' });
    try {
      const stop = mgr.beginView(id);
      fs.appendFileSync(updates, JSON.stringify({
        timestamp: 1_700_000_300,
        method: 'session/update',
        params: {
          update: {
            sessionUpdate: 'task_backgrounded',
            task_id: 'live-1',
            command: 'sleep 9',
            cwd: '/work',
          },
        },
      }) + '\n');
      mgr.pollUpdateTails();
      const rec = mgr.getRaw(id);
      assert.ok(rec?.bgTasks?.has('live-1'));
      assert.equal(rec?.bgTasks?.get('live-1')?.command, 'sleep 9');
      assert.equal(rec?.bgTasks?.get('live-1')?.completed, false);
      assert.equal(fs.existsSync(path.join(overlay, 'history.jsonl')), false);
      stop();
    } finally {
      await mgr.shutdownAll();
    }
  });
});

test('applyBgTaskUpdate ignores completed for an unknown task id', () => {
  const map = new Map();
  const changed = applyBgTaskUpdate(map, {
    sessionUpdate: 'task_completed',
    task_snapshot: { task_id: 'nope', exit_code: 1 },
  });
  assert.equal(changed, false);
  assert.equal(map.size, 0);
});
