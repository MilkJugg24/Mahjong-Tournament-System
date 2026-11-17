/* Made-up rosters and made-up scores, for trying the program out.
 *
 * A test tournament is one an organiser creates with Test mode ticked. It is
 * marked `config.demo` in the document, which is the same flag the tutorial's
 * demo event carries. It keeps CSVs out of the organiser's backup folder.
 * Discord posting is deliberately NOT blocked — rehearsing it is the point of
 * test mode — but those posts are coloured and labelled as a test.
 * One flag, one meaning -- this is not a real tournament.
 *
 * Names are deliberately Player1 and Club1 rather than anything that reads
 * like a person. Test rosters get screenshotted into issues and pasted into
 * chat, and a realistic name is a liability however it was invented.
 *
 * ---------------------------------------------------------------------------
 * START HERE.
 *
 *   testRoster()    lines for the paste box: players, clubs, and sit-ins
 *   patternFor()    one table's worth of scores, deterministic
 *   fillOpenRound() every unscored table in the open round, filled
 *
 * All pure store calls, so the whole lot is testable without a browser. The
 * tutorial uses the same two score functions, so there is one implementation
 * of "plausible scores that add up" rather than two that can drift.
 * ---------------------------------------------------------------------------
 */
(function () {
'use strict';

/* Finishing scores that each come to 120,000, which is what a table of four
 * starting on 30,000 must total. A test is checked against that. */
const SCORE_PATTERNS = [
  [45200, 31400, 24600, 18800],
  [38100, 33200, 28700, 20000],
  [52300, 29100, 21500, 17100],
  [41700, 30800, 26900, 20600],
  [36400, 34500, 27200, 21900],
  [48600, 27300, 25400, 18700],
  [33900, 32100, 29800, 24200],
  [44100, 28600, 24800, 22500],
];

/** Scores for one table, chosen so the same table always gets the same ones. */
function patternFor(roundNumber, tableNumber) {
  const i = (roundNumber * 3 + tableNumber) % SCORE_PATTERNS.length;
  return SCORE_PATTERNS[i];
}

/**
 * Lines for the paste box: `Player1, Club1` and so on.
 *
 * Clubs cycle so club-mates are spread through the field, which is what makes
 * the draw's club separation visible. Sit-ins are named Sub1 upward and marked
 * so the roster box files them as sit-in rather than ranked.
 */
function testRoster(count = 16, { clubs = 4, subs = 0, startAt = 1 } = {}) {
  const n = Math.max(0, Math.floor(count));
  const clubCount = Math.max(1, Math.floor(clubs));
  const lines = [];
  for (let i = 0; i < n; i += 1) {
    const num = startAt + i;
    lines.push(`Player${num}, Club${(i % clubCount) + 1}`);
  }
  for (let i = 0; i < Math.max(0, Math.floor(subs)); i += 1) {
    lines.push(`Sub${i + 1}, Club${(i % clubCount) + 1}`);
  }
  return lines;
}

/** Which of those lines are sit-ins rather than ranked players. */
const isSubName = (name) => /^Sub\d+$/.test(String(name).trim());

/**
 * Fill every table in the open round that has no result yet.
 *
 * Returns how many tables were filled, so a caller can say so rather than
 * leaving the organiser wondering whether anything happened.
 */
function fillOpenRound(store, { skipTable = null } = {}) {
  const open = store.openRound();
  if (!open) return 0;
  const round = store.getRound(open.id);
  let filled = 0;
  for (const table of round.tables) {
    if (table.outcome) continue;
    if (skipTable !== null && table.tableNumber === skipTable) continue;
    const seated = table.seats.filter((s) => s.playerId !== null && s.playerId !== undefined);
    if (!seated.length) continue;
    const pattern = patternFor(round.number, table.tableNumber);
    store.saveTable(open.id, table.tableNumber, seated.map((s, i) => ({
      playerId: s.playerId,
      rawScore: pattern[i % pattern.length],
      chombo: 0,
      penaltyPoints: '0',
      penaltyNote: '',
    })), { enteredBy: 'test data' });
    filled += 1;
  }
  return filled;
}

/** Draw, fill and close whole rounds. */
function playRounds(store, count, phase = 'qualifying') {
  for (let i = 0; i < count; i += 1) {
    if (!store.openRound()) store.generateRound({ phase, seed: 1000 + i });
    fillOpenRound(store);
    const open = store.openRound();
    if (open) store.closeRound(open.id);
  }
}

const API = {
  SCORE_PATTERNS, patternFor, testRoster, isSubName, fillOpenRound, playRounds,
};

if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof window !== 'undefined') {
  window.RT = window.RT || {};
  window.RT.testdata = API;
}
}());
