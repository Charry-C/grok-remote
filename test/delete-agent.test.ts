import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  deleteAgentWithOptionalTui,
  safeTuiDirForDelete,
  tuiDirUnderSessionsRoot,
  waitUntilPidGone,
  wantsDeleteTuiSession,
} from '../lib/delete-agent.js';
import { encodeCwd, sessionsRoot } from '../lib/tui-bridge.js';
import { isPidAlive } from '../lib/session-ownership.js';

test('wantsDeleteTuiSession is only the literal query 1', () => {
  assert.equal(wantsDeleteTuiSession('/api/agents/x?deleteTuiSession=1'), true);
  assert.equal(wantsDeleteTuiSession('/api/agents/x'), false);
  assert.equal(wantsDeleteTuiSession('/api/agents/x?deleteTuiSession=true'), false);
  assert.equal(wantsDeleteTuiSession(undefined), false);
});

test('tuiDirUnderSessionsRoot rejects paths outside sessionsRoot', () => {
  const root = path.resolve(sessionsRoot());
  assert.equal(tuiDirUnderSessionsRoot(path.join(root, 'group', 'sid-1')), path.join(root, 'group', 'sid-1'));
  assert.equal(tuiDirUnderSessionsRoot(root), null);
  assert.equal(tuiDirUnderSessionsRoot('/tmp/not-a-grok-session'), null);
  assert.equal(tuiDirUnderSessionsRoot(path.join(root, '..', 'outside')), null);
});

test('DELETE heldBy tui is 409 and does not kill or rm', async () => {
  let killed = false;
  let removed: string[] = [];
  const out = await deleteAgentWithOptionalTui({
    deleteTuiSession: true,
    heldBy: 'tui',
    hasLocalAcp: false,
    sessionId: '01a0tui-0000-0000-0000-000000000001',
    overlayId: 'ov-tui',
    kill: async () => { killed = true; return true; },
    resolveTuiDir: () => '/tmp/tui-dir',
    rmTui: (d) => { removed.push(d); },
  });
  assert.equal(out.status, 409);
  assert.equal(out.body.heldBy, 'tui');
  assert.equal(out.removedTui, false);
  assert.equal(killed, false);
  assert.deepEqual(removed, []);
});

test('DELETE without deleteTuiSession removes overlay only', async () => {
  let killed = false;
  const removed: string[] = [];
  const out = await deleteAgentWithOptionalTui({
    deleteTuiSession: false,
    heldBy: null,
    hasLocalAcp: false,
    sessionId: '01a0off-0000-0000-0000-000000000001',
    overlayId: 'ov-off',
    kill: async () => { killed = true; return true; },
    resolveTuiDir: () => '/tmp/tui-dir',
    rmTui: (d) => { removed.push(d); },
  });
  assert.deepEqual(out, { status: 200, body: { ok: true }, removedTui: false });
  assert.equal(killed, true);
  assert.deepEqual(removed, []);
});

test('DELETE path outside sessionsRoot does not rm', async () => {
  const grok = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-del-out-'));
  const prev = process.env['GROK_HOME'];
  process.env['GROK_HOME'] = grok;
  try {
    const sid = '01a0out-0000-0000-0000-000000000001';
    const outside = path.join(grok, 'outside-session');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'summary.json'), '{}');
    assert.equal(tuiDirUnderSessionsRoot(outside), null);
    assert.equal(safeTuiDirForDelete(sid, '/work'), null);

    const removed: string[] = [];
    let killed = false;
    const out = await deleteAgentWithOptionalTui({
      deleteTuiSession: true,
      heldBy: null,
      hasLocalAcp: false,
      sessionId: sid,
      cwd: '/work',
      overlayId: 'ov-out',
      kill: async () => { killed = true; return true; },
      resolveTuiDir: () => tuiDirUnderSessionsRoot(outside),
      rmTui: (d) => { removed.push(d); },
    });
    assert.deepEqual(out, { status: 200, body: { ok: true }, removedTui: false });
    assert.equal(killed, true);
    assert.deepEqual(removed, []);
    assert.equal(fs.existsSync(path.join(outside, 'summary.json')), true);
  } finally {
    if (prev === undefined) delete process.env['GROK_HOME'];
    else process.env['GROK_HOME'] = prev;
    fs.rmSync(grok, { recursive: true, force: true });
  }
});

test('DELETE disconnected + deleteTuiSession rms TUI after kill', async () => {
  const removed: string[] = [];
  const events: string[] = [];
  const out = await deleteAgentWithOptionalTui({
    deleteTuiSession: true,
    heldBy: null,
    hasLocalAcp: false,
    sessionId: '01a0free-0000-0000-0000-000000000001',
    overlayId: 'ov-free',
    kill: async () => { events.push('kill'); return true; },
    resolveTuiDir: () => '/tmp/safe-tui',
    rmTui: (d) => { events.push('rm'); removed.push(d); },
  });
  assert.deepEqual(out, { status: 200, body: { ok: true }, removedTui: true });
  assert.deepEqual(events, ['kill', 'rm']);
  assert.deepEqual(removed, ['/tmp/safe-tui']);
});

test('DELETE local ACP waits until the child is dead before rm', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
    stdio: 'ignore',
  });
  // Reap so isPidAlive goes false after SIGTERM (otherwise the child zombies).
  child.on('exit', () => { /* reap */ });
  const pid = child.pid;
  assert.ok(pid);
  const events: string[] = [];
  try {
    const out = await deleteAgentWithOptionalTui({
      deleteTuiSession: true,
      heldBy: null,
      hasLocalAcp: true,
      localPid: pid,
      sessionId: '01a0acp-0000-0000-0000-000000000001',
      overlayId: 'ov-acp',
      kill: async () => {
        events.push('kill');
        child.kill('SIGTERM');
        return true;
      },
      resolveTuiDir: () => '/tmp/safe-tui',
      rmTui: () => {
        assert.equal(isPidAlive(pid), false, 'TUI dir must not be removed while ACP is alive');
        events.push('rm');
      },
      wait: { holder: () => null, timeoutMs: 4000, intervalMs: 20 },
    });
    assert.equal(out.status, 200);
    assert.equal(out.removedTui, true);
    assert.deepEqual(events, ['kill', 'rm']);
  } finally {
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
  }
});

test('DELETE local ACP 409s and keeps TUI if a pager grabs the session', async () => {
  const removed: string[] = [];
  const out = await deleteAgentWithOptionalTui({
    deleteTuiSession: true,
    heldBy: null,
    hasLocalAcp: true,
    localPid: null,
    sessionId: '01a0grab-0000-0000-0000-000000000001',
    overlayId: 'ov-grab',
    kill: async () => true,
    resolveTuiDir: () => '/tmp/safe-tui',
    rmTui: (d) => { removed.push(d); },
    wait: { holder: () => 'tui', timeoutMs: 20, intervalMs: 5 },
  });
  assert.equal(out.status, 409);
  assert.equal(out.body.heldBy, 'tui');
  assert.equal(out.removedTui, false);
  assert.deepEqual(removed, []);
});

test('waitUntilPidGone returns true when the process exits', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
    stdio: 'ignore',
  });
  child.on('exit', () => { /* reap */ });
  const pid = child.pid!;
  try {
    child.kill('SIGTERM');
    assert.equal(await waitUntilPidGone(pid, { timeoutMs: 4000, intervalMs: 20 }), true);
    assert.equal(isPidAlive(pid), false);
  } finally {
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
  }
});

test('safeTuiDirForDelete finds a real TUI dir under GROK_HOME', () => {
  const grok = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-del-safe-'));
  const prev = process.env['GROK_HOME'];
  process.env['GROK_HOME'] = grok;
  try {
    const sid = '01a0safe-0000-0000-0000-000000000001';
    const cwd = '/work';
    const dir = path.join(grok, 'sessions', encodeCwd(cwd), sid);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'summary.json'), '{}');
    assert.equal(safeTuiDirForDelete(sid, cwd), dir);
  } finally {
    if (prev === undefined) delete process.env['GROK_HOME'];
    else process.env['GROK_HOME'] = prev;
    fs.rmSync(grok, { recursive: true, force: true });
  }
});
