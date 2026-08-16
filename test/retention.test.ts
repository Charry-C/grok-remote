import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sweepOnce } from '../lib/retention.js';
import { encodeCwd } from '../lib/tui-bridge.js';

// Disabled-path coverage. When retention is disabled (or misconfigured),
// sweepOnce MUST return zero counts and not touch the filesystem at all.

test('sweepOnce returns zero counts when called with no arguments', () => {
  assert.deepEqual(sweepOnce(), { scanned: 0, removed: 0, skipped: 0 });
});

test('sweepOnce returns zero counts when days is missing', () => {
  assert.deepEqual(sweepOnce({}), { scanned: 0, removed: 0, skipped: 0 });
});

test('sweepOnce returns zero counts when days is zero', () => {
  assert.deepEqual(sweepOnce({ days: 0 }), { scanned: 0, removed: 0, skipped: 0 });
});

test('sweepOnce returns zero counts when days is negative', () => {
  assert.deepEqual(sweepOnce({ days: -5 }), { scanned: 0, removed: 0, skipped: 0 });
});

test('sweepOnce returns zero counts when days is non-finite', () => {
  assert.deepEqual(sweepOnce({ days: NaN }), { scanned: 0, removed: 0, skipped: 0 });
  assert.deepEqual(sweepOnce({ days: Infinity }), { scanned: 0, removed: 0, skipped: 0 });
  // Stringly-typed config values from settings.json should also short-circuit
  // before any filesystem call.
  assert.deepEqual(sweepOnce({ days: 'soon' as unknown as number }), { scanned: 0, removed: 0, skipped: 0 });
});

const NOW = Date.parse('2026-08-16T00:00:00.000Z');
const OLD = '2026-01-01T00:00:00.000Z';
const RECENT = '2026-08-15T00:00:00.000Z';
const CWD = '/work';

function overlayExists(agentsRoot: string, id: string): boolean {
  return fs.existsSync(path.join(agentsRoot, id, 'meta.json'));
}

function writeOverlay(agentsRoot: string, id: string, meta: Record<string, unknown> = {}): void {
  const dir = path.join(agentsRoot, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    id,
    name: id,
    starred: false,
    archived: false,
    lastSeen: OLD,
    cwd: CWD,
    ...meta,
  }));
}

function writeTui(grokHome: string, sid: string, title: string, summary: string): string {
  const dir = path.join(grokHome, 'sessions', encodeCwd(CWD), sid);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({
    info: { id: sid, cwd: CWD },
    generated_title: title,
    last_turn_summary: summary,
  }));
  return dir;
}

function withHomes(fn: (ctx: { agentsRoot: string; grok: string }) => void): void {
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-ret-remote-'));
  const grok = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-ret-grok-'));
  const prevRemote = process.env['GROK_REMOTE_HOME'];
  const prevGrok = process.env['GROK_HOME'];
  process.env['GROK_REMOTE_HOME'] = remote;
  process.env['GROK_HOME'] = grok;
  const agentsRoot = path.join(remote, 'agents');
  fs.mkdirSync(agentsRoot, { recursive: true });
  try {
    fn({ agentsRoot, grok });
  } finally {
    if (prevRemote === undefined) delete process.env['GROK_REMOTE_HOME'];
    else process.env['GROK_REMOTE_HOME'] = prevRemote;
    if (prevGrok === undefined) delete process.env['GROK_HOME'];
    else process.env['GROK_HOME'] = prevGrok;
    fs.rmSync(remote, { recursive: true, force: true });
    fs.rmSync(grok, { recursive: true, force: true });
  }
}

function sweep(agentsRoot: string, days = 30) {
  return sweepOnce({ days, now: NOW, agentsRoot });
}

test('sweepOnce skips an archived overlay even when the TUI dir is gone', () => {
  withHomes(({ agentsRoot }) => {
    writeOverlay(agentsRoot, 'arch-1', {
      archived: true,
      lastSessionId: '01a0arch-0000-0000-0000-000000000001',
    });
    const r = sweep(agentsRoot);
    assert.equal(r.scanned, 1);
    assert.equal(r.removed, 0);
    assert.equal(r.skipped, 1);
    assert.equal(overlayExists(agentsRoot, 'arch-1'), true);
  });
});

test('sweepOnce skips a starred overlay even when the TUI dir is gone', () => {
  withHomes(({ agentsRoot }) => {
    writeOverlay(agentsRoot, 'star-1', {
      starred: true,
      lastSessionId: '01a0star-0000-0000-0000-000000000001',
    });
    const r = sweep(agentsRoot);
    assert.equal(r.scanned, 1);
    assert.equal(r.removed, 0);
    assert.equal(r.skipped, 1);
    assert.equal(overlayExists(agentsRoot, 'star-1'), true);
  });
});

test('sweepOnce skips a lived-in TUI session and never removes the TUI dir', () => {
  withHomes(({ agentsRoot, grok }) => {
    const sid = '01a0live-0000-0000-0000-000000000001';
    writeOverlay(agentsRoot, 'live-1', { lastSessionId: sid });
    const tuiDir = writeTui(grok, sid, 'A real conversation', 'user asked about retention');
    const r = sweep(agentsRoot);
    assert.equal(r.scanned, 1);
    assert.equal(r.removed, 0);
    assert.equal(r.skipped, 1);
    assert.equal(overlayExists(agentsRoot, 'live-1'), true);
    assert.equal(fs.existsSync(path.join(tuiDir, 'summary.json')), true);
  });
});

test('sweepOnce removes an expired overlay only when the TUI dir is gone', () => {
  withHomes(({ agentsRoot }) => {
    writeOverlay(agentsRoot, 'gone-1', {
      lastSessionId: '01a0gone-0000-0000-0000-000000000001',
    });
    const r = sweep(agentsRoot);
    assert.equal(r.scanned, 1);
    assert.equal(r.removed, 1);
    assert.equal(r.skipped, 0);
    assert.equal(overlayExists(agentsRoot, 'gone-1'), false);
  });
});

test('sweepOnce keeps a recent overlay even when the TUI dir is gone', () => {
  withHomes(({ agentsRoot }) => {
    writeOverlay(agentsRoot, 'recent-1', {
      lastSessionId: '01a0recn-0000-0000-0000-000000000001',
      lastSeen: RECENT,
    });
    const r = sweep(agentsRoot);
    assert.equal(r.removed, 0);
    assert.equal(overlayExists(agentsRoot, 'recent-1'), true);
  });
});

test('sweepOnce days=0 does not remove an expired tui-gone overlay', () => {
  withHomes(({ agentsRoot }) => {
    writeOverlay(agentsRoot, 'gone-0', {
      lastSessionId: '01a0zero-0000-0000-0000-000000000001',
    });
    const r = sweepOnce({ days: 0, now: NOW, agentsRoot });
    assert.deepEqual(r, { scanned: 0, removed: 0, skipped: 0 });
    assert.equal(overlayExists(agentsRoot, 'gone-0'), true);
  });
});
