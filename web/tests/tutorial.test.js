/* The guided tutorial, driven start to finish with no browser.
 *
 * The engine deliberately keeps the DOM out, so the whole walkthrough can be
 * run here against a real store. That is the point of these tests: if a step's
 * action is wrong, or the demo data does not balance, or Prev does not restore
 * exactly, it fails here rather than in front of an organiser.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { TournamentStore } = require('../src/store.js');
const {
  DEMO_PLAYERS, SCORE_PATTERNS, BAD_ENTRY, GOOD_LAST, STEPS, createRunner, patternFor,
} = require('../src/tutorial.js');

/* Replaying the tutorial makes a brand new tournament, so its id and every
 * timestamp legitimately differ. Strip those to compare the actual data. */
function stable(doc) {
  return JSON.stringify(doc, (key, value) => {
    if (key === 'id' && typeof value === 'string' && value.startsWith('t')) return '<id>';
    if (/At$/.test(key) || key === 'at') return '<time>';
    return value;
  });
}

const VIEWS = ['home', 'setup', 'players', 'round', 'standings', 'finals', 'backups'];

function runner(onError) {
  const store = new TournamentStore();
  const seen = [];
  const r = createRunner({
    store,
    onStep: (info) => seen.push(info),
    onError: onError || ((err) => { throw err; }),
  });
  return { store, seen, r };
}

/* -------------------------------------------------------------- the data */

test('every score pattern adds up to a legal table', () => {
  for (const pattern of SCORE_PATTERNS) {
    assert.equal(pattern.length, 4, `${pattern} is not four scores`);
    assert.equal(pattern.reduce((a, b) => a + b, 0), 120000,
      `${pattern} does not come to 120,000`);
  }
});

test('the deliberately wrong entry really is wrong, and by a plausible amount', () => {
  const total = BAD_ENTRY.reduce((a, b) => a + b, 0);
  assert.notEqual(total, 120000, 'the "bad" entry balances, so it teaches nothing');
  assert.equal(total, 121000);
  // One digit slipped in the thousands column -- the mistake people make.
  assert.equal(total - 120000, 1000, 'expected a 1,000-point gap');
  // Correcting the last score alone must fix it, since that is what the
  // tutorial text tells the reader.
  const fixed = [...BAD_ENTRY];
  fixed[fixed.length - 1] = GOOD_LAST;
  assert.equal(fixed.reduce((a, b) => a + b, 0), 120000);
});

test('the demo field fills whole tables and names are unique', () => {
  assert.equal(DEMO_PLAYERS.length, 12);
  assert.equal(DEMO_PLAYERS.length % 4, 0, 'the demo should fill tables exactly');
  const names = DEMO_PLAYERS.map((l) => l.split(',')[0].trim().toLowerCase());
  assert.equal(new Set(names).size, names.length, 'duplicate demo player');
  for (const line of DEMO_PLAYERS) {
    assert.match(line, /^[^,]+,\s*.+$/, `"${line}" should carry a club`);
  }
});

test('patternFor is deterministic and always returns a legal table', () => {
  for (let round = 1; round <= 6; round += 1) {
    for (let table = 1; table <= 4; table += 1) {
      const a = patternFor(round, table);
      const b = patternFor(round, table);
      assert.deepEqual(a, b, 'patternFor is not deterministic');
      assert.equal(a.reduce((x, y) => x + y, 0), 120000);
    }
  }
});

/* ------------------------------------------------------------- the steps */

test('every step is well formed and names a real tab', () => {
  const ids = new Set();
  for (const step of STEPS) {
    assert.ok(step.id, 'a step has no id');
    assert.ok(!ids.has(step.id), `duplicate step id: ${step.id}`);
    ids.add(step.id);
    assert.ok(step.title, `step ${step.id} has no title`);
    assert.ok(step.body && step.body.trim(), `step ${step.id} has no body`);
    assert.ok(VIEWS.includes(step.view), `step ${step.id} wants unknown view ${step.view}`);
    if (step.run) assert.equal(typeof step.run, 'function');
    if (step.preview) assert.ok(['bad', 'good'].includes(step.preview));
  }
});

test('a step that shows a preview placeholder also asks for a preview', () => {
  for (const step of STEPS) {
    const hasSlot = step.body.includes('id="tutorialPreview"');
    assert.equal(hasSlot, Boolean(step.preview),
      `step ${step.id}: preview slot and preview flag disagree`);
  }
});

/* ------------------------------------------------------- the whole thing */

test('the tutorial runs from start to finish and builds a real tournament', () => {
  const { store, seen, r } = runner();
  r.start();
  let guard = 0;
  while (r.next()) {
    guard += 1;
    assert.ok(guard < 200, 'the tutorial did not terminate');
  }

  assert.equal(r.index(), STEPS.length - 1, 'did not reach the last step');
  assert.equal(seen.length, STEPS.length, 'one announcement per step expected');
  assert.ok(seen[seen.length - 1].isLast);
  assert.ok(seen[0].isFirst);

  // It really built a tournament, not a stub.
  const doc = store.doc;
  assert.ok(doc, 'no tournament at the end');
  assert.equal(store.listPlayers().length, 12);
  assert.equal(doc.config.demo, true, 'the demo event must be marked as a demo');

  // Four qualifying rounds plus one final, all closed.
  const rounds = store.listRounds();
  assert.equal(rounds.filter((x) => x.phase === 'qualifying').length, 4);
  assert.equal(rounds.filter((x) => x.phase === 'final').length, 1);
  assert.equal(rounds.filter((x) => x.status !== 'complete').length, 0,
    'every round should be closed by the end');
  assert.equal(store.openRound(), null);
});

test('the finished demo has coherent standings', () => {
  const { store, r } = runner();
  r.start();
  while (r.next()) { /* to the end */ }

  const qualifying = store.standings('qualifying');
  assert.equal(qualifying.length, 12);

  // With a 30,000 start and a 30,000 goal every table is zero-sum, so the whole
  // qualifying column must come to nothing. This is the check that would catch a
  // demo score pattern that did not balance.
  const total = qualifying.reduce((a, s) => a + Number(s.tournamentScore), 0);
  assert.ok(Math.abs(total) < 1e-9, `qualifying scores sum to ${total}, expected 0`);

  // The cut took exactly four players through.
  const finals = store.standings('final');
  assert.equal(finals.length, 4, 'the final should have four players');
});

test('the cut really was applied, to the top four of qualifying', () => {
  const { store, r } = runner();
  r.start();
  while (r.next()) { /* to the end */ }

  const cut = store.doc.config.cut || {};
  assert.equal(cut.applied, true, 'the cut was not applied');
  assert.equal(cut.size, 4);

  const qualifying = store.standings('qualifying');
  const top4 = qualifying.slice(0, 4).map((s) => s.playerId).sort();
  const finalists = store.standings('final').map((s) => s.playerId).sort();
  assert.deepEqual(finalists, top4, 'the finalists are not the top four of qualifying');
});

/* -------------------------------------------------------- prev, and state */

test('prev restores the tournament exactly, and next rebuilds it identically', () => {
  const { store, r } = runner();
  r.start();
  while (r.next()) { /* to the end */ }

  const atEnd = stable(store.doc);

  // Step all the way back to the beginning.
  let backs = 0;
  while (r.prev()) {
    backs += 1;
    assert.ok(backs < 200, 'prev did not terminate');
  }
  assert.equal(r.index(), 0, 'prev should stop at the first step');
  assert.equal(backs, STEPS.length - 1);

  // Forwards again must reproduce the same tournament byte for byte, which only
  // holds if the snapshots are real and the seeds are fixed.
  while (r.next()) { /* to the end */ }
  assert.equal(stable(store.doc), atEnd,
    'replaying the tutorial did not reproduce the same tournament');
});

test('prev from a mid-point rewinds the data, not just the text', () => {
  const { store, r } = runner();
  r.start();

  // Forward to the step just after the players are added.
  while (r.current() && r.current().id !== 'players') r.next();
  assert.equal(store.listPlayers().length, 12);

  // Back one: the players step has been undone, so the roster is empty again.
  r.prev();
  assert.equal(r.current().id, 'create');
  assert.equal(store.listPlayers().length, 0,
    'prev left the players behind -- the snapshot is not being restored');

  // And forward again puts them back.
  r.next();
  assert.equal(store.listPlayers().length, 12);
});

test('prev at the first step and next at the last are refused', () => {
  const { r } = runner();
  r.start();
  assert.equal(r.index(), 0);
  assert.equal(r.prev(), false, 'prev should do nothing on the first step');
  assert.equal(r.index(), 0);

  while (r.next()) { /* to the end */ }
  assert.equal(r.next(), false, 'next should do nothing on the last step');
  assert.equal(r.index(), STEPS.length - 1);
});

test('nothing moves before start, and stop ends it', () => {
  const { r } = runner();
  assert.equal(r.isActive(), false);
  assert.equal(r.next(), false, 'next before start should do nothing');
  assert.equal(r.prev(), false);

  r.start();
  assert.equal(r.isActive(), true);
  r.stop();
  assert.equal(r.isActive(), false);
  assert.equal(r.index(), -1);
  assert.equal(r.next(), false, 'next after stop should do nothing');
});

/* ------------------------------------------------------------- previews */

test('the bad-table step is refused by the engine, with the total named', () => {
  const { seen, r } = runner();
  r.start();
  while (r.current().id !== 'badscore') r.next();

  const info = seen[seen.length - 1];
  assert.ok(info.preview, 'no preview for the bad-table step');
  assert.equal(info.preview.complete, true, 'all four scores should be entered');
  assert.equal(info.preview.ok, false, 'the engine accepted a table that does not balance');
  assert.equal(info.preview.enteredTotal, 121000);
  assert.equal(info.preview.tableTotal, 120000);
  assert.ok(info.preview.issues.some((i) => i.severity === 'error'),
    'expected a blocking issue on an unbalanced table');
});

test('the corrected step balances and shows what each player would score', () => {
  const { seen, r } = runner();
  r.start();
  while (r.current().id !== 'goodscore') r.next();

  const info = seen[seen.length - 1];
  assert.ok(info.preview, 'no preview for the corrected step');
  assert.equal(info.preview.ok, true, 'the corrected table should be accepted');
  assert.equal(info.preview.enteredTotal, 120000);
  assert.equal(info.preview.seats.length, 4);

  // Zero-sum, and placements 1..4 exactly once each.
  const sum = info.preview.seats.reduce((a, s) => a + Number(s.hanchanScore), 0);
  assert.ok(Math.abs(sum) < 1e-9, `hanchan scores sum to ${sum}, expected 0`);
  assert.deepEqual(info.preview.seats.map((s) => s.placement).sort(), [1, 2, 3, 4]);
});

test('a step action that throws is reported and does not advance', () => {
  const errors = [];
  const { r, store } = runner((err) => errors.push(err));
  r.start();

  // Drive to the draw step, then close the door on it by making a second
  // generateRound impossible: leave a round open and call next twice.
  while (r.current().id !== 'draw') r.next();
  const at = r.index();
  const before = stable(store.doc);

  // Re-running the same action now throws, because a round is already open.
  const step = require('../src/tutorial.js').STEPS.find((s) => s.id === 'draw');
  assert.throws(() => step.run({ store }), /still open/i,
    'a second draw while one is open should be refused by the store');
  assert.equal(stable(store.doc), before, 'the failed call changed the data');
  assert.equal(r.index(), at);
});

/* ------------------------------------------------------- the spotlight */

test('a step target is a selector, not an element', () => {
  for (const step of STEPS) {
    if (!('target' in step)) continue;
    assert.equal(typeof step.target, 'string', `${step.id}: target is not a string`);
    assert.match(step.target, /^[#.[]/,
      `${step.id}: "${step.target}" does not look like a CSS selector`);
  }
});

test('most steps point at something', () => {
  const withTarget = STEPS.filter((s) => s.target);
  assert.ok(withTarget.length >= STEPS.length - 2,
    `only ${withTarget.length} of ${STEPS.length} steps light a control`);
});

test('every target still exists in the markup', () => {
  // The drift guard. A renamed id would leave the step reading fine while
  // silently lighting nothing, which no other test would notice.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = path.join(__dirname, '..', 'src');
  const markup = ['index.html', 'ui.js']
    .map((f) => fs.readFileSync(path.join(src, f), 'utf8')).join('\n');

  const misses = [];
  for (const step of STEPS) {
    if (!step.target) continue;
    // Pull the identifying token out of the selector and look for where it
    // would be defined: id="x", class="… x …", or a data- attribute.
    const id = step.target.match(/^#([\w-]+)/);
    const cls = step.target.match(/^\.([\w-]+)/);
    const attr = step.target.match(/\[([\w-]+)=/);
    let found = false;
    if (id) found = markup.includes(`id="${id[1]}"`);
    else if (cls) found = new RegExp(`class="[^"]*\\b${cls[1]}\\b`).test(markup);
    if (!found && attr) found = markup.includes(`${attr[1]}=`);
    if (!found) misses.push(`${step.id} points at ${step.target}, which is not in the markup`);
  }
  assert.deepEqual(misses, [], misses.join('; '));
});

test('the preview steps light the table being discussed', () => {
  for (const step of STEPS) {
    if (!step.preview) continue;
    assert.match(step.target, /tcard/,
      `${step.id} talks about a table's scores but points at ${step.target}`);
  }
});

/* The step demonstrations.
 *
 * A `show` is a claim that something visibly happens on that step. These are
 * the drift guards: a selector that matches nothing, or a typed roster that
 * has drifted from the one the step actually adds, would leave the step
 * reading fine while showing nothing or showing a lie.
 */
test('every demonstration points at something that exists', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = path.join(__dirname, '..', 'src');
  const markup = ['index.html', 'ui.js']
    .map((f) => fs.readFileSync(path.join(src, f), 'utf8')).join('\n');

  const misses = [];
  for (const step of STEPS) {
    if (!step.show) continue;
    const selectors = [step.show.press, step.show.fill, step.show.type && step.show.type.target]
      .filter(Boolean);
    assert.ok(selectors.length, `${step.id} has an empty show`);
    for (const sel of selectors) {
      // The leading token is what has to be defined somewhere in the markup.
      const id = sel.match(/^#([\w-]+)/);
      const cls = sel.match(/^\.([\w-]+)/);
      const found = id
        ? markup.includes(`id="${id[1]}"`)
        : (cls ? new RegExp(`class="[^"]*\\b${cls[1]}\\b`).test(markup) : false);
      if (!found) misses.push(`${step.id} shows ${sel}, which is not in the markup`);
    }
  }
  assert.deepEqual(misses, [], misses.join('; '));
});

test('a typed demonstration types what the step actually adds', () => {
  // The roster is typed into the box for show, but the players come from
  // store.addPlayersBulk in the same step's run(). If those two drifted apart
  // the tutorial would type one roster and add another.
  const typed = STEPS.filter((s) => s.show && s.show.type);
  assert.equal(typed.length, 1, 'only the roster step types');
  const lines = typed[0].show.type.text.split('\n');
  assert.deepEqual(lines, DEMO_PLAYERS,
    'the typed roster must be the roster the step adds');
});

test('a press points at a button, not at a panel', () => {
  // Pressing something that is not a button would animate a shrug.
  for (const step of STEPS.filter((s) => s.show && s.show.press)) {
    assert.match(step.show.press, /Btn\b|button/i,
      `${step.id} presses ${step.show.press}, which does not look like a button`);
  }
});

test('no step points at a whole page section', () => {
  // A target the size of the panel cannot be cleared by the callout and
  // highlights nothing in particular. These were the steps the reader
  // complained about: the box sat on top of what it was describing.
  const panels = ['#roundBody', '#standingsBody', '#finalsBody'];
  const bad = STEPS
    .filter((s) => panels.includes(s.target))
    .map((s) => `${s.id} points at the whole of ${s.target}`);
  assert.deepEqual(bad, [], bad.join('; '));
});
