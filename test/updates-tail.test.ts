import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { UpdatesFileTail } from '../lib/updates-tail.js';

test('UpdatesFileTail emits only lines appended after start', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-tail-'));
  const file = path.join(dir, 'updates.jsonl');
  const first = JSON.stringify({
    timestamp: 1_700_000_000,
    method: 'session/update',
    params: { update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'old' } } },
  }) + '\n';
  fs.writeFileSync(file, first);
  const seen: string[] = [];
  const tail = new UpdatesFileTail(file, 'sid', (evs) => {
    for (const e of evs) seen.push(String(e.data['text'] || e.event));
  }, 10_000);
  tail.start();
  const next = JSON.stringify({
    timestamp: 1_700_000_100,
    method: 'session/update',
    params: { update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'new' } } },
  }) + '\n';
  fs.appendFileSync(file, next);
  const got = tail.poll();
  assert.equal(got.length, 1);
  assert.equal(got[0]?.data['text'], 'new');
  assert.deepEqual(seen, ['new']);
  tail.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('UpdatesFileTail passes through task_backgrounded and task_completed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-tail-bg-'));
  const file = path.join(dir, 'updates.jsonl');
  fs.writeFileSync(file, '');
  const seen: string[] = [];
  const tail = new UpdatesFileTail(file, 'sid', (evs) => {
    for (const e of evs) seen.push(e.event);
  }, 10_000);
  tail.start();
  fs.appendFileSync(file, JSON.stringify({
    timestamp: 1_700_000_200,
    method: 'session/update',
    params: { update: { sessionUpdate: 'task_backgrounded', task_id: 'bg1', command: 'echo hi' } },
  }) + '\n');
  fs.appendFileSync(file, JSON.stringify({
    timestamp: 1_700_000_210,
    method: '_x.ai/session/update',
    params: { update: { sessionUpdate: 'task_completed', task_snapshot: { task_id: 'bg1', exit_code: 0 } } },
  }) + '\n');
  const got = tail.poll();
  assert.equal(got.length, 2);
  assert.equal(got[0]?.event, 'task_backgrounded');
  assert.equal(got[0]?.data['task_id'], 'bg1');
  assert.equal(got[1]?.event, 'task_completed');
  assert.deepEqual(seen, ['task_backgrounded', 'task_completed']);
  tail.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});
