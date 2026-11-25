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

/* The pie's filled arc and where it starts, as fractions of the whole circle. */
function pie(reading) {
  const { pieHtml } = require('../src/display.js');
  const svg = pieHtml(reading);
  const [, left, whole] = svg.match(/stroke-dasharray="([\d.]+) ([\d.]+)"/);
  const [, gone] = svg.match(/stroke-dashoffset="-([\d.]+)"/);
  return { left: Number(left) / Number(whole), gone: Number(gone) / Number(whole) };
}

test('the pie starts full', () => {
  const p = pie(clockReading(null, T0, { defaultMinutes: 90 }));
  assert.equal(p.left, 1);
  assert.equal(p.gone, 0);
});

test('the pie empties clockwise from twelve as time goes', () => {
  // Half gone: the filled half starts at six o'clock and runs round to twelve.
  const p = pie(clockReading(running(), T0 + 45 * MIN));
  assert.ok(Math.abs(p.left - 0.5) < 1e-3, `left ${p.left}`);
  assert.ok(Math.abs(p.gone - 0.5) < 1e-3, `gone ${p.gone}`);
});

test('the pie is empty when time is up, and never runs backwards', () => {
  const p = pie(clockReading(running(), T0 + 120 * MIN));
  assert.equal(p.left, 0);
  assert.equal(p.gone, 1);
});

test('the pie sits beside the countdown, in the clock\'s colour', () => {
  const { clockHtml } = require('../src/display.js');
  const html = clockHtml(clockReading(running(), T0 + 80 * MIN));
  assert.match(html, /<div class="clockline warn"><div class="time">[^]*?<\/div><svg class="pie"/);
});

test('each digit of the time has a cell of its own, so the time never changes width', () => {
  const { clockHtml } = require('../src/display.js');
  const html = clockHtml(clockReading(running(), T0 + 80 * MIN));
  const dg = (d) => `<span class="dg">${d}</span>`;
  assert.ok(html.includes(`<div class="time">${dg(1)}${dg(0)}:${dg(0)}${dg(0)}</div>`), html);
  assert.match(displayShell('Display Cup'), /\.time \.dg \{[^}]*width: 1ch/,
    'every cell as wide as a 0, whichever digit is in it');
});

test('the pie is centred on the digits, not on their line', () => {
  const css = displayShell('Display Cup');
  assert.match(css, /\.clockline \{[^}]*align-items: baseline/);
  assert.match(css, /\.pie \{ top: calc\(var\(--pie\) \/ 2 - 1\.6cap\); \}/,
    'half the pie, less half of digits 3.2em tall');
});

/* ----------------------------------------------------------- the display */

test('every view has the menu at the top, with its own view marked', () => {
  const { MODES } = require('../src/display.js');
  const { store, round } = seatedStore();
  for (const [mode] of MODES) {
    const html = displayBody({ tournament: store.doc, round, mode });
    assert.match(html, /^<details class="modepick">/, `${mode}: no menu`);
    for (const [m] of MODES) assert.match(html, new RegExp(`data-dmode="${m}"`));
    assert.match(html, new RegExp(`data-dmode="${mode}" class="on"`), `${mode} not marked`);
    assert.equal((html.match(/class="on"/g) || []).length, 1);
  }
});

function seatedStore() {
  const store = new TournamentStore();
  store.create('Display Cup', { config: { seating: { iterations: 500, restarts: 1 } } });
  store.addPlayersBulk(['<b>Zed</b>,A', 'Amy,B', 'Bo,C', 'Cy,D', 'Di,A'].join('\n'));
  const round = store.generateRound();
  return { store, round };
}

/* The tables' blocks, as [table number, [names in seat order]]. */
function tablesShown(html) {
  return [...html.matchAll(/<section class="tbl[^"]*"><h3>Table (\d+)[\s\S]*?<\/section>/g)]
    .map(([block, n]) => [Number(n),
      [...block.matchAll(/<span class="nm">([^<]*)<\/span>/g)].map((m) => m[1])]);
}

test('the seating is shown table by table, in seat order', () => {
  const { store, round } = seatedStore();
  const html = displayBody({ tournament: store.doc, round, mode: 'seating' });
  const shown = tablesShown(html);
  assert.deepEqual(shown.map(([n]) => n), round.tables.map((t) => t.tableNumber));
  const seated = round.tables[0].seats.map((s) => s.name
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
  assert.deepEqual(shown[0][1], seated, 'East, South, West, North');
});

test('players sitting out are listed under the tables', () => {
  const { store, round } = seatedStore();
  const html = displayBody({ tournament: store.doc, round, mode: 'seating' });
  assert.match(html, /Sitting out<\/span> /);
  assert.ok(html.indexOf('Sitting out') > html.lastIndexOf('</section>'), 'below the tables');
});

test('names are escaped', () => {
  const { store, round } = seatedStore();
  const html = displayBody({ tournament: store.doc, round, mode: 'seating' });
  assert.match(html, /&lt;b&gt;Zed&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<b>Zed/);
});

test('a sit-in at a table is marked as a sub', () => {
  const store = new TournamentStore();
  store.create('Sub Cup', { config: { seating: { iterations: 300, restarts: 1 } } });
  store.addPlayersBulk('Ann,A\nBob,B\nCat,C');
  const sam = store.addPlayer('Sam', { role: 'sit_in' });
  const round = store.generateRound();
  const html = displayBody({ tournament: store.doc, round, mode: 'seating' });
  assert.match(html, /<li class="sub">[^]*?<span class="nm">Sam<\/span><span class="tag">sub<\/span>/);
  assert.match(html, /class="legend"/, 'the tag is explained');
  assert.equal((html.match(/class="sub"/g) || []).length, 1, 'only the sit-in is marked');
  assert.ok(round.tables[0].seats.some((s) => s.playerId === sam.id && s.sitIn));
});

test('a stand-in for a withdrawn finalist is marked as a sub too', () => {
  const { store, round } = seatedStore();
  const standIn = round.tables[0].seats[2];
  const html = displayBody({
    tournament: store.doc,
    round: { ...round, substitutes: [{ playerId: standIn.playerId, name: standIn.name }] },
    mode: 'seating',
  });
  assert.equal((html.match(/class="sub"/g) || []).length, 1);
});

test('subs not playing this round are listed under the tables', () => {
  const { store, round } = seatedStore();
  const html = displayBody({
    tournament: store.doc, round, mode: 'seating', sitInsOut: [{ name: 'Sue' }],
  });
  assert.match(html, /Subs not playing<\/span> Sue/);
});

test('no sub, no legend', () => {
  const { store, round } = seatedStore();
  assert.doesNotMatch(displayBody({ tournament: store.doc, round, mode: 'seating' }),
    /class="legend"/);
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
  assert.equal(html.match(/<div class="time">(.*?)<\/div>/)[1].replace(/<[^>]+>/g, ''), '89:00');
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
