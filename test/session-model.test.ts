import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ingestSessionSnapshot,
  ingestSessionInfo,
  sessionModelSwitchBlockReason,
} from '../lib/session-model.js';

test('ingestSessionSnapshot reads currentModelId and selected mode', () => {
  const snap = ingestSessionSnapshot({
    models: { currentModelId: 'grok-4.6' },
    _meta: {
      'x.ai/sessionConfig': {
        options: [
          { id: 'grok-4.6', category: 'model', selected: true },
          { id: 'grok-4.5', category: 'model', selected: false },
          { id: 'xhigh', category: 'mode', selected: true },
          { id: 'high', category: 'mode', selected: false },
        ],
      },
    },
  });
  assert.deepEqual(snap, { modelId: 'grok-4.6', reasoningEffort: 'xhigh' });
});

test('ingestSessionSnapshot ignores empty or unknown payloads', () => {
  assert.deepEqual(ingestSessionSnapshot(null), { modelId: null, reasoningEffort: null });
  assert.deepEqual(ingestSessionSnapshot({}), { modelId: null, reasoningEffort: null });
});

test('ingestSessionInfo accepts the nested x.ai session info wrapper', () => {
  assert.equal(ingestSessionInfo({ result: { model: 'grok-4.5' } }), 'grok-4.5');
  assert.equal(ingestSessionInfo({ model: 'grok-4.6' }), 'grok-4.6');
  assert.equal(ingestSessionInfo(null), null);
});

test('sessionModelSwitchBlockReason matches the live-switch gate', () => {
  assert.equal(sessionModelSwitchBlockReason({
    connected: true,
    status: 'idle',
    sessionReady: true,
  }), null);
  assert.equal(sessionModelSwitchBlockReason({ archived: true }), 'Archived conversations cannot switch models.');
  assert.equal(sessionModelSwitchBlockReason({ heldBy: 'tui', connected: true, status: 'idle' }), 'TUI is using this session.');
  assert.equal(sessionModelSwitchBlockReason({ connected: true, status: 'running' }), 'Wait until this turn finishes.');
  assert.equal(sessionModelSwitchBlockReason({ connected: true, status: 'idle', inFlight: 1 }), 'Wait until this turn finishes.');
  assert.equal(sessionModelSwitchBlockReason({ connected: false, status: 'disconnected' }), 'Reconnect to switch models.');
  assert.equal(sessionModelSwitchBlockReason({ connected: true, status: 'idle', sessionReady: false }), 'Session is not ready.');
});
