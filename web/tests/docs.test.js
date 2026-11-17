/* The docs that point at code.
 *
 * docs/CODE_MAP.md exists to save a newcomer from hunting, which it only does
 * while its pointers are true. rational.js spent a while citing a test file
 * that had been deleted with the Python; that is the failure mode this guards
 * against. If you rename a function, this test tells you which doc now lies.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(__dirname, '..', 'src');
const read = (p) => fs.readFileSync(p, 'utf8');

const MAP = path.join(ROOT, 'docs', 'CODE_MAP.md');

/** Does `name` look like a function or method defined in this source? */
function defines(code, name) {
  const n = name.replace(/[$]/g, '\\$');
  const patterns = [
    new RegExp(`function\\s+${n}\\b`),                      // function foo(
    new RegExp(`^\\s*(?:async\\s+|static\\s+|\\*\\s*)*${n}\\s*\\(`, 'm'), // class method
    new RegExp(`\\b${n}\\s*[:=]\\s*(?:async\\s*)?(?:function\\b|\\()`),   // foo = ( / foo: (
  ];
  return patterns.some((re) => re.test(code));
}

test('CODE_MAP.md exists and points at the real files', () => {
  assert.ok(fs.existsSync(MAP), 'docs/CODE_MAP.md is missing');
  const md = read(MAP);
  const files = new Set(md.match(/`([a-z_]+\.js)`/g) || []);
  assert.ok(files.size >= 8, 'the map should cover the whole program');

  for (const quoted of files) {
    const name = quoted.replace(/`/g, '');
    const inSrc = fs.existsSync(path.join(SRC, name));
    const inWeb = fs.existsSync(path.join(__dirname, '..', name));
    assert.ok(inSrc || inWeb, `CODE_MAP.md names ${name}, which does not exist`);
  }
});

test('every function CODE_MAP.md names really exists', () => {
  const md = read(MAP);
  const rows = md.split('\n').filter((l) => l.trim().startsWith('|'));
  const misses = [];
  let checked = 0;

  for (const row of rows) {
    const files = (row.match(/`([a-z_]+\.js)`/g) || []).map((s) => s.replace(/`/g, ''));
    const funcs = (row.match(/`([A-Za-z_][A-Za-z0-9_]*)\(\)`/g) || [])
      .map((s) => s.replace(/[`()]/g, ''));
    if (!files.length || !funcs.length) continue;

    const file = path.join(SRC, files[0]);
    if (!fs.existsSync(file)) { misses.push(`${files[0]} does not exist`); continue; }
    const code = read(file);
    for (const fn of funcs) {
      checked += 1;
      if (!defines(code, fn)) misses.push(`${files[0]} does not define ${fn}()`);
    }
  }

  assert.ok(checked >= 10, `only checked ${checked} references; the parser is probably broken`);
  assert.deepEqual(misses, [], misses.join('; '));
});

/* Checked against the files git tracks, not against the working directory.
 *
 * The filesystem is the wrong question to ask. Docs legitimately name build
 * outputs -- TECHNICAL.md says `node web/build.js` writes
 * web/dist/mahjong-tournament.html -- and whether that happens to be on disk
 * depends only on whether anyone has run a build lately. Asking the filesystem
 * made this test pass locally, where a build was lying around, and fail in CI
 * on a fresh checkout. Tracked files are the same everywhere.
 */
let TRACKED = null;
function trackedFiles() {
  if (TRACKED) return TRACKED;
  const { execFileSync } = require('node:child_process');
  try {
    const out = execFileSync('git', ['-C', ROOT, 'ls-files', '-z'], { encoding: 'utf8' });
    TRACKED = new Set(out.split('\0').filter(Boolean));
  } catch {
    TRACKED = new Set(); // no git: the tests below skip rather than lie
  }
  return TRACKED;
}

/** A path a doc may name: tracked in the repo, or a known build output. */
function namesSomethingReal(rel) {
  if (/(?:^|\/)dist\//.test(rel)) return true; // build output, not a source file
  return trackedFiles().has(rel);
}

test('no doc points at a file that no longer exists', (t) => {
  if (trackedFiles().size === 0) return t.skip('git is not available here');

  const docs = fs.readdirSync(path.join(ROOT, 'docs'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => path.join(ROOT, 'docs', f));
  docs.push(path.join(ROOT, 'README.md'));

  const misses = [];
  for (const doc of docs) {
    const text = read(doc);
    // Repo-relative paths written as web/..., docs/... or .github/...
    for (const m of text.matchAll(/(?:^|[\s(`"])((?:web|docs|\.github)\/[\w./-]+\.(?:json|html|yml|css|js|md))(?![\w])/g)) {
      const rel = m[1];
      if (!namesSomethingReal(rel)) {
        misses.push(`${path.basename(doc)} points at ${rel}, which is not in the repository`);
      }
    }
  }
  return assert.deepEqual(misses, [], misses.join('; '));
});

test('source headers do not point at files that were deleted', (t) => {
  if (trackedFiles().size === 0) return t.skip('git is not available here');

  const misses = [];
  for (const name of fs.readdirSync(SRC).filter((f) => f.endsWith('.js'))) {
    const code = read(path.join(SRC, name));
    const header = code.slice(0, code.indexOf('*/') + 2);
    for (const m of header.matchAll(/((?:web|docs)\/[\w./-]+\.(?:json|js|md))(?![\w])/g)) {
      if (!namesSomethingReal(m[1])) {
        misses.push(`${name} cites ${m[1]}, which is not in the repository`);
      }
    }
  }
  assert.deepEqual(misses, [], misses.join('; '));
});

/* ------------------------------------------------- the built file's index */

test('the built page carries a navigable contents index', () => {
  const { build, OUTPUT_NAME } = require('../build.js');
  const out = path.join(__dirname, '..', 'dist');
  build({ out });
  const html = read(path.join(out, OUTPUT_NAME));
  const lines = html.split('\n');

  const rows = lines.filter((l) => /RT:FILE \S+\s+line\s+\d+/.test(l));
  assert.ok(rows.length >= 8, `the contents index lists only ${rows.length} files`);

  // Every stated line number must actually be that file's banner. An index
  // that is off by a few is worse than none at all.
  for (const row of rows) {
    const [, name, at] = row.match(/RT:FILE (\S+)\s+line\s+(\d+)/);
    const target = lines[Number(at) - 1];
    assert.ok(target !== undefined, `${name}: index points past the end of the file`);
    assert.ok(target.includes(`RT:FILE ${name}`),
      `${name}: index says line ${at}, but that line is: ${String(target).slice(0, 60)}`);
  }
});

test('the arithmetic is flagged in the built page', () => {
  // Builds its own copy rather than relying on the test above having run.
  const { build, OUTPUT_NAME } = require('../build.js');
  const out = path.join(__dirname, '..', 'dist');
  build({ out });
  const html = read(path.join(out, OUTPUT_NAME));
  const flagged = (html.match(/RT:FILE (\S+)[^\n]*<-- the arithmetic/g) || [])
    .map((l) => l.match(/RT:FILE (\S+)/)[1]);
  assert.deepEqual(flagged.sort(), ['rational.js', 'scoring.js'],
    'the contents index should point a reader at the scoring arithmetic');
});
