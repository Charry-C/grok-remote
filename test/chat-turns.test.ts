import test from 'node:test';
import assert from 'node:assert/strict';

import {
  eventTimeMs,
  hasMatchingUserTurn,
  isNonTextUserContent,
  isReplayPayload,
  isStaleLiveEvent,
  normalizeUserText,
  shouldRenderUserBubble,
  userTextsMatch,
} from '../src/lib/chat-turns.js';

test('isReplayPayload reads _meta.isReplay on the envelope and on .data', () => {
  assert.equal(isReplayPayload({ _meta: { isReplay: true } }), true);
  assert.equal(isReplayPayload({ data: { _meta: { isReplay: true } } }), true);
  assert.equal(isReplayPayload({ _meta: { isReplay: false } }), false);
  assert.equal(isReplayPayload({ text: 'hello' }), false);
  assert.equal(isReplayPayload(null), false);
});

test('isReplayPayload reads params._meta.isReplay from x.ai session updates', () => {
  // session/load replays turn_completed with isReplay on params._meta.
  assert.equal(isReplayPayload({
    method: '_x.ai/session/update',
    params: { _meta: { isReplay: true }, update: { sessionUpdate: 'turn_completed' } },
  }), true);
  assert.equal(isReplayPayload({
    method: '_x.ai/session/update',
    params: { _meta: { isReplay: false }, update: { sessionUpdate: 'turn_completed' } },
  }), false);
});

test('eventTimeMs prefers _t then nested data._t then ISO at', () => {
  assert.equal(eventTimeMs({ _t: 100 }), 100);
  assert.equal(eventTimeMs({ data: { _t: 200 } }), 200);
  assert.equal(eventTimeMs({ at: '2026-08-15T00:00:00.000Z' }), Date.parse('2026-08-15T00:00:00.000Z'));
  assert.equal(eventTimeMs({}), null);
});

test('isStaleLiveEvent drops events at or before the history watermark', () => {
  assert.equal(isStaleLiveEvent({ _t: 50 }, 100), true);
  assert.equal(isStaleLiveEvent({ _t: 100 }, 100), true);
  assert.equal(isStaleLiveEvent({ _t: 101 }, 100), false);
  assert.equal(isStaleLiveEvent({ _t: 50 }, null), false);
  assert.equal(isStaleLiveEvent({ text: 'no clock' }, 100), false);
});

test('isNonTextUserContent skips image and resource_link chunks', () => {
  assert.equal(isNonTextUserContent({ content: { type: 'image', data: 'abc' } }), true);
  assert.equal(isNonTextUserContent({ content: { type: 'resource_link', uri: 'file://x' } }), true);
  assert.equal(isNonTextUserContent({ content: { type: 'text', text: 'hi' } }), false);
  assert.equal(isNonTextUserContent({ text: 'hi' }), false);
});

test('shouldRenderUserBubble is false for empty text and no attachments', () => {
  assert.equal(shouldRenderUserBubble(''), false);
  assert.equal(shouldRenderUserBubble('   \n'), false);
  assert.equal(shouldRenderUserBubble(null), false);
  assert.equal(shouldRenderUserBubble('hello'), true);
  assert.equal(shouldRenderUserBubble('', [{ name: 'a.png' }]), true);
});

test('userTextsMatch treats the Attached files trailer as the same prompt', () => {
  const raw = 'optimize the composer';
  const composed = 'optimize the composer\n\nAttached files:\n- /tmp/a.jpg (image/jpeg, 1 kB)';
  assert.equal(userTextsMatch(raw, composed), true);
  assert.equal(userTextsMatch(composed, raw), true);
  assert.equal(userTextsMatch(raw, raw), true);
  assert.equal(userTextsMatch(raw, 'something else'), false);
});

test('hasMatchingUserTurn finds a prior turn with the same user text', () => {
  const turns = [{ userText: '你好' }, { userText: '下一句' }];
  assert.equal(hasMatchingUserTurn(turns, '你好'), true);
  assert.equal(hasMatchingUserTurn(turns, '没有'), false);
  assert.equal(hasMatchingUserTurn(turns, ''), false);
});

test('normalizeUserText trims trailing whitespace', () => {
  assert.equal(normalizeUserText(' hi \n'), 'hi');
});
