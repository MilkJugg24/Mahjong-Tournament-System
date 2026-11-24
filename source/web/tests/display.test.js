/* The room display: the clock's arithmetic, and what the projector shows. */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { TournamentStore } = require('../src/store.js');
const {
  clockReading, formatClock, clockNote, displayBody, displayShell,
} = require('../src/display.js');

const MIN = 60 * 1000;
const T0 = Date.parse('2026-11-24T09:30:00Z');
const running = (minutes = 90, elapsedMs = 0) =>
  ({ minutes, startedAt: new Date(T0).toISOString(), elapsedMs });

/* ------------------------------------------------------------- the clock */

test('an unstarted clock reads the full length', () => {
  const r = clockReading(null, T0, { defaultMinutes: 90 });
  assert.equal(r.remainingMs, 90 * MIN);
  assert.equal(r.started, false);
  assert.equal(formatClock(r.remainingMs), '90:00');
  assert.equal(clockNote(r), 'Not started');
});

test('a running clock counts down from when it started', () => {
  const r = clockReading(running(), T0 + 61 * MIN + 30 * 1000);
  assert.equal(formatClock(r.remainingMs), '28:30');
  assert.equal(r.running, true);
  assert.equal(r.lastCall, 60, 'the 60-minute call has passed');
});

test('time banked before a pause is kept', () => {
  const paused = { minutes: 90, startedAt: null, elapsedMs: 20 * MIN };
  assert.equal(formatClock(clockReading(paused, T0 + 99 * MIN).remainingMs), '70:00',
    'a paused clock does not move');
  assert.equal(clockNote(clockReading(paused, T0)), 'Paused');
  const resumed = { ...running(), elapsedMs: 20 * MIN };
  assert.equal(formatClock(clockReading(resumed, T0 + 10 * MIN).remainingMs), '60:00');
});

test('the last fifteen minutes warn, and time up says what happens', () => {
  assert.equal(clockReading(running(), T0 + 76 * MIN).warn, true);
  const up = clockReading(running(), T0 + 95 * MIN);
  assert.equal(up.over, true);
  assert.equal(formatClock(up.remainingMs), '0:00', 'never a negative time');
  assert.match(clockNote(up), /no new hands/);
});

/* ----------------------------------------------------------- the display */

function seatedStore() {
  const store = new TournamentStore();
  store.create('Display Cup', { config: { seating: { iterations: 500, restarts: 1 } } });
  store.addPlayersBulk(['<b>Zed</b>,A', 'Amy,B', 'Bo,C', 'Cy,D', 'Di,A'].join('\n'));
  const round = store.generateRound();
  return { store, round };
}

test('the seating is listed alphabetically, with each player\'s table', () => {
  const { store, round } = seatedStore();
  const html = displayBody({ tournament: store.doc, round, mode: 'seating' });
  const amy = html.indexOf('Amy');
  const cy = html.indexOf('Cy');
  assert.ok(amy > 0 && cy > amy, 'alphabetical');
  assert.match(html, /sitting out/, 'the bye is shown');
  assert.match(html, /&lt;b&gt;Zed&lt;\/b&gt;/, 'names are escaped');
  assert.doesNotMatch(html, /<b>Zed/);
});

test('the standings show the event\'s order', () => {
  const { store, round } = seatedStore();
  const t = round.tables[0];
  store.saveTable(round.id, t.tableNumber, t.seats.map((s, i) =>
    ({ playerId: s.playerId, rawScore: [45000, 32000, 25000, 18000][i] })));
  const html = displayBody({
    tournament: store.doc, round, standings: store.standings('overall'), mode: 'standings',
  });
  assert.match(html, /\+30\.0/);
  assert.match(html, /Standings/);
});

test('clock-only mode shows the clock and nothing else', () => {
  const { store, round } = seatedStore();
  const html = displayBody({
    tournament: store.doc, round, mode: 'clock', reading: clockReading(running(), T0 + MIN),
  });
  assert.match(html, /89:00/);
  assert.doesNotMatch(html, /Amy/);
});

test('between rounds the display says so rather than going blank', () => {
  const { store } = seatedStore();
  const html = displayBody({ tournament: store.doc, round: null, mode: 'seating' });
  assert.match(html, /Between rounds/);
  assert.match(html, /No round is open/);
});

test('the display window needs nothing from outside', () => {
  const html = displayShell('Display Cup');
  assert.doesNotMatch(html, /<script|<link|src=|https?:\/\//);
});
