#!/usr/bin/env node
/* Run the test suite.
 *
 * `node --test "tests/*.test.js"` only expands a glob from Node 22 onward, and
 * a shell glob does not expand at all on the Windows runner. So the files are
 * found here and passed to the test runner explicitly, which every supported
 * version understands.
 *
 *   node web/run-tests.js              every test
 *   node web/run-tests.js browser      only files whose name contains "browser"
 *   node web/run-tests.js --not browser  everything except those
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TESTS = path.join(__dirname, 'tests');

const args = process.argv.slice(2);
const negate = args.includes('--not');
const filters = args.filter((a) => a !== '--not');

const all = fs.readdirSync(TESTS)
  .filter((name) => name.endsWith('.test.js'))
  .sort();

const chosen = all.filter((name) => {
  if (!filters.length) return true;
  const hit = filters.some((f) => name.includes(f));
  return negate ? !hit : hit;
});

if (!chosen.length) {
  console.error(`No test files matched ${filters.join(', ') || '(everything)'} in ${TESTS}`);
  process.exit(1);
}

const files = chosen.map((name) => path.join(TESTS, name));
console.log(`Running ${files.length} test file(s) on Node ${process.version}:`);
for (const name of chosen) console.log(`  ${name}`);
console.log('');

const result = spawnSync(process.execPath, ['--test', ...files], {
  stdio: 'inherit',
  cwd: path.join(__dirname, '..'),
});

process.exit(result.status === null ? 1 : result.status);
