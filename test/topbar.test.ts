import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PRODUCT_NAME,
  conversationTitle,
  shortModel,
  formatCwd,
  liveFromAgent,
  connectionActionFor,
  connectionConfirmFor,
  contextFromAgent,
  documentTitleFor,
  pageTitle,
} from '../src/lib/topbar.js';

test('conversationTitle prefers a trimmed name', () => {
  assert.equal(conversationTitle({ name: '  Fix login  ', id: 'abc' }), 'Fix login');
});

test('conversationTitle falls back to agent-<id> then Conversation', () => {
  assert.equal(conversationTitle({ id: 'abcdef012345' }), 'agent-abcdef01');
  assert.equal(conversationTitle({ name: '   ' }), 'Conversation');
  assert.equal(conversationTitle(null), 'Conversation');
});

test('shortModel strips a provider prefix', () => {
  assert.equal(shortModel('xai/grok-4'), 'grok-4');
  assert.equal(shortModel('grok-4-latest'), 'grok-4-latest');
  assert.equal(shortModel('  '), '');
  assert.equal(shortModel(null), '');
});

test('formatCwd rewrites well-known homes to ~', () => {
  assert.equal(formatCwd('/root/proj'), '~/proj');
  assert.equal(formatCwd('/home/ada/src'), '~/src');
  assert.equal(formatCwd('/Users/ada/src'), '~/src');
  assert.equal(formatCwd('~/already'), '~/already');
  assert.equal(formatCwd(''), '');
  assert.equal(formatCwd(null), '');
});

test('formatCwd ellipsizes long paths but keeps the last two segments', () => {
  assert.equal(
    formatCwd('/root/.grok-remote/agents/abcdefghijk/cwd'),
    '~/…/abcdefghijk/cwd',
  );
  assert.equal(
    formatCwd('/var/log/nginx/sites-available/long-vhost/access.log'),
    '/…/long-vhost/access.log',
  );
  assert.equal(formatCwd('~/src'), '~/src');
});

test('liveFromAgent maps status and in-flight to a labeled chip', () => {
  assert.deepEqual(liveFromAgent({ status: 'errored' }), { kind: 'fail', label: 'error' });
  assert.deepEqual(liveFromAgent({ status: 'killed' }), { kind: 'fail', label: 'error' });
  assert.deepEqual(liveFromAgent({ status: 'disconnected' }), { kind: 'warn', label: 'offline' });
  assert.deepEqual(liveFromAgent({ status: 'exited' }), { kind: 'warn', label: 'offline' });
  assert.deepEqual(liveFromAgent({ status: 'running' }), { kind: 'run', label: 'running' });
  assert.deepEqual(liveFromAgent({ status: 'idle', inFlight: 2 }), { kind: 'run', label: 'working' });
  assert.deepEqual(liveFromAgent({ status: 'idle', connected: true }), { kind: 'ok', label: 'connected' });
  assert.deepEqual(liveFromAgent({ connected: true }), { kind: 'ok', label: 'connected' });
  assert.deepEqual(liveFromAgent({ heldBy: 'tui', connected: true }), { kind: 'warn', label: 'TUI · 只读' });
  assert.deepEqual(liveFromAgent({ status: 'observed' }), { kind: 'warn', label: 'TUI · 只读' });
  assert.deepEqual(liveFromAgent({ status: 'starting' }), { kind: 'idle', label: 'connecting' });
  assert.equal(liveFromAgent(null), null);
});

test('connectionActionFor is none while TUI holds or connecting', () => {
  assert.equal(connectionActionFor({ heldBy: 'tui' }), 'none');
  assert.equal(connectionActionFor({ status: 'starting' }), 'none');
  assert.equal(connectionActionFor({ status: 'disconnected' }), 'connect');
  assert.equal(connectionActionFor({ status: 'idle', connected: true }), 'disconnect');
});

test('connectionConfirmFor requires a sheet for connect and disconnect', () => {
  assert.equal(connectionConfirmFor('none'), null);
  const disconnect = connectionConfirmFor('disconnect');
  assert.ok(disconnect);
  assert.equal(disconnect.danger, true);
  assert.equal(disconnect.confirmLabel, 'Disconnect');
  const connect = connectionConfirmFor('connect');
  assert.ok(connect);
  assert.equal(connect.danger, false);
  assert.equal(connect.confirmLabel, 'Connect');
});

test('contextFromAgent is home when no agent is selected', () => {
  assert.deepEqual(contextFromAgent(null), { kind: 'home', title: PRODUCT_NAME });
  assert.deepEqual(contextFromAgent({}), { kind: 'home', title: PRODUCT_NAME });
});

test('contextFromAgent composes title, model, cwd, and live for a chat', () => {
  const ctx = contextFromAgent({
    id: 'abc',
    name: 'Fix login',
    model: 'xai/grok-4',
    cwd: '/root/app',
    status: 'idle',
    connected: true,
  });
  assert.equal(ctx.kind, 'chat');
  assert.equal(ctx.title, 'Fix login');
  assert.equal(ctx.model, 'grok-4');
  assert.equal(ctx.cwd, '/root/app');
  assert.deepEqual(ctx.live, { kind: 'ok', label: 'connected' });
});

test('documentTitleFor prefixes a busy marker and keeps home as grok-remote', () => {
  assert.equal(
    documentTitleFor({ kind: 'home', title: PRODUCT_NAME }, false),
    'grok-remote',
  );
  assert.equal(
    documentTitleFor({ kind: 'chat', title: 'Fix login' }, true),
    '(*) Fix login · grok-remote',
  );
});

test('pageTitle falls back to the product name', () => {
  assert.equal(pageTitle('memory'), 'memory');
  assert.equal(pageTitle('  Settings  '), 'Settings');
  assert.equal(pageTitle(''), PRODUCT_NAME);
});
