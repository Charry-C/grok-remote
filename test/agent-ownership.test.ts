import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AgentManager, SessionHeldError } from '../lib/agent-manager.js';
import { sessionHeldPayload } from '../lib/session-ownership.js';
import { encodeCwd } from '../lib/tui-bridge.js';
import { createRing } from '../lib/sse.js';

function stubRecord(id: string, sid: string, cwd: string): Record<string, unknown> {
  return {
    id,
    name: 'tui import',
    autoNamed: true,
    modelHint: null,
    cwd,
    createdAt: '2026-08-15T00:00:00.000Z',
    lastSeen: '2026-08-15T00:00:00.000Z',
    lastSessionId: sid,
    lastError: null,
    starred: false,
    archived: false,
    archivedAt: null,
    settings: null,
    client: null,
    ring: createRing(16),
    status: 'disconnected',
    eventCounter: 0,
    wantedConnected: false,
  };
}

test('TUI holder: prompt/connect/model 409, observed, tail, then release', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-own-'));
  const prevGrok = process.env['GROK_HOME'];
  const prevRemote = process.env['GROK_REMOTE_HOME'];
  process.env['GROK_HOME'] = home;
  process.env['GROK_REMOTE_HOME'] = path.join(home, 'remote');

  const sid = '01a0own-0000-0000-0000-000000000001';
  const cwd = '/work';
  const dir = path.join(home, 'sessions', encodeCwd(cwd), sid);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({
    info: { id: sid, cwd },
    generated_title: 'Ownership fixture',
    last_turn_summary: 'ok',
  }));
  fs.writeFileSync(path.join(dir, 'updates.jsonl'), '');

  const mgr = new AgentManager({ autoStart: false });
  try {
    const id = 'overlay-own-1';
    mgr.agents.set(id, stubRecord(id, sid, cwd) as never);

    const events: Array<{ event?: string; status?: string }> = [];
    mgr.on('list_changed', (ev: { event?: string; status?: string }) => events.push(ev));

    mgr.setHolderLookup({
      rows: [{ session_id: sid, pid: process.pid, opened_at: '2026-08-16T00:00:00.000Z' }],
      readCmd: () => '/root/.grok/bin/grok',
    });
    mgr.syncHolders();

    const held = mgr.get(id);
    assert.ok(held);
    assert.equal(held!.heldBy, 'tui');
    assert.equal(held!.status, 'observed');
    assert.equal(held!.connected, false);
    assert.ok(events.some((e) => e.event === 'agent_status' && e.status === 'observed'));

    const raw = mgr.getRaw(id);
    assert.equal(raw && raw.client, null);

    await assert.rejects(() => mgr.connect(id), (err: unknown) => {
      assert.ok(err instanceof SessionHeldError);
      assert.deepEqual(sessionHeldPayload(err), { ok: false, error: err.message, heldBy: 'tui' });
      return true;
    });
    await assert.rejects(() => mgr.prompt(id, 'hello'), (err: unknown) => {
      assert.ok(err instanceof SessionHeldError);
      assert.equal(sessionHeldPayload(err).heldBy, 'tui');
      return true;
    });
    await assert.rejects(() => mgr.switchModel(id, { model: 'grok-4' }), (err: unknown) => {
      assert.ok(err instanceof SessionHeldError);
      return true;
    });
    assert.equal(mgr.getRaw(id)!.client, null);

    const endView = mgr.beginView(id);
    fs.appendFileSync(path.join(dir, 'updates.jsonl'), JSON.stringify({
      timestamp: 1_700_000_100,
      method: 'session/update',
      params: { update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'live' } } },
    }) + '\n');
    mgr.pollUpdateTails();
    const ring = mgr.ring(id);
    assert.ok(ring);
    assert.ok(ring!.all().some((ev) => ev.event === 'user_message_chunk'));
    endView();

    events.length = 0;
    mgr.setHolderLookup({ rows: [], readCmd: () => '/root/.grok/bin/grok' });
    mgr.syncHolders();
    const released = mgr.get(id);
    assert.ok(released);
    assert.equal(released!.heldBy, null);
    assert.equal(released!.status, 'disconnected');
    assert.ok(events.some((e) => e.event === 'agent_status' && e.status === 'disconnected'));
  } finally {
    await mgr.shutdownAll();
    if (prevGrok === undefined) delete process.env['GROK_HOME'];
    else process.env['GROK_HOME'] = prevGrok;
    if (prevRemote === undefined) delete process.env['GROK_REMOTE_HOME'];
    else process.env['GROK_REMOTE_HOME'] = prevRemote;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
