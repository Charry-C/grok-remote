import test from 'node:test';
import assert from 'node:assert/strict';

import { ICONS, iconHtml, GROK_MARK_SVG } from '../src/lib/icons.js';

test('iconHtml returns an empty string for unknown icon names', () => {
  assert.equal(iconHtml('not-a-real-icon'), '');
  assert.equal(iconHtml(''), '');
});

test('iconHtml returns the matching SVG markup for known icons', () => {
  const svg = iconHtml('plus');
  assert.ok(svg.startsWith('<svg'));
  assert.match(svg, /viewBox="0 0 20 20"/);
  assert.match(svg, /aria-hidden="true"/);
});

test('all registered icons wrap into a <svg> with the shared viewBox and accessibility hint', () => {
  for (const [name, markup] of Object.entries(ICONS)) {
    assert.ok(markup.startsWith('<svg'), `${name} should start with <svg`);
    assert.match(markup, /viewBox="0 0 20 20"/);
    assert.match(markup, /aria-hidden="true"/);
    assert.match(markup, /stroke="currentColor"/);
    assert.ok(markup.endsWith('</svg>'), `${name} should end with </svg>`);
  }
});

test('icon registry covers the rail-required names', () => {
  // Live ICONS set used by the phone-first UI. If any of them is missing the
  // matching control renders blank.
  const required = [
    'plus',
    'models',
    'chevron-down',
    'send',
    'stop',
    'skills',
    'folder',
    'import',
    'sliders',
    'moon',
    'sun',
    'trash',
    'check',
    'star',
    'pencil',
    'inbox',
    'archive',
    'copy',
    'panel-left-open',
    'panel-left-close',
  ];
  for (const name of required) {
    assert.ok(iconHtml(name).length > 0, `expected icon "${name}" to be registered`);
  }
});

test('Grok welcome lockup ships a filled mark', () => {
  const markup = GROK_MARK_SVG;
  assert.ok(markup.startsWith('<svg'), 'mark should start with <svg');
  assert.match(markup, /fill="currentColor"/);
  assert.match(markup, /aria-hidden="true"/);
  assert.ok(markup.includes('<path'), 'mark should include path data');
  assert.ok(markup.endsWith('</svg>'), 'mark should end with </svg>');
  assert.ok(!markup.includes('What do you want to know'));
});
