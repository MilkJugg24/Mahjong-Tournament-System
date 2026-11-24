/* Printable pages.
 *
 * A port of mahjong/printing.py. In-person events run on paper: a seating list
 * for the door, a report sheet per table for the players to fill in and a
 * referee to sign, table numbers to stand on the tables, and a sign-in sheet.
 *
 * These are plain HTML pages styled for A4 and Letter, opened in a new window
 * so the browser's own print dialog does the rest.
 */
(function () {
'use strict';

/* eslint-disable no-undef */
const _scoring = (typeof require === 'function') ? require('./scoring.js') : window.RT.scoring;
const { SEAT_WINDS, SEAT_WIND_NAMES, ScoreRules } = _scoring;

const PRINT_KINDS = ['seating', 'scoresheets', 'standings', 'signin', 'tablecards'];

const CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  margin: 0; padding: 18mm 14mm; color: #111; background: #fff; font-size: 11pt;
}
h1 { font-size: 20pt; margin: 0 0 2mm; }
h2 { font-size: 14pt; margin: 0 0 3mm; }
.sub { color: #555; font-size: 10pt; margin: 0 0 8mm; }
table { border-collapse: collapse; width: 100%; margin-bottom: 6mm; }
th, td { border: 1px solid #999; padding: 2.2mm 2.6mm; text-align: left; vertical-align: middle; }
th { background: #f0f0f0; font-size: 9.5pt; text-transform: uppercase; letter-spacing: .04em; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
.wind { font-weight: 700; width: 8mm; text-align: center; }
.fill { height: 9mm; }
.sheet { page-break-after: always; break-after: page; }
.sheet:last-child { page-break-after: auto; break-after: auto; }
.tablenum { text-align: center; border: 4px solid #111; padding: 14mm 6mm;
  page-break-after: always; break-after: page; }
.tablenum .n { font-size: 150pt; font-weight: 800; line-height: .9; }
.tablenum .label { font-size: 16pt; letter-spacing: .3em; text-transform: uppercase; color: #444; }
.meta { display: flex; gap: 10mm; flex-wrap: wrap; font-size: 10pt; margin-bottom: 4mm; }
.meta div { border-bottom: 1px solid #999; min-width: 42mm; padding-bottom: 1mm; }
.rules { font-size: 9pt; color: #444; border-top: 1px solid #ccc; padding-top: 2mm; margin-top: 2mm; }
.sign { margin-top: 4mm; display: grid; grid-template-columns: 1fr 1fr; gap: 6mm; font-size: 9.5pt; }
.sign div { border-top: 1px solid #333; padding-top: 1.5mm; }
.toolbar { position: fixed; top: 8px; right: 8px; }
.toolbar button {
  font: inherit; padding: 6px 14px; border: 1px solid #333; background: #fff;
  border-radius: 6px; cursor: pointer;
}
.byes { font-size: 10pt; color: #333; }
.rank1 { font-weight: 700; }
@media print { .toolbar { display: none; } body { padding: 10mm; } }
`;

const esc = (value) => String(value === null || value === undefined ? '' : value)
  .replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

const commas = (n) => Number(n).toLocaleString('en-US');

/** Render a number plainly, with a sign, without assuming a format spec. */
function signed(value) {
  const text = typeof value === 'string' ? value : String(value);
  const n = Number(text);
  if (!Number.isFinite(n)) return text;
  const clean = Number.isInteger(n) ? String(n) : String(n);
  return clean.startsWith('-') ? clean : `+${clean}`;
}

function shell(title, body) {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + `<title>${esc(title)}</title><style>${CSS}</style></head><body>`
    + '<div class="toolbar"><button onclick="window.print()">Print</button></div>'
    + `${body}</body></html>`;
}

function header(tournament, subtitle) {
  const when = new Date().toISOString().replace('T', ' ').replace(/:\d\d\..*$/, ' UTC');
  const venue = (tournament.config || {}).venue || '';
  const bits = [subtitle];
  if (venue) bits.push(esc(venue));
  bits.push(`generated ${when}`);
  return `<h1>${esc(tournament.name)}</h1><p class="sub">${bits.join(' &middot; ')}</p>`;
}

function rulesLine(rules, tournament) {
  const label = (tournament.config || {}).rulesetLabel || '';
  const parts = [
    `start ${commas(rules.startingPoints)}`,
    `return ${commas(rules.goalPoints)}`,
    `uma ${rules.uma.map((u) => signed(u.toString())).join(' / ')}`,
  ];
  if (!rules.oka.isZero) parts.push(`oka ${rules.oka.toString()}P`);
  parts.push(`table must total ${commas(rules.tableTotal)}`);
  return `<p class="rules">${esc(label)} &mdash; ${parts.join(' &middot; ')}</p>`;
}

/* --------------------------------------------------------------- seating */

function seatingPage(tournament, round) {
  const rows = [];
  for (const table of round.tables) {
    for (const seat of table.seats) {
      rows.push('<tr>'
        + `<td class="num">${table.tableNumber}</td>`
        + `<td class="wind">${esc(SEAT_WINDS[seat.seatIndex] ?? '?')}</td>`
        + `<td>${esc(seat.name || '(empty seat)')}</td>`
        + `<td>${esc(seat.club)}</td>`
        + `<td>${esc(table.lobby || '')}</td>`
        + '</tr>');
    }
  }
  const byTable = '<table><thead><tr><th class="num">Table</th><th>Seat</th>'
    + '<th>Player</th><th>Club</th><th>Lobby</th></tr></thead><tbody>'
    + rows.join('') + '</tbody></table>';

  const lookup = [];
  for (const table of round.tables) {
    for (const seat of table.seats) {
      if (seat.name) lookup.push([seat.name, table.tableNumber, seat.seatIndex]);
    }
  }
  for (const bye of round.byes) lookup.push([bye.name, null, null]);
  lookup.sort((a, b) => a[0].toLowerCase().localeCompare(b[0].toLowerCase()));

  const alpha = lookup.map(([name, tableNumber, seatIndex]) => {
    const where = tableNumber === null
      ? 'Sitting out this hanchan'
      : `Table ${tableNumber}, ${SEAT_WIND_NAMES[SEAT_WINDS[seatIndex]]}`;
    return `<tr><td>${esc(name)}</td><td>${esc(where)}</td></tr>`;
  }).join('');
  const byName = '<h2>By player</h2><table><thead><tr><th>Player</th><th>Seat</th>'
    + `</tr></thead><tbody>${alpha}</tbody></table>`;

  const byes = round.byes.length
    ? `<p class="byes"><strong>Sitting out:</strong> ${round.byes.map((b) => esc(b.name)).join(', ')}</p>`
    : '';

  return '<div class="sheet">'
    + header(tournament, `${esc(round.label)} &mdash; seating`)
    + byes + '<h2>By table</h2>' + byTable
    + '</div><div class="sheet">'
    + header(tournament, `${esc(round.label)} &mdash; seating`)
    + byName + '</div>';
}

/* ---------------------------------------------------------- score sheets */

function scoreSheet(tournament, rules, round, table) {
  const rows = table.seats.map((seat) => '<tr>'
    + `<td class="wind">${esc(SEAT_WINDS[seat.seatIndex] ?? '?')}</td>`
    + `<td>${esc(seat.name || '')}</td>`
    + '<td class="fill"></td><td class="fill"></td><td class="fill"></td>'
    + '</tr>').join('');
  const lobby = table.lobby ? `<div>Lobby: ${esc(table.lobby)}</div>` : '';

  return '<div class="sheet">'
    + header(tournament, `${esc(round.label)} &mdash; report sheet`)
    + `<h2>Table ${table.tableNumber}</h2>`
    + `<div class="meta"><div>Round: ${esc(round.label)}</div>`
    + '<div>Start time:</div><div>End time:</div>' + lobby + '</div>'
    + '<table><thead><tr><th>Seat</th><th>Player</th><th>Final points</th>'
    + '<th>Place</th><th>Signature</th></tr></thead><tbody>'
    + rows
    + '</tbody><tfoot>'
    + '<tr><td colspan="2"><strong>Riichi sticks left on the table</strong>'
    + ' (&times; 1,000)</td><td class="fill"></td><td colspan="2"></td></tr>'
    + `<tr><td colspan="2"><strong>Total (must be ${commas(rules.tableTotal)})`
    + '</strong></td><td class="fill"></td><td colspan="2"></td></tr>'
    + '<tr><td colspan="2">Chombo / penalties</td>'
    + '<td class="fill" colspan="3"></td></tr>'
    + '</tfoot></table>'
    + '<div class="sign"><div>Players agree the scores above</div>'
    + '<div>Referee signature</div></div>'
    + rulesLine(rules, tournament)
    + '</div>';
}

/* ------------------------------------------------------------- standings */

function standingsPage(tournament, standings, players, scope, precision) {
  const clubs = new Map(players.map((p) => [p.id, p.club]));
  const rows = standings.map((s, i) => (
    s.stage === 'qualifying' && i > 0 && standings[i - 1].stage === 'final'
      ? '<tr><td colspan="9" style="border:0;padding-top:5mm;color:#555">'
        + 'Did not make the cut &mdash; placed by qualifying score</td></tr>'
      : '')
    + '<tr>'
    + `<td class="num${s.rank === 1 ? ' rank1' : ''}">${s.rank}${s.needsCoinToss ? '*' : ''}</td>`
    + `<td>${esc(s.name)}</td>`
    + `<td>${esc(clubs.get(s.playerId) || '')}</td>`
    + `<td class="num">${esc(s.tournamentScore.toFixed(precision))}</td>`
    + `<td class="num">${s.hanchanPlayed}</td>`
    + `<td class="num">${s.firsts}</td>`
    + `<td class="num">${s.fourths}</td>`
    + `<td class="num">${s.bestHanchan ? esc(s.bestHanchan.toFixed(precision)) : ''}</td>`
    + `<td class="num">${esc(s.penaltyTotal.toFixed(precision))}</td>`
    + '</tr>').join('');

  const note = standings.some((s) => s.needsCoinToss)
    ? '<p class="rules">* still tied after every tiebreaker &mdash; settle with a '
      + 'coin toss, then record it as a manual tiebreak.</p>'
    : '';
  const titles = {
    overall: 'Standings',
    qualifying: 'Qualifying standings',
    final: 'Final standings',
  };

  return '<div class="sheet">'
    + header(tournament, titles[scope] || 'Standings')
    + '<table><thead><tr><th class="num">#</th><th>Player</th><th>Club</th>'
    + '<th class="num">Score</th><th class="num">Hanchan</th>'
    + '<th class="num">1sts</th><th class="num">4ths</th>'
    + '<th class="num">Best</th><th class="num">Pen.</th>'
    + `</tr></thead><tbody>${rows}</tbody></table>${note}</div>`;
}

/* ---------------------------------------------------------- misc sheets */

function signinPage(tournament, players) {
  const rows = players.map((p, i) => '<tr>'
    + `<td class="num">${i + 1}</td><td>${esc(p.name)}</td><td>${esc(p.club)}</td>`
    + '<td class="fill"></td><td class="fill"></td></tr>').join('');
  return '<div class="sheet">'
    + header(tournament, 'Sign-in sheet')
    + '<table><thead><tr><th class="num">#</th><th>Player</th><th>Club</th>'
    + `<th>Signature</th><th>Notes</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function tableCardsPage(count) {
  const cards = [];
  for (let n = 1; n <= Math.max(1, count); n++) {
    cards.push('<div class="tablenum"><div class="label">Table</div>'
      + `<div class="n">${n}</div></div>`);
  }
  return cards.join('');
}

/* ------------------------------------------------------------------ entry */

/**
 * Build a printable page.
 * @param store  a TournamentStore with a tournament open
 * @param kind   one of PRINT_KINDS
 */
function printPage(store, kind, { roundId = null, scope = 'overall' } = {}) {
  if (!PRINT_KINDS.includes(kind)) {
    throw new Error(`Unknown print view ${kind}. Try one of: ${PRINT_KINDS.join(', ')}.`);
  }
  const tournament = store.doc;
  const rules = ScoreRules.fromJSON(tournament.rules);

  if (kind === 'standings') {
    return shell(`${tournament.name} standings`, standingsPage(
      tournament, store.standings(scope), store.listPlayers(), scope, rules.scorePrecision));
  }
  if (kind === 'signin') {
    return shell(`${tournament.name} sign-in`, signinPage(tournament, store.listPlayers()));
  }
  if (kind === 'tablecards') {
    const rounds = store.listRounds();
    let count = 0;
    for (const r of rounds) count = Math.max(count, r.tables.length);
    if (!count) {
      const active = store.listPlayers().filter((p) => p.status === 'active');
      count = Math.max(1, Math.floor(active.length / rules.playersPerTable));
    }
    return shell(`${tournament.name} table numbers`, tableCardsPage(count));
  }

  const rounds = store.listRounds();
  if (!rounds.length) throw new Error('No rounds have been seated yet.');
  const chosenId = roundId === null
    ? (rounds.find((r) => r.status !== 'complete') || rounds[rounds.length - 1]).id
    : roundId;
  const round = store.getRound(chosenId);

  if (kind === 'seating') {
    return shell(`${tournament.name} seating`, seatingPage(tournament, round));
  }
  return shell(`${tournament.name} report sheets`,
    round.tables.map((t) => scoreSheet(tournament, rules, round, t)).join(''));
}

/** Open a printable page in a new window. */
function openPrintWindow(html, title = 'Print') {
  const win = window.open('', '_blank');
  if (!win) {
    throw new Error('The browser blocked the print window. Allow pop-ups for this page.');
  }
  win.document.open();
  win.document.write(html);
  win.document.close();
  win.document.title = title;
  return win;
}

const API = { PRINT_KINDS, printPage, openPrintWindow, esc, signed };

if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof window !== 'undefined') {
  window.RT = window.RT || {};
  window.RT.printing = API;
}
}());
