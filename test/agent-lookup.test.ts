process.env['GROK_REMOTE_NO_LISTEN'] = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AgentManager } from '../lib/agent-manager.js';
import { createRing } from '../lib/sse.js';
import {
  clampLimit,
  filterSessions,
  joinTuiAndOverlays,
  listJoinedSystemSessions,
  parseSessionsQuery,
  type SessionItem,
} from '../lib/session-list.js';
import { encodeCwd, type TuiSession } from '../lib/tui-bridge.js';

const {
  dispatchRequest,
  setManagerForTests,
} = await import('../server.js');

function stubRecord(opts: {
  id: string;
  sid: string;
  archived?: boolean;
  createdAt?: string;
  name?: string;
  cwd?: string;
  starred?: boolean;
}): Record<string, unknown> {
  return {
    id: opts.id,
    name: opts.name || `agent-${opts.id.slice(0, 8)}`,
    autoNamed: true,
    modelHint: null,
    cwd: opts.cwd || '/work',
    createdAt: opts.createdAt || '2026-08-15T00:00:00.000Z',
    lastSeen: '2026-08-15T00:00:00.000Z',
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
    wantedConnected: false,
  };
}

function tui(partial: Partial<TuiSession> & { sessionId: string }): TuiSession {
  return {
    cwd: '/work',
    title: partial.title || partial.sessionId.slice(0, 8),
    summary: partial.summary || 'hello',
    createdAt: '2026-08-15T00:00:00.000Z',
    updatedAt: '2026-08-16T00:00:00.000Z',
    model: null,
    turns: 1,
    contextTokensUsed: 0,
    contextWindowTokens: 0,
    contextWindowUsage: 0,
    toolCallCount: 0,
    sessionKind: 'main',
    source: 'tui',
    ...partial,
  };
}

async function withServer(
  mgr: AgentManager,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  setManagerForTests(mgr);
  const srv = http.createServer((req, res) => {
    void dispatchRequest(req, res);
  });
  await new Promise<void>((resolve) => { srv.listen(0, '127.0.0.1', resolve); });
  const addr = srv.address() as AddressInfo;
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    await fn(base);
  } finally {
    await new Promise<void>((resolve, reject) => {
      srv.close((err) => { if (err) reject(err); else resolve(); });
    });
  }
}

function isolateHomes(): { home: string; restore: () => void } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-lookup-'));
  const prevGrok = process.env['GROK_HOME'];
  const prevRemote = process.env['GROK_REMOTE_HOME'];
  process.env['GROK_HOME'] = path.join(home, 'grok');
  process.env['GROK_REMOTE_HOME'] = path.join(home, 'remote');
  return {
    home,
    restore() {
      if (prevGrok === undefined) delete process.env['GROK_HOME'];
      else process.env['GROK_HOME'] = prevGrok;
      if (prevRemote === undefined) delete process.env['GROK_REMOTE_HOME'];
      else process.env['GROK_REMOTE_HOME'] = prevRemote;
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

test('getByIdOrSession matches overlay UUID and lastSessionId', () => {
  const mgr = new AgentManager({ autoStart: false });
  try {
    mgr.agents.set('ov-1', stubRecord({ id: 'ov-1', sid: 'sid-aaa' }) as never);
    assert.equal(mgr.getByIdOrSession('ov-1')?.id, 'ov-1');
    assert.equal(mgr.getByIdOrSession('sid-aaa')?.id, 'ov-1');
    assert.equal(mgr.getByIdOrSession(encodeURIComponent('sid-aaa'))?.id, 'ov-1');
    assert.equal(mgr.getByIdOrSession('missing'), null);
    assert.equal(mgr.getByIdOrSession(''), null);
  } finally {
    void mgr.shutdownAll();
  }
});

test('getByIdOrSession prefers live then oldest createdAt', () => {
  const mgr = new AgentManager({ autoStart: false });
  try {
    mgr.agents.set('arch', stubRecord({
      id: 'arch', sid: 'sid-twins', archived: true, createdAt: '2026-01-01T00:00:00.000Z',
    }) as never);
    mgr.agents.set('live-new', stubRecord({
      id: 'live-new', sid: 'sid-twins', createdAt: '2026-03-01T00:00:00.000Z',
    }) as never);
    mgr.agents.set('live-old', stubRecord({
      id: 'live-old', sid: 'sid-twins', createdAt: '2026-02-01T00:00:00.000Z',
    }) as never);
    assert.equal(mgr.getByIdOrSession('sid-twins')?.id, 'live-old');
  } finally {
    void mgr.shutdownAll();
  }
});

test('getByIdOrSession returns archived when it is the only match', () => {
  const mgr = new AgentManager({ autoStart: false });
  try {
    mgr.agents.set('arch', stubRecord({
      id: 'arch', sid: 'sid-only', archived: true,
    }) as never);
    const rec = mgr.getByIdOrSession('sid-only');
    assert.ok(rec);
    assert.equal(rec!.id, 'arch');
    assert.equal(rec!.archived, true);
  } finally {
    void mgr.shutdownAll();
  }
});

test('GET /api/agents/:sessionId rebinds to overlay UUID and is PublicAgent', async () => {
  const mgr = new AgentManager({ autoStart: false });
  try {
    mgr.agents.set('ov-uuid', stubRecord({
      id: 'ov-uuid', sid: '01a0sess-0000-0000-0000-000000000001', name: 'Lookup chat',
    }) as never);
    await withServer(mgr, async (base) => {
      const r = await fetch(`${base}/api/agents/01a0sess-0000-0000-0000-000000000001`);
      assert.equal(r.status, 200);
      const body = await r.json() as Record<string, unknown>;
      assert.equal(body.id, 'ov-uuid');
      assert.equal(body.name, 'Lookup chat');
      assert.ok('heldBy' in body);
      assert.equal(Object.hasOwn(body, 'client'), false);
      assert.equal(Object.hasOwn(body, 'ring'), false);
      assert.equal(Object.hasOwn(body, 'bgTasks'), false);
    });
  } finally {
    await mgr.shutdownAll();
  }
});

test('GET by sessionId does not restore an archived overlay', async () => {
  const mgr = new AgentManager({ autoStart: false });
  try {
    mgr.agents.set('arch', stubRecord({
      id: 'arch', sid: 'sid-arch-get', archived: true, name: 'Parked',
    }) as never);
    await withServer(mgr, async (base) => {
      const r = await fetch(`${base}/api/agents/sid-arch-get`);
      assert.equal(r.status, 200);
      const body = await r.json() as { id: string; archived: boolean };
      assert.equal(body.id, 'arch');
      assert.equal(body.archived, true);
      assert.equal(mgr.getRaw('arch')?.archived, true);
    });
  } finally {
    await mgr.shutdownAll();
  }
});

test('PATCH /api/agents/:sessionId updates the overlay; GET UUID sees it', async () => {
  const iso = isolateHomes();
  const mgr = new AgentManager({ autoStart: false });
  try {
    mgr.agents.set('ov-patch', stubRecord({
      id: 'ov-patch', sid: 'sid-patch', name: 'Old name',
    }) as never);
    await withServer(mgr, async (base) => {
      const patched = await fetch(`${base}/api/agents/sid-patch`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'New name' }),
      });
      assert.equal(patched.status, 200);
      const body = await patched.json() as Record<string, unknown>;
      assert.equal(body.id, 'ov-patch');
      assert.equal(body.name, 'New name');
      assert.equal(Object.hasOwn(body, 'client'), false);
      const again = await fetch(`${base}/api/agents/ov-patch`);
      const got = await again.json() as { name: string };
      assert.equal(got.name, 'New name');
    });
  } finally {
    await mgr.shutdownAll();
    iso.restore();
  }
});

test('GET /api/agents/:sessionId/stream uses the overlay ring', async () => {
  const mgr = new AgentManager({ autoStart: false });
  try {
    mgr.agents.set('ov-stream', stubRecord({
      id: 'ov-stream', sid: 'sid-stream',
    }) as never);
    const raw = mgr.getRaw('ov-stream');
    assert.ok(raw);
    raw!.ring.push({ id: 'evt-1', event: 'chunk', data: { text: 'hello-from-ring' } });
    await withServer(mgr, async (base) => {
      const ac = new AbortController();
      const r = await fetch(`${base}/api/agents/sid-stream/stream`, { signal: ac.signal });
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-type') || '', /text\/event-stream/);
      const reader = r.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && !buf.includes('hello-from-ring')) {
        const next = await Promise.race([
          reader.read(),
          new Promise<{ done: true; value?: undefined }>((resolve) => {
            setTimeout(() => resolve({ done: true }), 500);
          }),
        ]);
        if (next.value) buf += dec.decode(next.value, { stream: true });
        if (next.done && !buf.includes('hello-from-ring')) break;
      }
      ac.abort();
      try { await reader.cancel(); } catch { /* ignore */ }
      assert.match(buf, /hello-from-ring/);
    });
  } finally {
    await mgr.shutdownAll();
  }
});

test('POST import with resumeSessionId does not start ACP', async () => {
  const iso = isolateHomes();
  const mgr = new AgentManager({ autoStart: false });
  try {
    const pub = await mgr.createFromPost({
      resumeSessionId: 'sid-import-only',
      name: 'Imported',
      cwd: '/definitely/missing/cwd',
    });
    assert.equal(pub.lastSessionId, 'sid-import-only');
    assert.equal(pub.wantedConnected, false);
    assert.equal(pub.connected, false);
    const raw = mgr.getRaw(pub.id);
    assert.ok(raw);
    assert.equal(raw!.client, null);
    assert.equal(raw!.wantedConnected, false);

    await withServer(mgr, async (base) => {
      const r = await fetch(`${base}/api/agents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ resumeSessionId: 'sid-http-import' }),
      });
      assert.equal(r.status, 201);
      const body = await r.json() as Record<string, unknown>;
      assert.equal(body.lastSessionId, 'sid-http-import');
      assert.equal(body.wantedConnected, false);
      assert.equal(body.connected, false);
      assert.equal(Object.hasOwn(body, 'client'), false);
      const imported = mgr.getRaw(body.id as string);
      assert.ok(imported);
      assert.equal(imported!.client, null);
    });
  } finally {
    await mgr.shutdownAll();
    iso.restore();
  }
});

test('POST resumeSessionId restores archived overlay without connecting', async () => {
  const iso = isolateHomes();
  const mgr = new AgentManager({ autoStart: false });
  try {
    mgr.agents.set('arch', stubRecord({
      id: 'arch', sid: 'sid-restore', archived: true, name: 'Was archived',
    }) as never);
    const pub = await mgr.createFromPost({ resumeSessionId: 'sid-restore' });
    assert.equal(pub.id, 'arch');
    assert.equal(pub.archived, false);
    assert.equal(pub.wantedConnected, false);
    assert.equal(mgr.getRaw('arch')?.client, null);
    assert.equal(mgr.agents.size, 1);
  } finally {
    await mgr.shutdownAll();
    iso.restore();
  }
});

test('GET /api/system/sessions joins overlays using req.url query', async () => {
  const iso = isolateHomes();
  const mgr = new AgentManager({ autoStart: false });
  try {
    const grok = process.env['GROK_HOME']!;
    const sid = '01a0join-0000-0000-0000-000000000001';
    const dir = path.join(grok, 'sessions', encodeCwd('/work'), sid);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({
      info: { id: sid, cwd: '/work' },
      generated_title: 'Join Target',
      last_turn_summary: 'Join Target',
      created_at: '2026-08-15T00:00:00Z',
      updated_at: '2026-08-16T00:00:00Z',
    }));
    mgr.agents.set('ov-join', stubRecord({
      id: 'ov-join', sid, name: 'Join Target', starred: true,
    }) as never);

    await withServer(mgr, async (base) => {
      const r = await fetch(`${base}/api/system/sessions?q=Join&limit=5`);
      assert.equal(r.status, 200);
      const body = await r.json() as {
        ok: boolean;
        items: Array<{ sessionId: string; overlayId: string | null; starred?: boolean }>;
        raw: string;
      };
      assert.equal(body.ok, true);
      assert.equal(body.raw, '');
      assert.equal(body.items.length, 1);
      assert.equal(body.items[0]!.sessionId, sid);
      assert.equal(body.items[0]!.overlayId, 'ov-join');
      assert.equal(body.items[0]!.starred, true);
    });
  } finally {
    await mgr.shutdownAll();
    iso.restore();
  }
});

test('parseSessionsQuery / clampLimit / filterSessions stay query-aware', () => {
  assert.deepEqual(parseSessionsQuery('/api/system/sessions?q=foo&limit=3&includeEmpty=1'), {
    q: 'foo', limit: 3, includeEmpty: true,
  });
  assert.equal(clampLimit(null), 20);
  assert.equal(clampLimit('0'), 20);
  assert.equal(clampLimit('999'), 200);
  const items: SessionItem[] = [
    { sessionId: 'aaa', created: '', updated: '', status: 'local', summary: 'Traffic', cwd: '/root', title: 'A' },
    { sessionId: 'bbb', created: '', updated: '', status: 'local', summary: 'other', cwd: '/tmp', title: 'B' },
  ];
  assert.equal(filterSessions(items, 'traffic').length, 1);
  assert.equal(filterSessions(items, '/tmp').length, 1);
});

test('joinTuiAndOverlays picks the live overlay and falls back to holder lookup', () => {
  const sessions = [
    tui({ sessionId: 'sid-live', title: 'Live chat', summary: 'Live chat' }),
    tui({ sessionId: 'sid-none', title: 'Orphan', summary: 'Orphan' }),
    tui({ sessionId: 'sid-arch', title: 'Archived only', summary: 'Archived only' }),
    tui({ sessionId: 'sid-sub', title: 'Sub', summary: 'Sub', sessionKind: 'subagent' }),
  ];
  const joined = joinTuiAndOverlays(sessions, [
    { id: 'arch', lastSessionId: 'sid-live', archived: true, createdAt: '2026-01-01T00:00:00Z' },
    { id: 'live-old', lastSessionId: 'sid-live', createdAt: '2026-02-01T00:00:00Z', starred: true, heldBy: 'remote' },
    { id: 'live-new', lastSessionId: 'sid-live', createdAt: '2026-03-01T00:00:00Z' },
    { id: 'only-arch', lastSessionId: 'sid-arch', archived: true, createdAt: '2026-01-01T00:00:00Z' },
  ], (sid) => sid === 'sid-none' ? 'tui' : null);

  const live = joined.find((j) => j.sessionId === 'sid-live');
  assert.equal(live?.overlayId, 'live-old');
  assert.equal(live?.heldBy, 'remote');
  assert.equal(live?.starred, true);
  assert.equal(live?.archived, false);
  assert.equal(live?.livedIn, true);
  assert.equal(live?.sessionKind, 'main');

  const orphan = joined.find((j) => j.sessionId === 'sid-none');
  assert.equal(orphan?.overlayId, null);
  assert.equal(orphan?.heldBy, 'tui');

  const arch = joined.find((j) => j.sessionId === 'sid-arch');
  assert.equal(arch?.overlayId, 'only-arch');
  assert.equal(arch?.archived, true);

  const sub = joined.find((j) => j.sessionId === 'sid-sub');
  assert.equal(sub?.sessionKind, 'subagent');
});

test('listJoinedSystemSessions reads q/limit/includeEmpty from req.url', () => {
  const listed: Array<{ includeEmpty?: boolean }> = [];
  const sessions: TuiSession[] = [
    tui({ sessionId: 'keep-me', title: 'Alpha', summary: 'Alpha' }),
    tui({ sessionId: 'skip-me', title: 'Beta', summary: 'Beta' }),
  ];
  const out = listJoinedSystemSessions(
    '/api/system/sessions?q=alpha&limit=1',
    [{ id: 'ov', lastSessionId: 'keep-me' }],
    (_limit, opts) => {
      listed.push(opts || {});
      return sessions;
    },
  );
  assert.deepEqual(listed, [{ includeEmpty: false }]);
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0]!.sessionId, 'keep-me');
  assert.equal(out.items[0]!.overlayId, 'ov');
  assert.equal(out.raw, '');
});

test('GET /api/tui/sessions is gone', async () => {
  const mgr = new AgentManager({ autoStart: false });
  try {
    await withServer(mgr, async (base) => {
      const r = await fetch(`${base}/api/tui/sessions`);
      assert.equal(r.status, 404);
      const body = await r.json() as { error?: string };
      assert.equal(body.error, 'not found');
    });
  } finally {
    await mgr.shutdownAll();
  }
});

test('GET /api/system/sessions?includeEmpty=1 lists leftover hidden sessions', async () => {
  const iso = isolateHomes();
  const mgr = new AgentManager({ autoStart: false });
  try {
    const grok = process.env['GROK_HOME']!;
    const leftover = '01a0hide-0000-0000-0000-000000000001';
    const lived = '01a0live-0000-0000-0000-000000000002';
    const leftoverDir = path.join(grok, 'sessions', encodeCwd('/tmp'), leftover);
    const livedDir = path.join(grok, 'sessions', encodeCwd('/work'), lived);
    fs.mkdirSync(leftoverDir, { recursive: true });
    fs.mkdirSync(livedDir, { recursive: true });
    fs.writeFileSync(path.join(leftoverDir, 'summary.json'), JSON.stringify({
      info: { id: leftover, cwd: '/tmp' },
      session_summary: '',
      created_at: '2026-08-15T13:50:27Z',
      updated_at: '2026-08-15T13:50:29Z',
      num_messages: 0,
    }));
    fs.writeFileSync(path.join(livedDir, 'summary.json'), JSON.stringify({
      info: { id: lived, cwd: '/work' },
      generated_title: 'Lived in',
      last_turn_summary: 'did work',
      created_at: '2026-08-15T13:00:00Z',
      updated_at: '2026-08-15T13:10:00Z',
    }));

    await withServer(mgr, async (base) => {
      const hidden = await fetch(`${base}/api/system/sessions?limit=20`);
      const hiddenBody = await hidden.json() as { items: Array<{ sessionId: string; livedIn?: boolean }> };
      assert.deepEqual(hiddenBody.items.map((it) => it.sessionId), [lived]);

      const raw = await fetch(`${base}/api/system/sessions?includeEmpty=1&limit=20`);
      assert.equal(raw.status, 200);
      const body = await raw.json() as { items: Array<{ sessionId: string; livedIn?: boolean }> };
      const ids = body.items.map((it) => it.sessionId).sort();
      assert.deepEqual(ids, [leftover, lived].sort());
      const leftoverRow = body.items.find((it) => it.sessionId === leftover);
      assert.equal(leftoverRow?.livedIn, false);
    });
  } finally {
    await mgr.shutdownAll();
    iso.restore();
  }
});
