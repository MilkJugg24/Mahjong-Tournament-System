#!/usr/bin/env node
/* Flags the habits that make documentation read as machine-written.
 *
 *   node tools/prose-check.js README.md docs/*.md
 *
 * No dependencies. Nothing here is a rule of grammar -- every one of these is
 * fine once. They are flagged because doing them *repeatedly* is the thing
 * readers notice, so the counts matter more than the individual hits.
 *
 * This is not a substitute for Vale, which checks real style guides. It
 * catches a different and narrower thing: the shape of the prose.
 */
'use strict';

const fs = require('node:fs');

/* Paragraphs that open with a bolded claim and then explain it:
 *     **Backups you never have to remember.** Every change is written...
 * One is a nice emphasis. Six in a row is a format, and it reads as filler
 * because every paragraph announces its own conclusion before making it. */
function boldLeadIns(text) {
  // Not under a FAQ or troubleshooting heading. There a bolded question or
  // symptom IS the format, and a good one: it is the line the reader scans
  // for, phrased the way they would search for it. Flagging those would push
  // the writing in the wrong direction.
  const sections = text.split(/^##+\s+/m);
  const prose = sections
    .filter((s) => !/^(questions?|faq|frequently|troubleshoot|problems|help)\b/i.test(s))
    .join('\n');
  return [...prose.matchAll(/^\*\*[^*\n]{8,90}?\.\*\*\s/gm)];
}

/* A link whose sentence carries on after it:
 *     **[Download the thing](url)** and double-click it.
 * The reader's eye lands on the link, clicks, and never reads the rest. Put
 * the instruction before the link, or make the link the whole sentence. */
function trailingSentenceLinks(text) {
  return [...text.matchAll(/\[[^\]]+\]\([^)]+\)\*{0,2}\s+(and|then|to|which|so)\s+\S/g)];
}

/* A heading and the link under it saying the same word:
 *     ### 1. Download it
 *     **[Download mahjong-tournament.html](...)**
 * Saying it twice does not make it clearer, it makes the reader wonder
 * whether the two are different things. */
function headingEchoesLink(text) {
  const out = [];
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    const heading = line.match(/^#{2,4}\s+(?:\d+\.\s*)?(\w+)/);
    if (!heading) return;
    const word = heading[1].toLowerCase();
    const next = lines.slice(i + 1, i + 4).join(' ');
    const link = next.match(/\[([^\]]+)\]/);
    if (link && link[1].toLowerCase().includes(word) && word.length > 3) {
      out.push({ line: i + 1, text: `"${heading[1]}" repeated in the link below it` });
    }
  });
  return out;
}

/* Telling the reader not to worry. Usually the sentence can just go: the
 * absence of an install step is evident from there being no install step. */
const REASSURANCE = [
  /\bnothing to (install|set ?up|configure|worry)/gi,
  /\bno (sign-?up|account|install|setup|configuration) (needed|required)/gi,
  /\bdon'?t worry\b/gi,
  /\bthat is the whole thing\b/gi,
  /\bthat'?s all there is to it\b/gi,
  /\byou (don'?t|do not) (need|have) to\b/gi,
];

/* "Not a video or a tour of empty screens -- it fills in a demo tournament."
 * Defining a thing by what it is not, then pivoting. Fine once; a tic in
 * quantity, and it spends a sentence on something the reader never thought. */
function negativePivots(text) {
  return [...text.matchAll(/\b(not|rather than|instead of)\b[^.!?\n]{0,70}[—–-]{1,2}\s/gi)];
}

function analyse(file) {
  const text = fs.readFileSync(file, 'utf8');
  // Don't count code blocks: they are not prose.
  const prose = text.replace(/```[\s\S]*?```/g, '').replace(/^\s{4,}\S.*$/gm, '');
  const words = prose.split(/\s+/).filter(Boolean).length;
  const per100 = (n) => (words ? (n * 100) / words : 0);

  const emDashes = (prose.match(/—/g) || []).length;
  const bold = boldLeadIns(prose);
  const links = trailingSentenceLinks(prose);
  const echoes = headingEchoesLink(prose);
  const pivots = negativePivots(prose);
  const reassure = REASSURANCE.flatMap((re) => [...prose.matchAll(re)]);

  const findings = [];
  const flag = (cond, label, detail) => { if (cond) findings.push({ label, detail }); };

  flag(per100(emDashes) > 0.8, 'em-dashes',
    `${emDashes} in ${words} words (${per100(emDashes).toFixed(1)} per 100). `
    + 'Most can be a full stop or a comma.');
  flag(bold.length > 2, 'bolded lead-ins',
    `${bold.length} paragraphs open "**Claim.** explanation": `
    + bold.slice(0, 3).map((m) => `"${m[0].trim().slice(0, 42)}…"`).join(', '));
  flag(links.length > 0, 'link mid-sentence',
    `${links.length}: the sentence carries on after the link, so the reader `
    + 'clicks before finishing it.');
  flag(echoes.length > 0, 'heading repeats its link',
    echoes.map((e) => `line ${e.line}: ${e.text}`).join('; '));
  flag(reassure.length > 1, 'reassurance',
    `${reassure.length}: ${[...new Set(reassure.map((m) => `"${m[0]}"`))].slice(0, 3).join(', ')}. `
    + 'Usually the sentence can just go.');
  flag(pivots.length > 1, 'negative pivots',
    `${pivots.length}: ${pivots.slice(0, 2).map((m) => `"${m[0].trim().slice(0, 40)}…"`).join(', ')}`);

  return { file, words, findings };
}

const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: node tools/prose-check.js <file.md> [more.md ...]');
  process.exit(2);
}

let total = 0;
for (const file of files) {
  const { words, findings } = analyse(file);
  console.log(`\n${file}  (${words} words)`);
  if (!findings.length) {
    console.log('  nothing flagged');
    continue;
  }
  for (const f of findings) {
    console.log(`  ${f.label}`);
    console.log(`      ${f.detail}`);
  }
  total += findings.length;
}
console.log(`\n${total} habit(s) flagged across ${files.length} file(s).`);
console.log('None of these is a rule. They are worth a second look, not an edit.');
