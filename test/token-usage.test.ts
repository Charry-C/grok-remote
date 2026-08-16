import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractTokenMeta,
  hasTokenUsage,
  hasCost,
  hasTurnLedger,
  mergeTokenMeta,
  isTurnCompletedPayload,
} from '../src/lib/token-usage.js';

test('extractTokenMeta reads prompt_result._meta and nested usage', () => {
  const payload = {
    stopReason: 'end_turn',
    _meta: {
      sessionId: 's1',
      promptId: 'p1',
      totalTokens: 15775,
      modelId: 'grok-4.6',
      inputTokens: 15559,
      outputTokens: 215,
      cachedReadTokens: 14080,
      reasoningTokens: 82,
      usage: {
        inputTokens: 15559,
        outputTokens: 215,
        totalTokens: 15775,
        cachedReadTokens: 14080,
        reasoningTokens: 82,
      },
    },
  };
  const meta = extractTokenMeta(payload);
  assert.ok(meta);
  assert.equal(meta!.inputTokens, 15559);
  assert.equal(meta!.outputTokens, 215);
  assert.equal(meta!.cachedReadTokens, 14080);
  assert.equal(meta!.reasoningTokens, 82);
  assert.equal(meta!.totalTokens, 15775);
  assert.equal(meta!.modelId, 'grok-4.6');
  assert.equal(meta!.stopReason, 'end_turn');
  assert.equal(hasTokenUsage(meta), true);
});

test('extractTokenMeta reads turn_completed update.usage', () => {
  const payload = {
    method: '_x.ai/session/update',
    params: {
      sessionId: 's1',
      update: {
        sessionUpdate: 'turn_completed',
        prompt_id: 'p1',
        stop_reason: 'end_turn',
        usage: {
          inputTokens: 14170,
          outputTokens: 61,
          totalTokens: 14231,
          cachedReadTokens: 0,
          reasoningTokens: 35,
        },
      },
    },
  };
  const meta = extractTokenMeta(payload);
  assert.ok(meta);
  assert.equal(meta!.inputTokens, 14170);
  assert.equal(meta!.outputTokens, 61);
  assert.equal(meta!.cachedReadTokens, 0);
  assert.equal(meta!.reasoningTokens, 35);
  assert.equal(meta!.stopReason, 'end_turn');
  assert.equal(isTurnCompletedPayload(payload), true);
});

test('extractTokenMeta treats a tokenless prompt_complete as stop-only', () => {
  const meta = extractTokenMeta({
    sessionId: 's1',
    promptId: 'p1',
    stopReason: 'end_turn',
    agentResult: null,
  });
  assert.ok(meta);
  assert.equal(meta!.stopReason, 'end_turn');
  assert.equal(hasTokenUsage(meta), false);
});

test('extractTokenMeta returns null for empty or unrelated payloads', () => {
  assert.equal(extractTokenMeta(null), null);
  assert.equal(extractTokenMeta({}), null);
  assert.equal(extractTokenMeta({ sessionUpdate: 'tool_call' }), null);
});

test('extractTokenMeta accepts snake_case aliases', () => {
  const meta = extractTokenMeta({
    input_tokens: 10,
    output_tokens: 4,
    cached_read_tokens: 2,
    reasoning_tokens: 1,
    total_tokens: 15,
    model_id: 'grok-4.6',
    stop_reason: 'max_tokens',
  });
  assert.ok(meta);
  assert.equal(meta!.inputTokens, 10);
  assert.equal(meta!.outputTokens, 4);
  assert.equal(meta!.cachedReadTokens, 2);
  assert.equal(meta!.reasoningTokens, 1);
  assert.equal(meta!.totalTokens, 15);
  assert.equal(meta!.modelId, 'grok-4.6');
  assert.equal(meta!.stopReason, 'max_tokens');
});

test('hasTokenUsage is true for a zero cached bucket', () => {
  assert.equal(hasTokenUsage({ cachedReadTokens: 0 }), true);
  assert.equal(hasTokenUsage({ inputTokens: 0 }), true);
  assert.equal(hasTokenUsage({ stopReason: 'end_turn' }), false);
  assert.equal(hasTokenUsage(null), false);
});

test('mergeTokenMeta keeps existing numbers when the extra payload is empty', () => {
  const merged = mergeTokenMeta(
    { inputTokens: 10, outputTokens: 2, cachedReadTokens: 0 },
    { stopReason: 'end_turn' },
  );
  assert.equal(merged.inputTokens, 10);
  assert.equal(merged.outputTokens, 2);
  assert.equal(merged.cachedReadTokens, 0);
  assert.equal(merged.stopReason, 'end_turn');
});

test('mergeTokenMeta lets a later ledger overwrite earlier chips', () => {
  const merged = mergeTokenMeta(
    { inputTokens: 1, outputTokens: 1 },
    { inputTokens: 15559, outputTokens: 215, reasoningTokens: 82 },
  );
  assert.equal(merged.inputTokens, 15559);
  assert.equal(merged.outputTokens, 215);
  assert.equal(merged.reasoningTokens, 82);
});

test('extractTokenMeta reads costUsdTicks from turn_completed usage', () => {
  const meta = extractTokenMeta({
    sessionUpdate: 'turn_completed',
    usage: {
      inputTokens: 812,
      outputTokens: 210,
      totalTokens: 1022,
      costUsdTicks: 126890500,
    },
  });
  assert.ok(meta);
  assert.equal(meta!.costUsdTicks, 126890500);
  assert.equal(hasCost(meta), true);
  assert.equal(hasTurnLedger(meta), true);
});

test('hasCost and hasTurnLedger treat cost-only payloads as a ledger', () => {
  assert.equal(hasCost({ costUsdTicks: 0 }), true);
  assert.equal(hasCost({ costUSD: 0.0127 }), true);
  assert.equal(hasCost({ stopReason: 'end_turn' }), false);
  assert.equal(hasTurnLedger({ costUsdTicks: 1 }), true);
  assert.equal(hasTurnLedger({ inputTokens: 1 }), true);
  assert.equal(hasTurnLedger({ stopReason: 'end_turn' }), false);
});

test('isTurnCompletedPayload ignores other x.ai session updates', () => {
  assert.equal(isTurnCompletedPayload({
    params: { update: { sessionUpdate: 'task_completed' } },
  }), false);
  assert.equal(isTurnCompletedPayload({
    update: { sessionUpdate: 'turn_completed' },
  }), true);
});
