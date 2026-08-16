import test from 'node:test';
import assert from 'node:assert/strict';

import {
  pickComposerChips,
  composerCanSend,
  insertComposerCommand,
} from '../src/lib/composer-chips.js';

test('pickComposerChips skips unnamed entries and de-duplicates by name', () => {
  assert.deepEqual(
    pickComposerChips([
      { name: 'review', description: 'review the diff', kind: 'skill' },
      { name: 'review', description: 'ignored duplicate' },
      { name: '', description: 'empty' },
      { description: 'no name' },
      { name: 'commit', kind: 'command' },
    ], 6),
    [
      { name: 'review', description: 'review the diff', kind: 'skill' },
      { name: 'commit', description: '', kind: 'command' },
    ],
  );
});

test('pickComposerChips respects the limit', () => {
  const cmds = ['a', 'b', 'c', 'd'].map((name) => ({ name }));
  assert.equal(pickComposerChips(cmds, 2).length, 2);
  assert.deepEqual(pickComposerChips(null, 4), []);
});

test('composerCanSend requires text or at least one attachment', () => {
  assert.equal(composerCanSend('', 0), false);
  assert.equal(composerCanSend('   ', 0), false);
  assert.equal(composerCanSend('hello', 0), true);
  assert.equal(composerCanSend('', 1), true);
  assert.equal(composerCanSend('  x  ', 2), true);
});

test('insertComposerCommand replaces a slash draft and prepends onto other text', () => {
  assert.equal(insertComposerCommand('', 'review'), '/review ');
  assert.equal(insertComposerCommand('/re', 'review'), '/review ');
  assert.equal(insertComposerCommand('fix the login bug', 'review'), '/review fix the login bug');
  assert.equal(insertComposerCommand('/review already', 'review'), '/review already');
});
