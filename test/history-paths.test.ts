import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  agentDir,
  historyPath,
  ensureAgentDirs,
  recordedCwd,
  resolveStartCwd,
  removeEmptyOverlayCwds,
} from '../lib/history.js';
import { AgentManager } from '../lib/agent-manager.js';
import { encodeCwd } from '../lib/tui-bridge.js';
import { createRing } from '../lib/sse.js';

const EXPECTED_ROOT = path.join(os.homedir(), '.grok-remote', 'agents');

test('agentDir returns ~/.grok-remote/agents/<id>', () => {
  assert.equal(agentDir('abc-123'), path.join(EXPECTED_ROOT, 'abc-123'));
});

test('historyPath returns the agent dir + history.jsonl', () => {
  assert.equal(historyPath('abc-123'), path.join(EXPECTED_ROOT, 'abc-123', 'history.jsonl'));
});

test('agentDir keeps the input id verbatim (no normalization)', () => {
  // Path traversal is the caller's responsibility — this helper does not
  // sanitize, but it should also not silently strip or rewrite. Document the
  // pass-through contract so future refactors don't quietly add normalization.
  assert.equal(agentDir(' weird-id '), path.join(EXPECTED_ROOT, ' weird-id '));
});

test('historyPath consistently composes from agentDir', () => {
  const id = 'roundtrip-test';
  assert.equal(historyPath(id), path.join(agentDir(id), 'history.jsonl'));
});

function withHomes(fn: (remote: string, grok: string) => void | Promise<void>): Promise<void> | void {
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-remote-cwd-'));
  const grok = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-home-cwd-'));
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

test('ensureAgentDirs creates the overlay dir but never cwd/', () => {
  withHomes((remote) => {
    const dir = ensureAgentDirs('abc-123');
    assert.equal(dir, path.join(remote, 'agents', 'abc-123'));
    assert.ok(fs.statSync(dir).isDirectory());
    assert.equal(fs.existsSync(path.join(dir, 'cwd')), false);
  });
});

test('recordedCwd resolves non-empty paths and keeps empty as empty', () => {
  assert.equal(recordedCwd(null), '');
  assert.equal(recordedCwd(undefined), '');
  assert.equal(recordedCwd(''), '');
  assert.equal(recordedCwd('   '), '');
  assert.equal(recordedCwd('/tmp/foo'), path.resolve('/tmp/foo'));
});

test('resolveStartCwd prefers an existing recorded cwd, else existing defaultCwd', () => {
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-start-cwd-'));
  const missing = path.join(real, 'does-not-exist');
  try {
    assert.equal(resolveStartCwd(real, '/nope'), real);
    assert.equal(resolveStartCwd(missing, real), real);
    assert.equal(resolveStartCwd('', real), real);
    assert.equal(resolveStartCwd(missing, missing), '');
    assert.equal(resolveStartCwd('', ''), '');
    assert.equal(resolveStartCwd(null, null), '');
  } finally {
    fs.rmSync(real, { recursive: true, force: true });
  }
});

test('removeEmptyOverlayCwds rmdirs empty agents/*/cwd/ only', () => {
  withHomes((remote) => {
    const emptyId = 'empty-one';
    const fullId = 'full-one';
    const missingId = 'no-cwd';
    fs.mkdirSync(path.join(remote, 'agents', emptyId, 'cwd'), { recursive: true });
    fs.mkdirSync(path.join(remote, 'agents', fullId, 'cwd'), { recursive: true });
    fs.writeFileSync(path.join(remote, 'agents', fullId, 'cwd', 'keep.txt'), 'x');
    fs.mkdirSync(path.join(remote, 'agents', missingId), { recursive: true });
    const n = removeEmptyOverlayCwds();
    assert.equal(n, 1);
    assert.equal(fs.existsSync(path.join(remote, 'agents', emptyId, 'cwd')), false);
    assert.ok(fs.existsSync(path.join(remote, 'agents', fullId, 'cwd', 'keep.txt')));
    assert.ok(fs.statSync(path.join(remote, 'agents', missingId)).isDirectory());
  });
});

test('hydrate uses empty string when meta.cwd is missing; GC runs on start', async () => {
  await withHomes(async (remote) => {
    const id = 'hyd-1';
    const dir = path.join(remote, 'agents', id);
    fs.mkdirSync(path.join(dir, 'cwd'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
      id,
      name: 'hydrated',
      wantedConnected: false,
      createdAt: '2026-08-15T00:00:00.000Z',
      lastSeen: '2026-08-15T00:00:00.000Z',
    }));
    const fullId = 'hyd-full';
    fs.mkdirSync(path.join(remote, 'agents', fullId, 'cwd'), { recursive: true });
    fs.writeFileSync(path.join(remote, 'agents', fullId, 'cwd', 'keep.txt'), 'x');
    const mgr = new AgentManager({ autoStart: true, defaultCwd: '' });
    try {
      assert.equal(mgr.get(id)?.cwd, '');
      assert.equal(fs.existsSync(path.join(dir, 'cwd')), false);
      assert.ok(fs.existsSync(path.join(remote, 'agents', fullId, 'cwd', 'keep.txt')));
    } finally {
      await mgr.shutdownAll();
    }
  });
});

test('reconcile persists recorded cwd even if missing and does not mkdir overlay cwd/', () => {
  withHomes((remote, grok) => {
    const sid = '01a0cwd0-0000-0000-0000-000000000001';
    const missing = '/this/project/does/not/exist-xyz';
    const sessDir = path.join(grok, 'sessions', encodeCwd(missing), sid);
    fs.mkdirSync(sessDir, { recursive: true });
    fs.writeFileSync(path.join(sessDir, 'summary.json'), JSON.stringify({
      info: { id: sid, cwd: missing },
      generated_title: 'Missing project',
      last_turn_summary: 'ok',
      created_at: '2026-08-15T00:00:00Z',
      updated_at: '2026-08-15T01:00:00Z',
    }));
    const mgr = new AgentManager({ autoStart: false, defaultCwd: '' });
    const result = mgr.reconcileTuiSessions();
    assert.equal(result.created, 1);
    const rec = mgr.list()[0];
    assert.ok(rec);
    assert.equal(rec!.cwd, path.resolve(missing));
    assert.equal(fs.existsSync(path.join(agentDir(rec!.id), 'cwd')), false);
    const meta = JSON.parse(fs.readFileSync(path.join(agentDir(rec!.id), 'meta.json'), 'utf8')) as { cwd?: string };
    assert.equal(meta.cwd, path.resolve(missing));
  });
});

test('spawn throws cwd required when no usable dir and does not create an overlay', async () => {
  await withHomes(async (remote) => {
    const mgr = new AgentManager({ autoStart: false, defaultCwd: '' });
    await assert.rejects(() => mgr.spawn({ cwd: '/no/such/cwd-xyz' }), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal(err.message, 'cwd required');
      return true;
    });
    assert.equal(mgr.list().length, 0);
    const agents = path.join(remote, 'agents');
    assert.equal(fs.existsSync(agents) && fs.readdirSync(agents).length > 0, false);
  });
});

test('connect throws cwd required for a recorded missing dir and does not start ACP', async () => {
  await withHomes(async () => {
    const mgr = new AgentManager({ autoStart: false, defaultCwd: '' });
    const id = 'overlay-missing-cwd';
    mgr.agents.set(id, {
      id,
      name: 'imported',
      autoNamed: true,
      modelHint: null,
      cwd: '/gone/project',
      createdAt: '2026-08-15T00:00:00.000Z',
      lastSeen: '2026-08-15T00:00:00.000Z',
      lastSessionId: 'sid-missing',
      lastError: null,
      starred: false,
      archived: false,
      archivedAt: null,
      settings: null,
      client: null,
      ring: createRing(8),
      status: 'disconnected',
      eventCounter: 0,
      wantedConnected: false,
    } as never);
    await assert.rejects(() => mgr.connect(id), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal(err.message, 'cwd required');
      return true;
    });
    assert.equal(mgr.getRaw(id)?.client, null);
  });
});
