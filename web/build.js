#!/usr/bin/env node
/* Build the single file.
 *
 * A double-clicked .html runs on file://, where ES modules and fetch() are both
 * blocked by CORS -- measured, not assumed. So the sources are authored as
 * separate files and inlined here into one self-contained page with no external
 * references at all. That is also what makes it work offline: there is nothing
 * left to load.
 *
 * The output is committed at the root of the repository, because that is how
 * people get the program: there are no releases, so the file in the repository
 * is the download. Two things follow from that, and both matter.
 *
 * The build must be deterministic. The same sources must produce the same
 * bytes, or every build would show up as a diff and nobody could tell a real
 * change from noise. That is why there is no build timestamp in the banner.
 *
 * And the committed file must be current. web/tests/built-file.test.js rebuilds
 * and compares byte for byte, so a change to web/src that is not rebuilt fails
 * the suite rather than shipping a page that does not match its own sources.
 *
 *   node web/build.js            -> Mahjong-Tournament-System.html (repo root)
 *   node web/build.js --out DIR
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, 'src');
const DEFAULT_OUT = path.join(__dirname, '..');
const OUTPUT_NAME = 'Mahjong-Tournament-System.html';

// Order matters: each file leans on the ones before it via window.RT.
const SCRIPTS = [
  'rational.js', 'scoring.js', 'seating.js', 'store.js',
  'backup.js', 'persist.js', 'printing.js', 'discord.js', 'help.js',
  'testdata.js', 'tutorial.js', 'ui.js',
];

const version = () => {
  const pkg = path.join(__dirname, 'package.json');
  if (fs.existsSync(pkg)) return JSON.parse(fs.readFileSync(pkg, 'utf8')).version;
  return '0.0.0';
};

/** A closing tag inside a string literal would end the inlined block early. */
const safeForInline = (js) => js.replace(/<\/script/gi, '<\\/script');

/* ------------------------------------------------- making it navigable ---
 *
 * The built file is one 300 KB page, which is a lot to scroll through
 * looking for the bit that works out who won. So each inlined module gets a
 * labelled banner carrying a searchable marker, and the comment at the top of
 * the file lists them with the line each one starts on.
 *
 * The one-line description of each module is read from the first line of that
 * file's own opening comment, rather than kept in a table here, so the two
 * cannot drift apart.
 */

const MARKER = 'RT:FILE';

/* Modules worth a note of their own in the banner. */
const LANDMARKS = {
  'rational.js': 'Exact arithmetic. Every number in the program is built on this.',
  'scoring.js': 'THE SCORING. If you want to check how a result was worked out,\n'
    + ' * read this file. The formula is at the top of it.',
  'seating.js': 'The draw: who sits where, and the search that keeps opponents\n'
    + ' * from meeting twice.',
};

/* The files that decide a player's score. These get an arrow in the contents,
 * because they are what someone checking a disputed result needs to find. */
const ARITHMETIC = ['rational.js', 'scoring.js'];

/** The first line of a file's opening block comment, as its purpose. */
function purposeOf(code) {
  const m = code.match(/^\/\*+[ \t]*(\S.*?)[ \t]*$/m);
  const line = m ? m[1] : '';
  return line.length > 66 ? `${line.slice(0, 63)}...` : line;
}

/* The banner does not repeat the file's own description: that file's header
 * follows immediately below it, and the contents index at the top of the page
 * already lists it. */
function fileBanner(name) {
  const rule = '='.repeat(70);
  return `/* ${rule}\n * ${MARKER} ${name}\n`
    + (LANDMARKS[name] ? ` *\n * ${LANDMARKS[name]}\n` : '')
    + ` * ${rule} */`;
}

/* The contents block. Line numbers are filled in after the document is
 * assembled, by overwriting fixed-width placeholders, so inserting them
 * cannot shift the very lines they are pointing at. */
const LINE_SLOT = 'XXXXXX';

function contentsBlock(purposes) {
  const width = Math.max(...SCRIPTS.map((n) => n.length));
  const rows = SCRIPTS.map((name) => {
    const label = ARITHMETIC.includes(name) ? '  <-- the arithmetic' : '';
    return `    ${MARKER} ${name.padEnd(width)}  line ${LINE_SLOT}`
      + `  ${purposes[name]}${label}`;
  });
  return [
    '  WHAT IS IN HERE',
    '',
    `    This page is the whole program: ${SCRIPTS.length} source files inlined in the order`,
    '    below, each behind a banner you can search for. The guide to the code',
    '    is docs/CODE_MAP.md in the repository.',
    '',
    ...rows,
    '',
    '    To check how a score was worked out, read scoring.js: the formula is',
    '    written out at the top of it, and rational.js is the exact arithmetic',
    '    it stands on.',
  ].join('\n');
}

/** Fill the fixed-width line-number slots with where each marker really is. */
function numberContents(doc) {
  const lines = doc.split('\n');
  const at = new Map();
  lines.forEach((line, i) => {
    // The banner occurrence, not the contents row (which has the line slot).
    if (line.includes(`${MARKER} `) && !line.includes('line ')) {
      const name = line.split(`${MARKER} `)[1].trim();
      if (!at.has(name)) at.set(name, i + 1);
    }
  });
  return lines.map((line) => {
    if (!line.includes(`line ${LINE_SLOT}`)) return line;
    const name = line.split(`${MARKER} `)[1].split(/\s/)[0];
    const n = at.get(name);
    return line.replace(`line ${LINE_SLOT}`,
      () => `line ${String(n === undefined ? '?' : n).padStart(LINE_SLOT.length)}`);
  }).join('\n');
}

function build({ out = DEFAULT_OUT } = {}) {
  const html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(SRC, 'style.css'), 'utf8');

  const scriptBlock = SCRIPTS.map((name) => {
    const code = fs.readFileSync(path.join(SRC, name), 'utf8');
    return `<script>\n${fileBanner(name)}\n${safeForInline(code)}\n</script>`;
  }).join('\n');

  // The replacements MUST be functions, not strings. String.replace treats
  // "$$" in a string replacement as an escaped "$", "$&" as the whole match
  // and so on -- which silently rewrote `const $$ = ...` in ui.js to
  // `const $ = ...` and produced a page that would not load. A function
  // replacement is inserted verbatim.
  let result = html
    .replace(/<!--RT:STYLE-->[\s\S]*?<!--\/RT:STYLE-->/, () => `<style>\n${css}\n</style>`)
    .replace(/<!--RT:SCRIPTS-->[\s\S]*?<!--\/RT:SCRIPTS-->/, () => scriptBlock);

  const purposes = {};
  for (const name of SCRIPTS) {
    purposes[name] = purposeOf(fs.readFileSync(path.join(SRC, name), 'utf8'));
  }
  // No build date: this file is committed, so a timestamp would make every
  // build a diff. The commit that changed it is the date.
  const banner = `<!--\n  Mahjong Tournament System ${version()}\n`
    + '  One self-contained file: open it in a browser, no install, works offline.\n'
    + '  https://github.com/MilkJugg24/Mahjong-Tournament-System\n\n'
    + '  Generated from web/src by web/build.js. Editing this file by hand is\n'
    + '  wasted work: the next build overwrites it, and the test suite refuses a\n'
    + '  copy that does not match the sources.\n\n'
    + `${contentsBlock(purposes)}\n-->\n`;
  result = result.replace(/^<!doctype html>/i, () => `<!doctype html>\n${banner}`);

  // Tell the page its own version, so About can show it. Opened straight from
  // web/src it says "dev", which is accurate: it was not built.
  result = result.replace(
    /\/\* RT:VERSION \*\/window\.RT_VERSION = '[^']*';/,
    () => `/* RT:VERSION */window.RT_VERSION = '${version()}';`);
  result = numberContents(result);

  // Guard against the whole class of bug above: anything the sources declare
  // must survive into the build byte for byte.
  for (const name of SCRIPTS) {
    const code = fs.readFileSync(path.join(SRC, name), 'utf8');
    for (const decl of code.matchAll(/^\s*(?:const|let|var|class|function)\s+(\$+\w*|\w+)/gm)) {
      if (decl[1].includes('$') && !result.includes(decl[0].trim())) {
        throw new Error(
          `build mangled a declaration from ${name}: "${decl[0].trim()}" is not in the output. `
          + 'A "$" sequence was probably eaten by a string replacement.');
      }
    }
  }

  fs.mkdirSync(out, { recursive: true });
  const target = path.join(out, OUTPUT_NAME);
  fs.writeFileSync(target, result, 'utf8');
  return target;
}

/** Nothing may be left that the browser would have to go and fetch. */
function checkSelfContained(file) {
  const html = fs.readFileSync(file, 'utf8');
  const problems = [];

  const srcAttrs = [...html.matchAll(/<(script|img|iframe|video|audio)\b[^>]*\ssrc=["']([^"']+)["']/gi)];
  for (const [, tag, url] of srcAttrs) {
    if (!url.startsWith('data:')) problems.push(`<${tag} src="${url}">`);
  }
  const links = [...html.matchAll(/<link\b[^>]*\shref=["']([^"']+)["'][^>]*>/gi)];
  for (const [, url] of links) {
    if (!url.startsWith('data:')) problems.push(`<link href="${url}">`);
  }
  // Only the stylesheet: scanning the whole page would flag
  // URL.createObjectURL(blob) in the inlined JavaScript.
  for (const style of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    for (const m of style[1].matchAll(/url\(\s*["']?(?!data:)([^)"']+)["']?\s*\)/gi)) {
      problems.push(`css url(${m[1]})`);
    }
  }
  if (/\bimport\s+[^;]*\sfrom\s+["']/.test(html) || /<script[^>]+type=["']module/i.test(html)) {
    problems.push('an ES module, which file:// blocks');
  }
  return problems;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf('--out');
  const out = outIndex > -1 ? args[outIndex + 1] : DEFAULT_OUT;

  const target = build({ out });
  const problems = checkSelfContained(target);
  const kb = (fs.statSync(target).size / 1024).toFixed(0);

  if (problems.length) {
    console.error(`\nBUILD FAILED: ${target} still refers to things it would have to load:`);
    for (const p of problems) console.error(`  - ${p}`);
    console.error('\nA double-clicked file cannot fetch anything, so these must be inlined.');
    process.exit(1);
  }
  console.log(`Built ${target} (${kb} KB, self-contained)`);
}

module.exports = { build, checkSelfContained, SCRIPTS, OUTPUT_NAME };
