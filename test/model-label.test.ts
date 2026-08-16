import test from 'node:test';
import assert from 'node:assert/strict';

import {
  prettyModelId,
  formatModelChip,
  resolveAgentModel,
  resolveAgentEffort,
  modelSwitchGate,
  grokModelVersion,
  effortsForModel,
  modelSupportsEffort,
  clampReasoningEffort,
} from '../src/lib/model-label.js';

test('prettyModelId strips a provider prefix and prettifies grok ids', () => {
  assert.equal(prettyModelId('xai/grok-4.6'), 'Grok 4.6');
  assert.equal(prettyModelId('grok-4.6'), 'Grok 4.6');
  assert.equal(prettyModelId('grok-4'), 'Grok 4');
  assert.equal(prettyModelId('grok-code-fast-1'), 'Grok Code Fast 1');
  assert.equal(prettyModelId('custom-llama'), 'custom-llama');
  assert.equal(prettyModelId('  '), '');
  assert.equal(prettyModelId(null), '');
});

test('formatModelChip joins pretty name and effort', () => {
  assert.equal(formatModelChip({ modelId: 'grok-4.6', effort: 'xhigh' }), 'Grok 4.6 xhigh');
  assert.equal(formatModelChip({ modelId: 'xai/grok-4.6', effort: 'high' }), 'Grok 4.6 high');
  assert.equal(formatModelChip({ modelId: 'grok-4.6' }), 'Grok 4.6');
  assert.equal(formatModelChip({
    modelId: 'grok-4.6',
    displayName: 'Grok 4.6',
    effort: 'xhigh',
  }), 'Grok 4.6 xhigh');
  assert.equal(formatModelChip({
    modelId: 'my-local',
    displayName: 'Local Llama',
    effort: 'low',
  }), 'Local Llama low');
  assert.equal(formatModelChip({}), 'Model');
  assert.equal(formatModelChip({ modelId: '', effort: '' }), 'Model');
});

test('resolveAgentModel prefers the live model over saved settings', () => {
  assert.equal(resolveAgentModel(null), '');
  assert.equal(resolveAgentModel({ model: 'grok-4' }), 'grok-4');
  assert.equal(resolveAgentModel({
    model: 'grok-4.6',
    settings: { model: 'grok-4.5' },
  }), 'grok-4.6');
  assert.equal(resolveAgentModel({
    model: '  ',
    settings: { model: 'grok-4.5' },
  }), 'grok-4.5');
});

test('resolveAgentEffort prefers the live effort over saved settings', () => {
  assert.equal(resolveAgentEffort(null), '');
  assert.equal(resolveAgentEffort({ model: 'grok-4.6' }), '');
  assert.equal(resolveAgentEffort({
    reasoningEffort: 'xhigh',
    settings: { reasoningEffort: 'high' },
  }), 'xhigh');
  assert.equal(resolveAgentEffort({
    settings: { reasoningEffort: 'high' },
  }), 'high');
});

test('grokModelVersion reads 4.5 / 4.6 family ids', () => {
  assert.deepEqual(grokModelVersion('grok-4.5'), { major: 4, minor: 5 });
  assert.deepEqual(grokModelVersion('xai/grok-4.6'), { major: 4, minor: 6 });
  assert.deepEqual(grokModelVersion('grok-4.20-multi-agent'), { major: 4, minor: 20 });
  assert.deepEqual(grokModelVersion('grok-4'), { major: 4, minor: 0 });
  assert.equal(grokModelVersion('grok-code-fast-1'), null);
  assert.equal(grokModelVersion(''), null);
});

test('effortsForModel hides xhigh on 4.5 and none/min on both 4.5 and 4.6', () => {
  assert.deepEqual(effortsForModel('grok-4.5').map((e) => e.id), ['low', 'medium', 'high']);
  assert.deepEqual(effortsForModel('xai/grok-4.5').map((e) => e.id), ['low', 'medium', 'high']);
  assert.deepEqual(
    effortsForModel('grok-4.6').map((e) => e.id),
    ['low', 'medium', 'high', 'xhigh'],
  );
  assert.deepEqual(
    effortsForModel('grok-4.20-multi-agent').map((e) => e.id),
    ['low', 'medium', 'high', 'xhigh'],
  );
  assert.ok(effortsForModel('custom-llama').some((e) => e.id === 'none'));
  assert.equal(modelSupportsEffort('grok-4.5', 'xhigh'), false);
  assert.equal(modelSupportsEffort('grok-4.5', 'high'), true);
  assert.equal(modelSupportsEffort('grok-4.6', 'xhigh'), true);
  assert.equal(modelSupportsEffort('grok-4.6', 'none'), false);
  assert.equal(modelSupportsEffort('grok-4.6', 'minimal'), false);
});

test('clampReasoningEffort snaps unsupported depths to the nearest advertised level', () => {
  assert.equal(clampReasoningEffort('grok-4.5', 'xhigh'), 'high');
  assert.equal(clampReasoningEffort('grok-4.5', 'none'), 'low');
  assert.equal(clampReasoningEffort('grok-4.5', 'minimal'), 'low');
  assert.equal(clampReasoningEffort('grok-4.5', 'medium'), 'medium');
  assert.equal(clampReasoningEffort('grok-4.6', 'none'), 'low');
  assert.equal(clampReasoningEffort('grok-4.6', 'xhigh'), 'xhigh');
  assert.equal(clampReasoningEffort('grok-4.6', ''), 'high');
  assert.equal(clampReasoningEffort('grok-4.5', ''), 'high');
  assert.equal(clampReasoningEffort('grok-4.5', 'nope'), 'high');
});

test('modelSwitchGate disables when the live session cannot switch', () => {
  const idle = {
    hasAgent: true,
    composerEnabled: true,
    agent: { connected: true, status: 'idle', sessionId: 's1' },
  };
  assert.deepEqual(modelSwitchGate(idle), { disabled: false, reason: null });
  assert.equal(modelSwitchGate({ ...idle, hasAgent: false }).disabled, true);
  assert.equal(modelSwitchGate({ ...idle, switching: true }).reason, 'Switching model\u2026');
  assert.equal(modelSwitchGate({ ...idle, inFlight: true }).reason, 'Wait until this turn finishes.');
  assert.equal(modelSwitchGate({
    ...idle,
    agent: { connected: true, status: 'idle', heldBy: 'tui' },
  }).reason, 'TUI is using this session.');
  assert.equal(modelSwitchGate({
    ...idle,
    agent: { connected: false, status: 'disconnected' },
  }).reason, 'Reconnect to switch models.');
  assert.equal(modelSwitchGate({
    ...idle,
    agent: { connected: true, status: 'idle' },
  }).reason, 'Session is not ready.');
});
