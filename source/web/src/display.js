/* The room display: the round clock, and the seating or standings, for a projector.
 *
 * The organiser keeps the laptop for entering scores. This is the second
 * window, dragged onto the projector or a big screen, that the room reads:
 * where am I sitting, how long is left, how do the standings look.
 *
 * Everything here is pure. clockReading() turns a round's clock into numbers,
 * and the rest turn the tournament's state into HTML. ui.js owns the window:
 * it writes displayShell() once, puts displayBody() in it on every change, and
 * refreshes the clock every second.
 *
 * The clock is stored on the round as { minutes, startedAt, elapsedMs }:
 * startedAt is set while it runs, and elapsedMs holds the time banked by
 * earlier runs, so pausing and resuming lose nothing.
 */
(function () {
'use strict';

/* The ARA calls the time remaining at these minutes into a 90-minute hanchan. */
const CALLS = [30, 45, 60, 75];

/* When the clock turns amber: the last call before time, 15 minutes out. */
const WARN_MS = 15 * 60 * 1000;

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/** A round's clock as numbers, at `nowMs`. A missing clock reads as unstarted. */
function clockReading(clock, nowMs, { defaultMinutes = 90 } = {}) {
  const c = clock || { minutes: defaultMinutes, startedAt: null, elapsedMs: 0 };
  const durationMs = Math.max(0, Number(c.minutes) || 0) * 60000;
  const since = c.startedAt ? Math.max(0, nowMs - Date.parse(c.startedAt)) : 0;
  const elapsedMs = Math.max(0, Number(c.elapsedMs) || 0) + since;
  const remainingMs = durationMs - elapsedMs;
  const passed = CALLS.filter((m) => elapsedMs >= m * 60000);
  return {
    running: Boolean(c.startedAt),
    started: Boolean(c.startedAt) || elapsedMs > 0,
    durationMs,
    elapsedMs,
    remainingMs,
    over: durationMs > 0 && remainingMs <= 0,
    warn: remainingMs > 0 && remainingMs <= WARN_MS,
    lastCall: passed.length ? passed[passed.length - 1] : null,
  };
}

/** Milliseconds as m:ss, never negative: time up reads 0:00. */
function formatClock(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** The line under the clock: what to say to the room, if anything. */
function clockNote(reading) {
  if (!reading) return '';
  if (reading.over) return 'Time. Finish the hand in play; no new hands.';
  if (!reading.started) return 'Not started';
  if (!reading.running) return 'Paused';
  return '';
}

/** The clock's own markup: refreshed every second on its own. */
function clockHtml(reading) {
  if (!reading) return '';
  const cls = reading.over ? 'over' : (reading.warn ? 'warn' : '');
  const note = clockNote(reading);
  return `<div class="time ${cls}">${formatClock(reading.remainingMs)}</div>`
    + (note ? `<div class="note">${esc(note)}</div>` : '');
}

/** Everyone in a round, alphabetically, with where to sit: what a player looks for. */
function seatingBody(round) {
  const winds = ['East', 'South', 'West', 'North'];
  const rows = [];
  for (const table of round.tables) {
    for (const seat of table.seats) {
      if (!seat.name) continue;
      rows.push({
        name: seat.name,
        where: `${table.tableNumber}`,
        wind: winds[seat.seatIndex] || '',
        free: Boolean(table.freePlay),
      });
    }
  }
  for (const bye of round.byes || []) rows.push({ name: bye.name, where: '', wind: '', free: false });
  rows.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  const items = rows.map((r) => (r.where
    ? `<li><span class="nm">${esc(r.name)}</span><span class="at">${esc(r.where)}`
      + `<small>${esc(r.wind)}${r.free ? ' &middot; free play' : ''}</small></span></li>`
    : `<li class="out"><span class="nm">${esc(r.name)}</span><span class="at">`
      + '<small>sitting out</small></span></li>')).join('');
  return `<ul class="list seating">${items}</ul>`;
}

function standingsBody(standings, precision) {
  const fmt = (v) => {
    const n = Number(v);
    const s = n.toFixed(precision);
    return n > 0 ? `+${s}` : s;
  };
  const items = standings.map((s, i) => {
    const cut = s.stage === 'qualifying' && i > 0 && standings[i - 1].stage === 'final';
    return (cut ? '<li class="cutline">did not make the cut</li>' : '')
      + `<li><span class="rk">${s.rank}${s.needsCoinToss ? '*' : ''}</span>`
      + `<span class="nm">${esc(s.name)}</span>`
      + `<span class="sc">${esc(fmt(s.tournamentScore))}</span></li>`;
  }).join('');
  return `<ol class="list standings">${items}</ol>`;
}

/**
 * Everything in the window except its styles.
 *
 *   mode   'seating'   the clock, and where everyone sits this round
 *          'standings' the clock, and the event's standings
 *          'clock'     the clock alone, as large as it will go
 */
function displayBody({
  tournament, round = null, standings = [], reading = null, mode = 'seating', precision = 1,
}) {
  const title = round ? round.label : 'Between rounds';
  const clock = round ? `<div id="clock" class="clock">${clockHtml(reading)}</div>` : '';
  if (mode === 'clock') {
    return `<main class="only-clock"><h1>${esc(tournament.name)} &middot; ${esc(title)}</h1>`
      + `${clock || '<p class="idle">No round is open.</p>'}</main>`;
  }
  let content;
  if (mode === 'standings') {
    content = standings.length
      ? standingsBody(standings, precision)
      : '<p class="idle">Standings appear once a table has been scored.</p>';
  } else {
    content = round ? seatingBody(round) : '<p class="idle">No round is open.</p>';
  }
  const heading = mode === 'standings' ? 'Standings' : 'Find your seat';
  return `<header><div><h1>${esc(tournament.name)}</h1>`
    + `<h2>${esc(title)} &middot; ${heading}</h2></div>${clock}</header>`
    + `<main class="${esc(mode)}">${content}</main>`;
}

const CSS = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body { background: #0f1512; color: #f2f5f3; padding: 2.5vh 3vw;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
header { display: flex; justify-content: space-between; align-items: flex-start; gap: 3vw;
  border-bottom: 2px solid #2b3a33; padding-bottom: 1.5vh; margin-bottom: 2vh; }
h1 { margin: 0; font-size: 2.6vw; }
h2 { margin: .4vh 0 0; font-size: 1.8vw; font-weight: 500; color: #a9bcb2; }
.clock { text-align: right; }
.clock .time { font-size: 6vw; font-weight: 800; line-height: 1; font-variant-numeric: tabular-nums; }
.clock .time.warn { color: #f2c35b; }
.clock .time.over { color: #ff8a80; }
.clock .note { font-size: 1.4vw; color: #a9bcb2; margin-top: .6vh; }
.only-clock { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; }
.only-clock h1 { font-size: 2.4vw; color: #a9bcb2; font-weight: 500; }
.only-clock .clock { text-align: center; }
.only-clock .clock .time { font-size: 26vw; }
.only-clock .clock .note { font-size: 2.6vw; }
.list { list-style: none; margin: 0; padding: 0; columns: 18rem; column-gap: 3vw; }
.list li { display: flex; gap: 1vw; align-items: baseline; break-inside: avoid;
  padding: .45vh 0; border-bottom: 1px solid #1f2a25; font-size: 1.55vw; }
.list .nm { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.seating .at { font-weight: 800; font-variant-numeric: tabular-nums; white-space: nowrap; }
.seating .at small { font-weight: 400; color: #a9bcb2; margin-left: .6vw; font-size: .75em; }
.seating li.out .nm { color: #a9bcb2; }
.standings .rk { width: 2.6em; color: #a9bcb2; font-variant-numeric: tabular-nums; }
.standings .sc { font-weight: 700; font-variant-numeric: tabular-nums; }
.standings li.cutline { color: #a9bcb2; font-size: 1.1vw; border-bottom: 0; padding-top: 1.2vh; }
.idle { font-size: 2vw; color: #a9bcb2; }
`;

/** The window's document, written once. displayBody() fills its body. */
function displayShell(title) {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + `<title>${esc(title)} &middot; room display</title><style>${CSS}</style></head>`
    + '<body></body></html>';
}

const API = {
  CALLS, clockReading, formatClock, clockNote, clockHtml, displayBody, displayShell,
};

if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof window !== 'undefined') {
  window.RT = window.RT || {};
  window.RT.display = API;
}
}());
