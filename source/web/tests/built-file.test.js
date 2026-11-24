/* The page people download must be the page the sources build.
 *
 * Mahjong-Tournament-System.html at the root of the repository is a build
 * output that is committed on purpose: there are no releases, so that file is
 * the download, and an organiser gets whatever is sitting on `main`.
 *
 * Which makes staleness the one failure that matters here. A change to
 * web/src that nobody rebuilt would leave the repository advertising a
 * program it no longer contains, and nothing about the page would look wrong
 * -- it would just be last week's. So the comparison is byte for byte against
 * a fresh build, and the fix is one command:
 *
 *   node source/web/build.js
 *
 * That is also why build.js puts no timestamp in the page. If it did, every
 * build would differ from the last and this test could never be written.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { build, checkSelfContained, OUTPUT_NAME } = require('../build.js');

// source/web/tests -> the repository root, where the committed page lives.
const ROOT = path.join(__dirname, '..', '..', '..');
const COMMITTED = path.join(ROOT, OUTPUT_NAME);

/** Build into a throwaway directory, so the test cannot repair what it checks. */
function freshBuild() {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'mts-build-'));
  const target = build({ out });
  const bytes = fs.readFileSync(target);
  fs.rmSync(out, { recursive: true, force: true });
  return bytes;
}

test(`${OUTPUT_NAME} is committed at the root`, () => {
  assert.ok(fs.existsSync(COMMITTED),
    `${OUTPUT_NAME} is missing from the root of the repository. It is the `
    + 'download: run `node source/web/build.js` and commit it.');
});

test('the committed page is a current build of web/src', () => {
  const fresh = freshBuild();
  const committed = fs.readFileSync(COMMITTED);

  if (committed.equals(fresh)) return;

  // Say where it went wrong, rather than printing 300 KB of HTML.
  const a = committed.toString('utf8').split('\n');
  const b = fresh.toString('utf8').split('\n');
  const at = a.findIndex((line, i) => line !== b[i]);
  const where = at === -1
    ? `the files are identical for ${Math.min(a.length, b.length)} lines, then one ends`
    : `first difference at line ${at + 1}:\n`
      + `  committed: ${String(a[at]).slice(0, 100)}\n`
      + `  rebuilt:   ${String(b[at]).slice(0, 100)}`;

  assert.fail(
    `${OUTPUT_NAME} is not what web/src builds -- it is stale, or it was edited `
    + `by hand.\nRun \`node source/web/build.js\` and commit the result.\n\n${where}`);
});

test('the committed page has nothing left to fetch', () => {
  // The whole point of one file is that a double-clicked page needs no
  // network. Checked against the committed bytes, not a fresh build, because
  // the committed bytes are what someone downloads.
  assert.deepEqual(checkSelfContained(COMMITTED), []);
});
