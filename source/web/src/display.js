/* The room display: the round clock, and the seating or standings, for a projector.
 *
 * The organiser keeps the laptop for entering scores. This opens in a new tab,
 * dragged onto the projector or a big screen, or out into a window of its own,
 * and the room reads it: where am I sitting, how long is left, how do the
 * standings look.
 *
 * clockReading() turns a round's clock into numbers, and displayBody() turns
 * the tournament's state into HTML; both are pure. fitToScreen() is the one
 * function here that touches a page: it sets the text as large as the screen
 * allows. ui.js owns the tab: it writes displayShell() once, puts
 * displayBody() in it on every change, fits it, and refreshes the clock every
 * second.
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

const WINDS = ['E', 'S', 'W', 'N'];

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

/**
 * The time left as a disc that empties clockwise from twelve, as a clock hand
 * moves: a second way to read the clock at a glance, from anywhere in a room.
 *
 * One circle drawn with a stroke as wide as its own diameter fills the disc;
 * its dash is the time left, started where the elapsed time ends.
 */
function pieHtml(reading) {
  const frac = reading.durationMs > 0
    ? Math.max(0, Math.min(1, reading.remainingMs / reading.durationMs))
    : 0;
  const r = 7.5;
  const c = 2 * Math.PI * r;
  const left = (frac * c).toFixed(3);
  const gone = ((1 - frac) * c).toFixed(3);
  return '<svg class="pie" viewBox="0 0 32 32" aria-hidden="true">'
    + '<circle class="disc" cx="16" cy="16" r="15"/>'
    + `<circle class="left" cx="16" cy="16" r="${r}" stroke-width="15"`
    + ` stroke-dasharray="${left} ${c.toFixed(3)}" stroke-dashoffset="-${gone}"`
    + ' transform="rotate(-90 16 16)"/></svg>';
}

/** The clock's own markup: refreshed every second on its own. */
function clockHtml(reading) {
  if (!reading) return '';
  const cls = reading.over ? 'over' : (reading.warn ? 'warn' : '');
  const note = clockNote(reading);
  return `<div class="clockline ${cls}"><div class="time">${formatClock(reading.remainingMs)}</div>`
    + `${pieHtml(reading)}</div>`
    + (note ? `<div class="note">${esc(note)}</div>` : '');
}

const MODES = [['seating', 'Seating'], ['standings', 'Standings'], ['clock', 'Clock only']];

/**
 * A small tab at the top centre of the display that drops down the three
 * views, so the display can be switched from the display itself as well as
 * from the round page. It is quiet until pointed at, so it does not distract
 * the room. ui.js hears the choice.
 */
function modeMenu(mode) {
  return '<details class="modepick"><summary aria-label="Choose what the display shows">'
    + '&#9662;</summary><div class="menu">'
    + MODES.map(([m, label]) => `<button type="button" data-dmode="${m}"`
      + `${m === mode ? ' class="on" aria-current="true"' : ''}>${label}</button>`).join('')
    + '</div></details>';
}

/**
 * The round table by table, as the room is laid out, each in seat order.
 *
 * A sub -- a sit-in, or someone standing in for a withdrawn finalist -- is
 * shown in its own colour and tagged, so the table knows one of its four is
 * playing unranked. Underneath: who is sitting out, and which subs are free.
 */
function seatingBody(round, sitInsOut) {
  const standIns = new Set((round.substitutes || []).map((p) => p.playerId));
  let anySub = false;
  const blocks = round.tables.map((table) => {
    const seats = [...table.seats].sort((a, b) => a.seatIndex - b.seatIndex).map((seat) => {
      if (!seat.name) return '<li class="empty"><span class="w"></span><span class="nm">&mdash;</span></li>';
      const sub = Boolean(seat.sitIn) || standIns.has(seat.playerId);
      anySub = anySub || sub;
      return `<li${sub ? ' class="sub"' : ''}><span class="w">${WINDS[seat.seatIndex] || ''}</span>`
        + `<span class="nm">${esc(seat.name)}</span>${sub ? '<span class="tag">sub</span>' : ''}</li>`;
    }).join('');
    return `<section class="tbl${table.freePlay ? ' free' : ''}">`
      + `<h3>Table ${table.tableNumber}${table.freePlay ? ' <small>free play</small>' : ''}</h3>`
      + `<ol>${seats}</ol></section>`;
  }).join('');

  const byes = (round.byes || []).map((b) => esc(b.name));
  const idle = sitInsOut.map((p) => esc(p.name || p));
  const below = (byes.length ? `<p><span class="label">Sitting out</span> ${byes.join(', ')}</p>` : '')
    + (idle.length ? `<p class="subs"><span class="label">Subs not playing</span> ${idle.join(', ')}</p>` : '')
    + (anySub ? '<p class="legend"><span class="tag">sub</span> plays the seat, but is not ranked</p>' : '');
  return `<div class="tablegrid">${blocks}</div>${below ? `<div class="below">${below}</div>` : ''}`;
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
  return `<ol class="standings">${items}</ol>`;
}

/**
 * Everything in the tab except its styles.
 *
 *   mode       'seating'   the clock, and the round table by table
 *              'standings' the clock, and the event's standings
 *              'clock'     the clock alone, as large as it will go
 *   sitInsOut  sit-ins playing no seat this round, listed under the tables
 */
function displayBody({
  tournament, round = null, standings = [], reading = null, mode = 'seating',
  precision = 1, sitInsOut = [],
}) {
  const title = round ? round.label : 'Between rounds';
  const clock = round ? `<div id="clock" class="clock">${clockHtml(reading)}</div>` : '';
  if (mode === 'clock') {
    return modeMenu(mode)
      + `<main class="only-clock"><h1>${esc(tournament.name)} &middot; ${esc(title)}</h1>`
      + `${clock || '<p class="idle">No round is open.</p>'}</main>`;
  }
  let content;
  if (mode === 'standings') {
    content = standings.length
      ? standingsBody(standings, precision)
      : '<p class="idle">Standings appear once a table has been scored.</p>';
  } else {
    content = round ? seatingBody(round, sitInsOut) : '<p class="idle">No round is open.</p>';
  }
  const heading = mode === 'standings' ? 'Standings' : 'Seating';
  return modeMenu(mode) + `<header><div><h1>${esc(tournament.name)}</h1>`
    + `<h2>${esc(title)} &middot; ${heading}</h2></div>${clock}</header>`
    + `<main class="${esc(mode)}">${content}</main>`;
}

/* Every size is in em, from the one font size fitToScreen() sets on the page,
 * so the whole display grows and shrinks together. The clock-only view sizes
 * itself to the screen instead. */
const CSS = `
:root { color-scheme: dark; --muted: #a9bcb2; --line: #24312b; --sub: #7cc4ff; }
* { box-sizing: border-box; }
/* No scrollbars: nobody scrolls a projector, and one appearing while the text
   is being sized would narrow the page and throw the measurement. Hidden on
   the root only: the body still overflows, so the overflow can be measured. */
html { font-size: 2vw; overflow: hidden; }
html, body { margin: 0; height: 100%; }
body { background: #0f1512; color: #f2f5f3; padding: .9em 1.3em;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
header { display: flex; justify-content: space-between; align-items: flex-start; gap: 1.5em;
  border-bottom: 2px solid var(--line); padding-bottom: .5em; margin-bottom: .8em; }
h1 { margin: 0; font-size: 1.5em; line-height: 1.15; }
h2 { margin: .15em 0 0; font-size: 1.05em; font-weight: 500; color: var(--muted); }
.clock { text-align: right; }
.clockline { display: inline-flex; align-items: center; gap: .35em; }
.clockline.warn { color: #f2c35b; }
.clockline.over { color: #ff8a80; }
.clock .time { font-size: 3.2em; font-weight: 800; line-height: 1; font-variant-numeric: tabular-nums; }
.clock .note { font-size: .8em; color: var(--muted); margin-top: .25em; }
.pie { width: 2.5em; height: 2.5em; flex: none; }
.pie .disc { fill: rgba(255,255,255,.07); stroke: currentColor; stroke-opacity: .45; stroke-width: 1; }
.pie .left { fill: none; stroke: currentColor; }

.modepick { position: fixed; top: 0; left: 50%; transform: translateX(-50%); z-index: 5;
  text-align: center; font-size: .75em; }
.modepick summary { list-style: none; cursor: pointer; color: var(--muted); opacity: .35;
  padding: .05em 1.1em .2em; border: 1px solid var(--line); border-top: 0;
  border-radius: 0 0 .5em .5em; background: #131c18; transition: opacity .2s; }
.modepick summary::-webkit-details-marker { display: none; }
.modepick:hover summary, .modepick[open] summary, .modepick summary:focus-visible { opacity: 1; }
.modepick .menu { display: flex; flex-direction: column; gap: .2em; margin-top: .3em; padding: .35em;
  background: #131c18; border: 1px solid var(--line); border-radius: .5em; }
.modepick button { font: inherit; color: #f2f5f3; background: transparent; border: 0;
  border-radius: .35em; padding: .35em 1.2em; cursor: pointer; text-align: left; white-space: nowrap; }
.modepick button:hover { background: #1f2a25; }
.modepick button.on { background: #1f6f43; }

.tablegrid { display: grid; gap: .7em; grid-template-columns: repeat(auto-fill, minmax(10.5em, 1fr)); }
.tbl { border: 1px solid var(--line); border-radius: .4em; padding: .45em .6em .35em; background: #131c18; }
.tbl h3 { margin: 0 0 .2em; font-size: 1.05em; }
.tbl h3 small { font-weight: 400; font-size: .7em; color: var(--muted); }
.tbl.free { border-style: dashed; background: transparent; }
.tbl ol { list-style: none; margin: 0; padding: 0; }
.tbl li { display: flex; gap: .45em; align-items: baseline; padding: .08em 0; }
.tbl .w { width: 1.1em; flex: none; font-weight: 700; color: var(--muted); font-size: .85em; }
.tbl .nm { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tbl li.sub .nm { color: var(--sub); }
.tag { flex: none; font-size: .62em; font-weight: 700; text-transform: uppercase; letter-spacing: .06em;
  color: #0f1512; background: var(--sub); border-radius: .3em; padding: .1em .35em; }
.below { margin-top: .8em; display: grid; gap: .3em; }
.below p { margin: 0; }
.below .label { color: var(--muted); font-size: .8em; text-transform: uppercase; letter-spacing: .05em;
  margin-right: .5em; }
.below .subs { color: var(--sub); }
.below .legend { font-size: .75em; color: var(--muted); }
.below .legend .tag { margin-right: .4em; }

.standings { list-style: none; margin: 0; padding: 0; columns: 14em; column-gap: 1.6em; }
.standings li { display: flex; gap: .6em; align-items: baseline; break-inside: avoid;
  padding: .12em 0; border-bottom: 1px solid var(--line); }
.standings .rk { width: 2em; flex: none; color: var(--muted); font-variant-numeric: tabular-nums; }
.standings .nm { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.standings .sc { font-weight: 700; font-variant-numeric: tabular-nums; }
.standings li.cutline { color: var(--muted); font-size: .7em; border-bottom: 0; padding-top: .6em; }

.only-clock { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; }
.only-clock h1 { font-size: 2.4vw; color: var(--muted); font-weight: 500; }
.only-clock .clock { text-align: center; }
.only-clock .clock .time { font-size: 24vw; }
.only-clock .clockline { gap: 3vw; }
.only-clock .pie { width: 17vw; height: 17vw; }
.only-clock .clock .note { font-size: 2.6vw; }
.idle { font-size: 1.2em; color: var(--muted); }
`;

/** The tab's document, written once. displayBody() fills its body. */
function displayShell(title) {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + `<title>${esc(title)} &middot; room display</title><style>${CSS}</style></head>`
    + '<body></body></html>';
}

/**
 * Set the display's text as large as the screen allows, and no larger.
 *
 * A twelve-player event can be read from the back of the hall; a hundred
 * players still fit without scrolling, since nobody scrolls a projector.
 * Tries sizes by halving the range: the largest that leaves nothing off the
 * screen wins, down to a floor below which it would be unreadable anyway.
 */
function fitToScreen(win, { min = 11 } = {}) {
  const root = win && win.document && win.document.documentElement;
  if (!root || !win.innerWidth || !win.innerHeight) return null;
  const top = Math.max(min, Math.round(Math.min(win.innerWidth / 30, win.innerHeight / 14)));
  // Fits when everything in the body ends inside the screen. Measured from the
  // elements themselves, which a hidden overflow cannot hide.
  const fits = (px) => {
    root.style.fontSize = `${px}px`;
    let bottom = 0;
    let right = 0;
    for (const el of win.document.body.querySelectorAll('header, main, main *')) {
      const r = el.getBoundingClientRect();
      if (r.bottom > bottom) bottom = r.bottom;
      if (r.right > right) right = r.right;
    }
    return bottom <= win.innerHeight + 1 && right <= win.innerWidth + 1;
  };
  if (fits(top)) return top;
  let lo = min;
  let hi = top;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(mid)) lo = mid; else hi = mid;
  }
  // Columns reflow as the text changes, so a bigger size is not always a
  // taller page and the halving can land just wrong. Step down until it fits.
  while (lo > min && !fits(lo)) lo -= 1;
  fits(lo);
  return lo;
}

const API = {
  CALLS, MODES, clockReading, formatClock, clockNote, clockHtml, pieHtml, displayBody,
  displayShell, fitToScreen,
};

if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof window !== 'undefined') {
  window.RT = window.RT || {};
  window.RT.display = API;
}
}());
