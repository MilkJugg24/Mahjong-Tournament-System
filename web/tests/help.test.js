/* Help content.
 *
 * The valuable test here is the last one: every "?" bubble in the markup has to
 * resolve to wording in help.js. A bubble with no text behind it looks like a
 * bug to the organiser, and nothing else would catch it until someone clicked.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { FIELD_HELP, TOPICS } = require('../src/help.js');

const SRC = path.join(__dirname, '..', 'src');
const read = (name) => fs.readFileSync(path.join(SRC, name), 'utf8');

test('every help topic is complete and uniquely identified', () => {
  assert.ok(TOPICS.length >= 5, 'expected a useful number of help topics');
  const ids = new Set();
  for (const topic of TOPICS) {
    assert.ok(topic.id, 'a topic has no id');
    assert.ok(!ids.has(topic.id), `duplicate topic id: ${topic.id}`);
    ids.add(topic.id);
    assert.ok(topic.title && topic.title.trim(), `topic ${topic.id} has no title`);
    assert.ok(topic.body && topic.body.trim().length > 80,
      `topic ${topic.id} has no real body`);
  }
});

test('help topics do not leave an unclosed tag', () => {
  // Crude, but it catches the mistake that actually happens when editing prose
  // with markup in it: a <p> or <li> left open, which swallows the rest.
  for (const topic of TOPICS) {
    for (const tag of ['p', 'li', 'ul', 'ol', 'b', 'code', 'pre']) {
      const open = (topic.body.match(new RegExp(`<${tag}(\\s[^>]*)?>`, 'g')) || []).length;
      const close = (topic.body.match(new RegExp(`</${tag}>`, 'g')) || []).length;
      assert.equal(open, close,
        `topic ${topic.id}: ${open} <${tag}> but ${close} </${tag}>`);
    }
  }
});

test('every field help entry says something, and not too much', () => {
  const keys = Object.keys(FIELD_HELP);
  assert.ok(keys.length >= 10, 'expected help for a fair number of fields');
  for (const key of keys) {
    const text = FIELD_HELP[key];
    assert.equal(typeof text, 'string', `${key} is not a string`);
    assert.ok(text.trim().length > 30, `${key} is too short to help anyone`);
    // These go in a small popover. Anything longer belongs in a help topic.
    assert.ok(text.length < 420, `${key} is ${text.length} chars; too long for a bubble`);
    assert.ok(!/<[a-z]/i.test(text), `${key} contains markup; bubbles are plain text`);
  }
});

test('field help keys are kebab-case or plain words', () => {
  for (const key of Object.keys(FIELD_HELP)) {
    assert.match(key, /^[a-z][a-z0-9-]*$/, `${key} is not a tidy data-help key`);
  }
});

/* ------------------------------------------------- markup and text agree */

function helpKeysInMarkup() {
  const sources = ['index.html', 'ui.js'];
  const found = new Map();
  for (const name of sources) {
    const text = read(name);
    const re = /data-help="([^"]+)"/g;
    let m = re.exec(text);
    while (m) {
      if (!found.has(m[1])) found.set(m[1], name);
      m = re.exec(text);
    }
  }
  return found;
}

test('every "?" bubble in the markup has wording behind it', () => {
  const used = helpKeysInMarkup();
  assert.ok(used.size > 0, 'no "?" bubbles found at all — did the markup change?');
  for (const [key, where] of used) {
    assert.ok(FIELD_HELP[key],
      `${where} has a "?" for "${key}" but help.js has no text for it`);
  }
});

test('no field help is left behind with nothing pointing at it', () => {
  // The mirror of the test above. An entry whose "?" has been removed from the
  // markup is dead text that still reads as current, and nothing else notices.
  const used = new Set(helpKeysInMarkup().keys());
  const orphans = Object.keys(FIELD_HELP).filter((k) => !used.has(k));
  assert.deepEqual(orphans, [],
    `help.js explains ${orphans.join(', ')}, but no "?" in the markup uses it`);
});

test('the "?" bubbles carry an accessible label', () => {
  const html = read('index.html');
  const bubbles = html.match(/<button[^>]*class="qmark"[^>]*>/g) || [];
  assert.ok(bubbles.length > 0, 'no "?" bubbles in index.html');
  for (const b of bubbles) {
    assert.ok(/aria-label=/.test(b), `a "?" bubble has no aria-label: ${b}`);
    assert.ok(/type="button"/.test(b),
      `a "?" bubble is not type=button, so it would submit: ${b}`);
  }
});

test('help.js and tutorial.js are loaded by the page, before ui.js', () => {
  const html = read('index.html');
  const order = ['help.js', 'tutorial.js', 'ui.js']
    .map((name) => html.indexOf(`<script src="${name}">`));
  for (const [i, at] of order.entries()) {
    assert.ok(at > -1, `${['help.js', 'tutorial.js', 'ui.js'][i]} is not loaded by index.html`);
  }
  assert.ok(order[0] < order[2], 'help.js must load before ui.js reads it');
  assert.ok(order[1] < order[2], 'tutorial.js must load before ui.js reads it');
});

test('the bundler inlines the new modules too', () => {
  const build = read('../build.js');
  for (const name of ['help.js', 'tutorial.js']) {
    assert.ok(build.includes(`'${name}'`),
      `${name} is missing from build.js SOURCES, so it would be dropped from the release`);
  }
});
