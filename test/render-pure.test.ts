import test from 'node:test';
import assert from 'node:assert/strict';

import {
  escapeHtml,
  isTodoWriteToolCall,
  isTerminalToolStatus,
  toolDurationShouldTick,
  toolRowPhase,
  collapseKindRuns,
  formatWorkLogHead,
  workRowHideAt,
  workRowIsHolding,
  WORK_ROW_SETTLE_MS,
} from '../src/lib/render.js';

test('escapeHtml escapes the four HTML-significant characters', () => {
  assert.equal(escapeHtml('&'), '&amp;');
  assert.equal(escapeHtml('<'), '&lt;');
  assert.equal(escapeHtml('>'), '&gt;');
  assert.equal(escapeHtml('"'), '&quot;');
});

test('escapeHtml passes through ordinary text unchanged', () => {
  assert.equal(escapeHtml('hello world'), 'hello world');
  assert.equal(escapeHtml(''), '');
  assert.equal(escapeHtml('1 + 1 = 2'), '1 + 1 = 2');
});

test('escapeHtml escapes a realistic injection payload', () => {
  assert.equal(
    escapeHtml('<script>alert("x")</script>'),
    '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;',
  );
});

test('escapeHtml replaces & before < and > so re-escaping does not double up', () => {
  // If we processed `<` first we would produce `&lt;` and then re-escape the
  // `&` to `&amp;lt;`. Verify the implementation orders & first.
  assert.equal(escapeHtml('<a>'), '&lt;a&gt;');
  assert.equal(escapeHtml('a & b > c'), 'a &amp; b &gt; c');
});

test('escapeHtml stringifies non-string input', () => {
  assert.equal(escapeHtml(42 as unknown as string), '42');
  assert.equal(escapeHtml(null as unknown as string), 'null');
  assert.equal(escapeHtml(undefined as unknown as string), 'undefined');
});

test('isTodoWriteToolCall identifies grok TodoWrite calls by rawInput.variant', () => {
  assert.equal(isTodoWriteToolCall({ rawInput: { variant: 'TodoWrite' } }), true);
  assert.equal(isTodoWriteToolCall({ rawInput: { variant: 'TodoWrite', todos: [] } }), true);
});

test('isTodoWriteToolCall returns false for other tool kinds', () => {
  assert.equal(isTodoWriteToolCall({ rawInput: { variant: 'Read' } }), false);
  assert.equal(isTodoWriteToolCall({ rawInput: { command: 'ls' } }), false);
  assert.equal(isTodoWriteToolCall({ kind: 'TodoWrite' }), false); // kind alone is not enough
});

test('isTodoWriteToolCall returns false for missing or malformed input', () => {
  // The strict signature is `ToolPayload | null | undefined`, but the function
  // also guards against `rawInput: null` at runtime. Cast through unknown for
  // the null case so the runtime guard is exercised under tsc strict.
  assert.equal(isTodoWriteToolCall(null), false);
  assert.equal(isTodoWriteToolCall(undefined), false);
  assert.equal(isTodoWriteToolCall({}), false);
  assert.equal(isTodoWriteToolCall({ rawInput: null } as unknown as Parameters<typeof isTodoWriteToolCall>[0]), false);
  assert.equal(isTodoWriteToolCall({ rawInput: undefined }), false);
});

test('isTerminalToolStatus treats completed/failed/canceled (and aliases) as done', () => {
  assert.equal(isTerminalToolStatus('completed'), true);
  assert.equal(isTerminalToolStatus('Completed'), true);
  assert.equal(isTerminalToolStatus('failed'), true);
  assert.equal(isTerminalToolStatus('error'), true);
  assert.equal(isTerminalToolStatus('canceled'), true);
  assert.equal(isTerminalToolStatus('cancelled'), true);
  assert.equal(isTerminalToolStatus('done'), true);
  assert.equal(isTerminalToolStatus('running'), false);
  assert.equal(isTerminalToolStatus('pending'), false);
  assert.equal(isTerminalToolStatus(''), false);
  assert.equal(isTerminalToolStatus(null), false);
});

test('toolDurationShouldTick only runs for live non-terminal cards', () => {
  assert.equal(toolDurationShouldTick('running', true), true);
  assert.equal(toolDurationShouldTick('pending', true), true);
  assert.equal(toolDurationShouldTick('completed', true), false);
  assert.equal(toolDurationShouldTick('failed', true), false);
  assert.equal(toolDurationShouldTick('done', true), false);
  assert.equal(toolDurationShouldTick('running', false), false);
  assert.equal(toolDurationShouldTick('pending', false), false);
});

test('toolRowPhase keeps todos visible and splits live from done', () => {
  assert.equal(toolRowPhase('running'), 'live');
  assert.equal(toolRowPhase('pending'), 'live');
  assert.equal(toolRowPhase('completed'), 'done');
  assert.equal(toolRowPhase('failed'), 'done');
  assert.equal(toolRowPhase('running', true), 'todo');
  assert.equal(toolRowPhase('completed', true), 'todo');
});

test('collapseKindRuns merges consecutive repeats and keeps order', () => {
  assert.deepEqual(collapseKindRuns(['read', 'read', 'search', 'read']), [
    { kind: 'read', n: 2 },
    { kind: 'search', n: 1 },
    { kind: 'read', n: 1 },
  ]);
  assert.deepEqual(collapseKindRuns([]), []);
  assert.deepEqual(collapseKindRuns(['', '  ']), [{ kind: 'tool', n: 2 }]);
});

test('formatWorkLogHead collapsed shows completed kinds and keeps live out of the chip list', () => {
  const mixed = formatWorkLogHead({
    done: 3,
    live: 2,
    kinds: ['read', 'read', 'search'],
    open: false,
  });
  assert.equal(mixed.title, '');
  assert.equal(mixed.count, '3 done');
  assert.deepEqual(mixed.chips, [
    { kind: 'read', n: 2 },
    { kind: 'search', n: 1 },
  ]);

  const liveOnly = formatWorkLogHead({ done: 0, live: 2, kinds: [], open: false });
  assert.equal(liveOnly.title, '2 working');
  assert.equal(liveOnly.count, '');
  assert.deepEqual(liveOnly.chips, []);

  const doneOnly = formatWorkLogHead({
    done: 1,
    live: 0,
    kinds: ['search'],
    open: false,
  });
  assert.equal(doneOnly.title, '');
  assert.equal(doneOnly.count, '1 tool');
  assert.deepEqual(doneOnly.chips, [{ kind: 'search', n: 1 }]);
});

test('formatWorkLogHead expanded is a count, not a chip strip', () => {
  const open = formatWorkLogHead({
    done: 3,
    live: 2,
    kinds: ['read', 'search'],
    open: true,
  });
  assert.equal(open.title, '5 tools');
  assert.equal(open.count, '');
  assert.deepEqual(open.chips, []);
});

test('workRowHideAt holds live completions and hides history immediately', () => {
  assert.equal(workRowHideAt({
    phase: 'live', settle: true, prevHideAt: null, now: 1000,
  }), null);
  assert.equal(workRowHideAt({
    phase: 'todo', settle: true, prevHideAt: null, now: 1000,
  }), null);
  assert.equal(workRowHideAt({
    phase: 'done', settle: true, prevHideAt: null, now: 1000,
  }), 1000 + WORK_ROW_SETTLE_MS);
  assert.equal(workRowHideAt({
    phase: 'done', settle: false, prevHideAt: null, now: 1000,
  }), 0);
  assert.equal(workRowHideAt({
    phase: 'done', settle: true, prevHideAt: 2500, now: 3000,
  }), 2500);
});

test('workRowIsHolding is only true before the hide timestamp', () => {
  assert.equal(workRowIsHolding(null, 1000), false);
  assert.equal(workRowIsHolding(0, 1000), false);
  assert.equal(workRowIsHolding(3000, 1000), true);
  assert.equal(workRowIsHolding(3000, 3000), false);
  assert.equal(workRowIsHolding(3000, 3001), false);
});
