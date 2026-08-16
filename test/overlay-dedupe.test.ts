import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AgentManager } from '../lib/agent-manager.js';
import { encodeCwd } from '../lib/tui-bridge.js';
import { planOverlayDedupe } from '../lib/tui-reconcile.js';
import { createRing } from '../lib/sse.js';

function ref(partial: {
  id: string;
  lastSessionId?: string | null;
  archived?: boolean;
  autoNamed?: boolean;
  starred?: boolean;
  wantedConnected?: boolean;
  createdAt?: string;
}) {
  return {
    lastSessionId: 'sid-1',
    autoNamed: true,
    starred: false,
    wantedConnected: false,
    createdAt: '2026-08-15T00:00:00Z',
    ...partial,
  };
}

function stubRecord(opts: {
  id: string;
  sid: string;
  archived?: boolean;
  autoNamed?: boolean;
  starred?: boolean;
  wantedConnected?: boolean;
  createdAt?: string;
  name?: string;
  lastSeen?: string;
  cwd?: string;
}): Record<string, unknown> {
  return {
    id: opts.id,
    name: opts.name || `agent-${opts.id.slice(0, 8)}`,
    autoNamed: opts.autoNamed !== false,
    modelHint: null,
    cwd: opts.cwd || '/work',
    createdAt: opts.createdAt || '2026-08-15T00:00:00.000Z',
    lastSeen: opts.lastSeen || '2026-08-15T00:00:00.000Z',
    lastSessionId: opts.sid,
    lastError: null,
    starred: !!opts.starred,
    archived: !!opts.archived,
    archivedAt: opts.archived ? '2026-08-15T00:00:00.000Z' : null,
    settings: null,
    client: null,
    ring: createRing(16),
    status: 'disconnected',
    eventCounter: 0,
    wantedConnected: opts.wantedConnected === true,
  };
}

function writeMeta(home: string, opts: {
  id: string;
  sid: string;
  archived?: boolean;
  autoNamed?: boolean;
  starred?: boolean;
  wantedConnected?: boolean;
  createdAt?: string;
  name?: string;
}): void {
  const dir = path.join(home, 'agents', opts.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    id: opts.id,
    name: opts.name || opts.id,
    autoNamed: opts.autoNamed !== false,
    modelHint: null,
    cwd: '/work',
    createdAt: opts.createdAt || '2026-08-15T00:00:00.000Z',
    lastSeen: '2026-08-15T00:00:00.000Z',
    lastSessionId: opts.sid,
    lastError: null,
    starred: !!opts.starred,
    archived: !!opts.archived,
    archivedAt: opts.archived ? '2026-08-15T00:00:00.000Z' : null,
    settings: null,
    wantedConnected: opts.wantedConnected === true,
  }, null, 2));
}

function writeTuiSession(grokHome: string, sid: string, title: string, kind?: 'subagent'): void {
  const dir = path.join(grokHome, 'sessions', encodeCwd('/work'), sid);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({
    info: { id: sid, cwd: '/work' },
    generated_title: title,
    last_turn_summary: title,
    created_at: '2026-08-15T00:00:00Z',
    updated_at: '2026-08-16T00:00:00Z',
    ...(kind ? { session_kind: kind } : {}),
  }));
}

async function stopManager(mgr: AgentManager): Promise<void> {
  await mgr.shutdownAll();
  await new Promise<void>((r) => setImmediate(r));
  await mgr.shutdownAll();
}

test('planOverlayDedupe kills the live auto twin of an archived overlay', () => {
  const actions = planOverlayDedupe([
    ref({ id: 'arch', archived: true, createdAt: '2026-01-01T00:00:00Z' }),
    ref({ id: 'live', createdAt: '2026-02-01T00:00:00Z' }),
  ]);
  assert.deepEqual(actions, [{ lastSessionId: 'sid-1', kept: 'arch', dropped: 'live' }]);
});

test('planOverlayDedupe keeps a renamed / starred / wanted live twin of an archive', () => {
  assert.deepEqual(planOverlayDedupe([
    ref({ id: 'arch', archived: true }),
    ref({ id: 'renamed', autoNamed: false, createdAt: '2026-02-01T00:00:00Z' }),
  ]), []);
  assert.deepEqual(planOverlayDedupe([
    ref({ id: 'arch', archived: true }),
    ref({ id: 'star', starred: true, createdAt: '2026-02-01T00:00:00Z' }),
  ]), []);
  assert.deepEqual(planOverlayDedupe([
    ref({ id: 'arch', archived: true }),
    ref({ id: 'wanted', wantedConnected: true, createdAt: '2026-02-01T00:00:00Z' }),
  ]), []);
});

test('planOverlayDedupe both-live keeps starred or older, kills the other pure auto-import', () => {
  assert.deepEqual(planOverlayDedupe([
    ref({ id: 'star', starred: true, createdAt: '2026-03-01T00:00:00Z' }),
    ref({ id: 'auto', createdAt: '2026-01-01T00:00:00Z' }),
  ]), [{ lastSessionId: 'sid-1', kept: 'star', dropped: 'auto' }]);

  assert.deepEqual(planOverlayDedupe([
    ref({ id: 'older', createdAt: '2026-01-01T00:00:00Z' }),
    ref({ id: 'newer', createdAt: '2026-02-01T00:00:00Z' }),
  ]), [{ lastSessionId: 'sid-1', kept: 'older', dropped: 'newer' }]);
});

test('planOverlayDedupe does not drop a renamed second copy', () => {
  assert.deepEqual(planOverlayDedupe([
    ref({ id: 'auto-old', createdAt: '2026-01-01T00:00:00Z' }),
    ref({ id: 'renamed-new', autoNamed: false, createdAt: '2026-02-01T00:00:00Z' }),
  ]), []);
});

test('planOverlayDedupe leaves an already-imported subagent unless it is a twin', () => {
  assert.deepEqual(planOverlayDedupe([
    ref({ id: 'sub', lastSessionId: 'sid-sub' }),
  ]), []);
  assert.deepEqual(planOverlayDedupe([
    ref({ id: 'arch', lastSessionId: 'sid-sub', archived: true }),
    ref({ id: 'sub-twin', lastSessionId: 'sid-sub', createdAt: '2026-02-01T00:00:00Z' }),
  ]), [{ lastSessionId: 'sid-sub', kept: 'arch', dropped: 'sub-twin' }]);
});

test('AgentManager.dedupeOverlayTwins logs then kills the live auto twin', async () => {
  const mgr = new AgentManager({ autoStart: false });
  mgr.agents.set('arch', stubRecord({
    id: 'arch', sid: 'sid-1', archived: true, createdAt: '2026-01-01T00:00:00Z',
  }) as never);
  mgr.agents.set('live', stubRecord({
    id: 'live', sid: 'sid-1', createdAt: '2026-02-01T00:00:00Z',
  }) as never);

  const lines: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown, ...args: unknown[]) => {
    lines.push(String(chunk));
    return (orig as (...a: unknown[]) => boolean)(chunk, ...args);
  }) as typeof process.stderr.write;
  try {
    const n = mgr.dedupeOverlayTwins();
    assert.equal(n, 1);
    assert.ok(lines.some((l) => l.includes('[reconcile] deduped lastSessionId=sid-1 kept=arch dropped=live')));
    await Promise.resolve();
    assert.equal(mgr.agents.has('live'), false);
    assert.equal(mgr.agents.has('arch'), true);
  } finally {
    process.stderr.write = orig;
    await mgr.shutdownAll();
  }
});

test('spawn resumeSessionId matches an archived overlay instead of creating a twin', async () => {
  const mgr = new AgentManager({ autoStart: false });
  try {
    mgr.agents.set('arch', stubRecord({
      id: 'arch', sid: 'sid-resume', archived: true, name: 'Archived chat',
    }) as never);
    const pub = await mgr.spawn({ resumeSessionId: 'sid-resume' });
    assert.equal(pub.id, 'arch');
    assert.equal(pub.archived, true);
    assert.equal(mgr.agents.size, 1);
  } finally {
    await mgr.shutdownAll();
  }
});

test('reconcile updates lastSeen on archived overlays but does not rename them', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-dedupe-'));
  const prevGrok = process.env['GROK_HOME'];
  const prevRemote = process.env['GROK_REMOTE_HOME'];
  process.env['GROK_HOME'] = path.join(home, 'grok');
  process.env['GROK_REMOTE_HOME'] = path.join(home, 'remote');
  try {
    writeTuiSession(process.env['GROK_HOME'], 'sid-arch', 'New TUI title');
    const mgr = new AgentManager({ autoStart: false });
    mgr.agents.set('arch', stubRecord({
      id: 'arch',
      sid: 'sid-arch',
      archived: true,
      autoNamed: true,
      name: 'Old archived name',
      lastSeen: '2026-08-14T00:00:00Z',
      cwd: '/work',
    }) as never);
    const plan = mgr.reconcileTuiSessions();
    assert.equal(plan.created, 0);
    const rec = mgr.getRaw('arch');
    assert.ok(rec);
    assert.equal(rec!.name, 'Old archived name');
    assert.equal(rec!.lastSeen, '2026-08-16T00:00:00Z');
    await mgr.shutdownAll();
  } finally {
    if (prevGrok === undefined) delete process.env['GROK_HOME'];
    else process.env['GROK_HOME'] = prevGrok;
    if (prevRemote === undefined) delete process.env['GROK_REMOTE_HOME'];
    else process.env['GROK_REMOTE_HOME'] = prevRemote;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('reconcile does not create a subagent overlay', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-dedupe-'));
  const prevGrok = process.env['GROK_HOME'];
  const prevRemote = process.env['GROK_REMOTE_HOME'];
  process.env['GROK_HOME'] = path.join(home, 'grok');
  process.env['GROK_REMOTE_HOME'] = path.join(home, 'remote');
  try {
    writeTuiSession(process.env['GROK_HOME'], 'sid-sub', 'Background task', 'subagent');
    writeTuiSession(process.env['GROK_HOME'], 'sid-main', 'Main chat');
    const mgr = new AgentManager({ autoStart: false });
    const plan = mgr.reconcileTuiSessions();
    assert.equal(plan.created, 1);
    const created = [...mgr.agents.values()];
    assert.equal(created.length, 1);
    assert.equal(created[0]?.lastSessionId, 'sid-main');
    await mgr.shutdownAll();
  } finally {
    if (prevGrok === undefined) delete process.env['GROK_HOME'];
    else process.env['GROK_HOME'] = prevGrok;
    if (prevRemote === undefined) delete process.env['GROK_REMOTE_HOME'];
    else process.env['GROK_REMOTE_HOME'] = prevRemote;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('startup hydrate dedupes archived+live auto twins before resume', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-dedupe-'));
  const prevGrok = process.env['GROK_HOME'];
  const prevRemote = process.env['GROK_REMOTE_HOME'];
  process.env['GROK_HOME'] = path.join(home, 'grok');
  process.env['GROK_REMOTE_HOME'] = path.join(home, 'remote');
  const sid = 'sid-boot';
  writeMeta(process.env['GROK_REMOTE_HOME'], {
    id: 'arch-boot', sid, archived: true, createdAt: '2026-01-01T00:00:00Z',
  });
  writeMeta(process.env['GROK_REMOTE_HOME'], {
    id: 'live-boot', sid, createdAt: '2026-02-01T00:00:00Z', wantedConnected: false,
  });

  const lines: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown, ...args: unknown[]) => {
    lines.push(String(chunk));
    return (orig as (...a: unknown[]) => boolean)(chunk, ...args);
  }) as typeof process.stderr.write;

  const mgr = new AgentManager();
  try {
    assert.equal(mgr.agents.has('live-boot'), false);
    assert.equal(mgr.agents.has('arch-boot'), true);
    assert.ok(lines.some((l) =>
      l.includes('[reconcile] deduped lastSessionId=sid-boot kept=arch-boot dropped=live-boot')));
  } finally {
    process.stderr.write = orig;
    await stopManager(mgr);
    if (prevGrok === undefined) delete process.env['GROK_HOME'];
    else process.env['GROK_HOME'] = prevGrok;
    if (prevRemote === undefined) delete process.env['GROK_REMOTE_HOME'];
    else process.env['GROK_REMOTE_HOME'] = prevRemote;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
