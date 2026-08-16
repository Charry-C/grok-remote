import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = fs.readFileSync(path.join(root, 'src/style.css'), 'utf8');
const agents = fs.readFileSync(path.join(root, 'src/views/agents.ts'), 'utf8');

function block(src: string, selector: string): string {
  const idx = src.indexOf(selector);
  assert.ok(idx >= 0, `missing selector ${selector}`);
  const start = src.indexOf('{', idx);
  const end = src.indexOf('}', start);
  assert.ok(start >= 0 && end > start, `unclosed block ${selector}`);
  return src.slice(start, end + 1);
}

test('folder headers pin to the same top: 0 slot (overlay, not stacked)', () => {
  const header = block(css, '.folder-header {');
  assert.match(header, /position:\s*sticky/);
  assert.match(header, /top:\s*0/);
  // A second sticky bar under the first would use a non-zero top.
  assert.doesNotMatch(header, /top:\s*[1-9]/);
});

test('agents-list sizes to content so sticky is not clipped to the viewport', () => {
  const list = block(css, '.agents-list {');
  assert.match(list, /flex:\s*0\s+0\s+auto/);
});

test('folder groups do not form their own sticky containing block', () => {
  const group = block(css, '.folder-group {');
  assert.match(group, /display:\s*contents/);
});

test('renderGroup emits header + body as siblings, not a wrapping box', () => {
  assert.match(agents, /createDocumentFragment/);
  assert.match(agents, /frag\.append\(header, body\)/);
  assert.doesNotMatch(agents, /class: 'folder-group'/);
});
