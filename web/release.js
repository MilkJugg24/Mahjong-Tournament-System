#!/usr/bin/env node
/* Build what people download.
 *
 *   mahjong-tournament.html   the whole program, one file
 *
 * That is the only artefact. Save it anywhere and double-click it.
 *
 * There used to be a zip as well, holding the same file plus the guides. The
 * guides are now in the program itself, under Help, so the zip only offered a
 * second thing to download that was worse than the first -- a folder to unpack
 * instead of a file to open.
 *
 * What this adds over `build.js` is the version check: it refuses to build if
 * the requested version disagrees with web/package.json, so the program can
 * never report a different version from the file people downloaded.
 *
 *   node web/release.js [--out DIR] [--version X.Y.Z]
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { build, OUTPUT_NAME } = require('./build.js');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_OUT = path.join(ROOT, 'dist');
const PROJECT = 'mahjong-tournament';

function packageVersion() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version;
}

function release({ out = DEFAULT_OUT, version = null } = {}) {
  const pkgVersion = packageVersion();
  const wanted = String(version || pkgVersion).replace(/^v/, '');
  if (wanted !== pkgVersion) {
    throw new Error(
      `version mismatch: asked for "${wanted}" but web/package.json says "${pkgVersion}".\n`
      + 'Bump the version there so the program reports the same version as the file '
      + 'people downloaded.');
  }

  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });

  const builtDir = path.join(out, '_build');
  build({ out: builtDir });
  const html = fs.readFileSync(path.join(builtDir, OUTPUT_NAME));
  const htmlPath = path.join(out, OUTPUT_NAME);
  fs.writeFileSync(htmlPath, html);
  fs.rmSync(builtDir, { recursive: true, force: true });

  return { version: wanted, html: htmlPath, bytes: html.length };
}

const human = (bytes) => (bytes < 1024 * 1024
  ? `${(bytes / 1024).toFixed(0)} KB`
  : `${(bytes / 1048576).toFixed(1)} MB`);

if (require.main === module) {
  const args = process.argv.slice(2);
  const pick = (flag) => {
    const i = args.indexOf(flag);
    return i > -1 ? args[i + 1] : null;
  };
  try {
    const result = release({ out: pick('--out') || DEFAULT_OUT, version: pick('--version') });
    console.log(`Built version ${result.version}:`);
    console.log(`  ${result.html}  (${human(result.bytes)})`);
  } catch (err) {
    console.error(`\nRELEASE BUILD FAILED: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { release, PROJECT };
