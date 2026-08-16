import test from 'node:test';
import assert from 'node:assert/strict';

import {
  holderForSession,
  isRemoteAgentCmd,
  isTuiPagerCmd,
  sessionHeldPayload,
  SessionHeldError,
  type ActiveSessionRow,
} from '../lib/session-ownership.js';

test('isTuiPagerCmd accepts a bare grok pager and rejects grok agent', () => {
  assert.equal(isTuiPagerCmd('grok'), true);
  assert.equal(isTuiPagerCmd('/root/.grok/bin/grok'), true);
  assert.equal(isTuiPagerCmd('/root/.grok/bin/grok agent --no-leader stdio'), false);
  assert.equal(isRemoteAgentCmd('/root/.grok/bin/grok agent --no-leader stdio'), true);
});

test('holderForSession prefers the newest opened session on a live pager pid', () => {
  const pid = process.pid;
  const rows: ActiveSessionRow[] = [
    { session_id: 'old-sid', pid, opened_at: '2026-08-15T10:00:00.000Z' },
    { session_id: 'new-sid', pid, opened_at: '2026-08-15T12:51:28.000Z' },
  ];
  const readCmd = (): string => '/root/.grok/bin/grok';
  assert.equal(holderForSession('new-sid', [], rows, readCmd), 'tui');
  assert.equal(holderForSession('old-sid', [], rows, readCmd), null);
  assert.equal(holderForSession('missing', [], rows, readCmd), null);
});

test('holderForSession does not treat a live non-grok pid as the TUI pager', () => {
  const pid = process.pid;
  const rows: ActiveSessionRow[] = [
    { session_id: 'sid-1', pid, opened_at: '2026-08-15T12:00:00.000Z' },
  ];
  assert.equal(isTuiPagerCmd('node --import tsx --test test/session-ownership.test.ts'), false);
  assert.equal(holderForSession('sid-1', [], rows), null);
  assert.equal(holderForSession('sid-1', [], rows, () => 'node /usr/bin/sshd'), null);
});

test('sessionHeldPayload is the HTTP 409 envelope', () => {
  const err = new SessionHeldError('01a0test-0000-0000-0000-000000000001');
  assert.deepEqual(sessionHeldPayload(err), {
    ok: false,
    error: err.message,
    heldBy: 'tui',
  });
  assert.equal(err.statusCode, 409);
});

test('holderForSession reports remote when the pid is one of ours', () => {
  const pid = process.pid;
  const rows: ActiveSessionRow[] = [
    { session_id: 'sid-1', pid, opened_at: '2026-08-15T12:00:00.000Z' },
  ];
  assert.equal(holderForSession('sid-1', [pid], rows), 'remote');
});
