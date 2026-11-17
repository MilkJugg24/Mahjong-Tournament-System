/* Printable page tests, ported from tests/test_printing.py. */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { TournamentStore } = require('../src/store.js');
const { printPage, esc, signed } = require('../src/printing.js');

const FAST = { seating: { iterations: 500, restarts: 1, timeBudget: 0.5 } };

function store(players = 8) {
  const s = new TournamentStore();
  s.create('Print Test Cup', { config: { ...FAST, venue: 'Community Hall' } });
  const lines = [];
  for (let i = 1; i <= players; i++) lines.push(`Player ${i},Club`);
  s.addPlayersBulk(lines.join('\n'));
  return s;
}

/* -------------------------------------------------------- number format */

test('signed values render with an explicit sign', () => {
  // Uma and oka are exact rationals. Python needed a helper here because
  // Fraction.__format__ only gained format-spec support in 3.13; the same
  // behaviour is pinned on this side.
  assert.deepEqual(['15', '5', '-5', '-15'].map(signed), ['+15', '+5', '-5', '-15']);
  assert.equal(signed('20'), '+20');
  assert.equal(signed('0.5'), '+0.5');
  assert.equal(signed('-6.5'), '-6.5');
});

test('escaping keeps player names out of the markup', () => {
  assert.equal(esc('<script>alert(1)</script>'),
    '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(esc('Smith & Co "quoted"'), 'Smith &amp; Co &quot;quoted&quot;');
});

/* ---------------------------------------------------------------- views */

test('the report sheet states the uma and the required total', () => {
  const s = store();
  s.generateRound();
  const html = printPage(s, 'scoresheets');
  assert.match(html, /\+15 \/ \+5 \/ -5 \/ -15/);
  assert.match(html, /120,000/);
  assert.match(html, /Riichi sticks left/);
  assert.match(html, /Referee signature/);
});

test('the report sheet shows oka when configured', () => {
  const s = store();
  s.update({ rules: { startingPoints: 25000, goalPoints: 30000 } });
  s.generateRound();
  const html = printPage(s, 'scoresheets');
  assert.match(html, /oka 20P/);
  assert.match(html, /100,000/);
});

test('one report sheet per table', () => {
  const s = store(12); // 3 tables
  s.generateRound();
  const html = printPage(s, 'scoresheets');
  // Count the table headings, not the words "report sheet" -- the page title
  // says "report sheets" and would be counted too.
  assert.equal((html.match(/<h2>Table /g) || []).length, 3);
  for (const n of [1, 2, 3]) assert.match(html, new RegExp(`<h2>Table ${n}</h2>`));
});

test('seating lists by table and by player', () => {
  const s = store();
  s.generateRound();
  const html = printPage(s, 'seating');
  assert.match(html, /By table/);
  assert.match(html, /By player/);
  assert.match(html, /Player 1/);
});

test('seating names who is sitting out', () => {
  const s = store(10); // 2 tables + 2 byes
  s.generateRound();
  const html = printPage(s, 'seating');
  assert.match(html, /Sitting out/);
});

test('the sign-in sheet lists everyone', () => {
  const s = store();
  const html = printPage(s, 'signin');
  for (let i = 1; i <= 8; i++) assert.match(html, new RegExp(`Player ${i}\\b`));
});

test('table cards render without a round', () => {
  assert.match(printPage(store(), 'tablecards'), /Table/);
});

test('standings render for each scope', () => {
  const s = store();
  const round = s.generateRound();
  for (const table of s.getRound(round.id).tables) {
    const seats = table.seats.filter((x) => x.playerId);
    s.saveTable(round.id, table.tableNumber,
      seats.map((x, i) => ({ playerId: x.playerId, rawScore: [45000, 32000, 25000, 18000][i] })));
  }
  s.closeRound(round.id);
  const html = printPage(s, 'standings', { scope: 'qualifying' });
  assert.match(html, /Qualifying standings/);
  assert.match(html, /Print Test Cup/);
});

test('the venue appears in the header', () => {
  assert.match(printPage(store(), 'signin'), /Community Hall/);
});

/* ---------------------------------------------------------------- guards */

test('an unknown view is rejected', () => {
  assert.throws(() => printPage(store(), 'nonsense'), /Unknown print view/);
});

test('seating needs a round', () => {
  assert.throws(() => printPage(store(), 'seating'), /No rounds have been seated/);
});

test('player names are escaped in every view', () => {
  const s = store();
  s.addPlayer('<script>alert(1)</script>');
  const html = printPage(s, 'signin');
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.match(html, /&lt;script&gt;/);
});
