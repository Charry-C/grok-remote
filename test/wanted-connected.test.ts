import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AgentManager, shouldKeepConnected } from '../lib/agent-manager.js';

test('shouldKeepConnected is false when the flag is missing', () => {
  assert.equal(shouldKeepConnected({}), false);
  assert.equal(shouldKeepConnected({ wantedConnected: undefined }), false);
  assert.equal(shouldKeepConnected({ wantedConnected: null }), false);
});

test('shouldKeepConnected is false after an explicit user disconnect', () => {
  assert.equal(shouldKeepConnected({ wantedConnected: false }), false);
});

test('shouldKeepConnected keeps an explicit true', () => {
  assert.equal(shouldKeepConnected({ wantedConnected: true }), true);
});

test('shouldKeepConnected is false for archived conversations even if wanted', () => {
  assert.equal(shouldKeepConnected({ archived: true, wantedConnected: true }), false);
  assert.equal(shouldKeepConnected({ archived: true }), false);
});

function withHomes(fn: (remote: string) => void | Promise<void>): Promise<void> | void {
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-wanted-'));
  const grok = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-home-wanted-'));
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
    const out = fn(remote);
    if (out && typeof (out as Promise<void>).then === 'function') {
      return (out as Promise<void>).finally(done);
    }
    done();
  } catch (err) {
    done();
    throw err;
  }
}

function writeOverlay(remote: string, id: string, meta: Record<string, unknown>): void {
  const dir = path.join(remote, 'agents', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    id,
    name: id,
    autoNamed: true,
    cwd: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastSeen: '2026-01-01T00:00:00.000Z',
    ...meta,
  }, null, 2));
}

test('hydrate treats a missing wantedConnected key as false and persists it once', async () => {
  await withHomes(async (remote) => {
    writeOverlay(remote, 'missing-flag', {});
    const mgr = new AgentManager({ autoStart: true, defaultCwd: '' });
    await mgr.shutdownAll();
    const rec = mgr.get('missing-flag');
    assert.equal(rec?.wantedConnected, false);
    const disk = JSON.parse(fs.readFileSync(path.join(remote, 'agents', 'missing-flag', 'meta.json'), 'utf8'));
    assert.equal(disk.wantedConnected, false);
  });
});

test('hydrate does not flip an explicit wantedConnected true', async () => {
  await withHomes(async (remote) => {
    writeOverlay(remote, 'keep-true', { wantedConnected: true });
    const mgr = new AgentManager({ autoStart: true, defaultCwd: '' });
    await mgr.shutdownAll();
    const rec = mgr.get('keep-true');
    assert.equal(rec?.wantedConnected, true);
    const disk = JSON.parse(fs.readFileSync(path.join(remote, 'agents', 'keep-true', 'meta.json'), 'utf8'));
    assert.equal(disk.wantedConnected, true);
  });
});
