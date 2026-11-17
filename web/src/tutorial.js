/* The guided tutorial: a demo tournament that plays itself while the organiser
 * reads what is happening and steps with Next and Prev.
 *
 * Everything here drives the real store -- the real draw, the real scoring, the
 * real validation. Nothing is mocked up, so what the tutorial shows is what the
 * app actually does. That also means this file must not touch the DOM: the
 * engine is handed a context by ui.js and calls back into it, which lets the
 * whole walkthrough run start to finish in a test with no browser.
 *
 * Prev works by snapshot. Each completed step records the tournament as it then
 * stood, and going back restores it, so stepping backwards and forwards is
 * exact rather than approximate.
 */
(function () {
'use strict';

/* The rosters and scores come from testdata.js, which the Test mode controls
 * use too. One implementation of "plausible scores that add up", not two. */
const _td = (typeof require === 'function')
  ? require('./testdata.js')
  : window.RT.testdata;
const {
  SCORE_PATTERNS, patternFor, fillOpenRound, playRounds,
} = _td;

const DEMO_NAME = 'Tutorial — Demo Riichi Open';

/* Twelve players, four clubs, three full tables.
 *
 * Deliberately placeholder names rather than realistic ones. Demo data gets
 * copied, screenshotted and pasted into issues, and a realistic full name can
 * collide with a real person who never agreed to appear in anyone's software. */
const DEMO_PLAYERS = [
  'Player 01, Club A',
  'Player 02, Club B',
  'Player 03, Club C',
  'Player 04, Club D',
  'Player 05, Club A',
  'Player 06, Club B',
  'Player 07, Club C',
  'Player 08, Club D',
  'Player 09, Club A',
  'Player 10, Club B',
  'Player 11, Club C',
  'Player 12, Club D',
];

/* The deliberately wrong table used to show the total check: a single digit
 * slip in the thousands column, 18,800 read as 19,800, which is the mistake
 * people actually make. It comes to 121,000 instead of 120,000. */
const BAD_ENTRY = [45200, 31400, 24600, 19800];
const GOOD_LAST = 18800;

/* --------------------------------------------------------------- the steps */

/* Each step has an id, a title, the tab it wants shown, the words, and
 * optionally an action that moves the demo tournament on. Actions get
 * { store } and must be plain store calls -- no DOM.
 *
 * `target` is a CSS selector for the control the step is talking about. The
 * page lights it up and scrolls to it, so the reader is looking at the button
 * rather than hunting for it. It is a selector rather than an element because
 * this file never touches the DOM: ui.js resolves it after the view renders.
 * A target that is not on screen is skipped rather than throwing, since some
 * are drawn only once a round exists. */
const STEPS = [
  {
    id: 'welcome',
    title: 'A tournament, start to finish',
    view: 'home',
    body: `
      <p>This walks through a whole event -- twelve players, four hanchan, a cut to
        the top four and a final -- filling everything in as it goes, so you can
        watch what each part does before you rely on it.</p>
      <p>It builds a <b>separate demo tournament</b> called
        "Tutorial — Demo Riichi Open". Your real events are untouched, and nothing
        the tutorial does is written to your backup folder. You can stop at any
        point, and delete the demo afterwards from the Events tab.</p>
      <p>Press <b>Next</b> to begin.</p>`,
  },
  {
    id: 'create',
    title: 'Creating the tournament',
    view: 'setup',
    target: '#sPreset',
    body: `
      <p>The demo event now exists: <b>four hanchan</b>, a <b>cut to the top four</b>,
        and <b>one final hanchan</b>, scored under <b>WRC 2025</b> -- 30,000 start,
        uma +15/+5/-5/-15. That is what the ARA uses and what most events want.</p>
      <p>This is the rules page, which is where a new tournament lands. Every one
        of those numbers can be changed here, and you will not normally need to:
        the defaults are the ordinary ones.</p>
      <p>At the top is <b>Start from a published ruleset</b>. It fills this whole
        page in from WRC 2025, EMA RCR, Saikouisen or MCR, tells you which document
        the numbers came from, and changes nothing until you press Save. The "?"
        bubbles explain individual fields.</p>`,
    run: ({ store }) => {
      store.create(DEMO_NAME, {
        mode: 'in_person',
        rules: { startingPoints: 30000, goalPoints: 30000, uma: ['15', '5', '-5', '-15'] },
        config: {
          rulesetLabel: 'WRC 2025',
          plannedRounds: 4,
          demo: true,
          cut: { size: 4, rounds: 1, carry: 'reset' },
        },
      });
    },
  },
  {
    id: 'players',
    title: 'Adding the players',
    view: 'players',
    target: '#bulkText',
    show: { type: { target: '#bulkText', text: DEMO_PLAYERS.join('\n') } },
    body: `
      <p>Twelve players pasted in at once. The format is one per line, with a comma
        before the club:</p>
      <pre class="helpcode">Player 01, Club A
Player 02, Club B</pre>
      <p>The club matters because the draw keeps club-mates apart in the early
        rounds. Duplicate names are skipped, so pasting the same list twice does no
        harm.</p>
      <p>Note the line above the table: <b>twelve players, three tables, filling
        exactly</b>. If the field were thirteen, it would tell you one player sits
        each round, and rotate who.</p>`,
    run: ({ store }) => { store.addPlayersBulk(DEMO_PLAYERS.join('\n')); },
  },
  {
    id: 'draw',
    title: 'Drawing the seating',
    view: 'round',
    // The draw has already happened by the time this is read, so #genBtn is
    // gone. Point at what it produced.
    target: '#tableGrid',
    show: { fill: '.tcard' },
    body: `
      <p>One click drew round one. The draw avoids sitting the same two people
        together twice, evens out who sits East, moves players between tables, and
        keeps club-mates apart -- in that order of priority.</p>
      <p>At this size it is instant. With 100 players over 6 rounds it still finds a
        draw with no repeat opponents at all, in about a fifth of a second.</p>
      <p>You can re-draw as often as you like <b>until a score is entered</b>. After
        that the seats are fixed, because the results already refer to them.</p>
      <p>This is the point where you would print the seating lists and a report sheet
        for each table.</p>`,
    run: ({ store }) => { store.generateRound({ phase: 'qualifying', seed: 1001 }); },
  },
  {
    id: 'badscore',
    title: 'A table that does not add up',
    view: 'round',
    target: '.tcard[data-table="1"]',
    body: `
      <p>Here is the most important thing the app does for you. These four scores
        have been typed into table 1:</p>
      <pre class="helpcode">45,200 + 31,400 + 24,600 + 19,800 = 121,000</pre>
      <p>A table of four starting on 30,000 must come to <b>120,000</b>. This one is
        1,000 over, so somebody misread a score -- a single digit slipped in the
        thousands column. The app says so immediately, and <b>will not let the table
        be saved</b>:</p>
      <div id="tutorialPreview" class="tutorial-preview"></div>
      <p>That single check is what stops a mistyped score reaching the standings,
        where it would quietly change who won. Riichi sticks left on the table count
        towards the total too.</p>`,
    preview: 'bad',
  },
  {
    id: 'goodscore',
    title: 'Correcting it, and what you see before saving',
    view: 'round',
    target: '.tcard[data-table="1"]',
    body: `
      <p>The last score was 18,800, not 19,800. Now the table balances, and before
        committing anything you see exactly what it will do to the standings --
        placements, the uma for each place, and the hanchan score each player
        takes away:</p>
      <div id="tutorialPreview" class="tutorial-preview"></div>
      <p>With these settings the four hanchan scores add up to zero. That is the
        WRC 2025 formula: points minus the goal, divided by 1,000, plus the uma.</p>
      <p>In practice you would not even type the fourth number -- once three are in,
        the app offers the only value that can balance.</p>`,
    preview: 'good',
  },
  {
    id: 'saverest',
    title: 'The rest of the round',
    view: 'round',
    target: '#tableGrid',
    show: { fill: '.tcard' },
    body: `
      <p>Table 1 is saved, and the other two tables have been filled in as if their
        players had just handed in their sheets. Each table shows a tick once its
        result is in.</p>
      <p>A saved table can still be corrected while the round is open -- tap it and
        retype. Every version is kept in <code>results_log.csv</code>, so a
        correction never hides what was there before.</p>`,
    run: ({ store }) => {
      const open = store.openRound();
      const round = store.getRound(open.id);
      const table = round.tables.find((t) => t.tableNumber === 1);
      const seated = table.seats.filter((s) => s.playerId !== null);
      const good = [...BAD_ENTRY];
      good[good.length - 1] = GOOD_LAST;
      store.saveTable(open.id, 1, seated.map((s, i) => ({
        playerId: s.playerId,
        rawScore: good[i],
        chombo: 0,
        penaltyPoints: '0',
        penaltyNote: '',
      })), { enteredBy: 'tutorial' });
      fillOpenRound(store);
    },
  },
  {
    id: 'close',
    title: 'Closing the round',
    view: 'round',
    // The round is closed by now, so #closeBtn has gone and the draw panel is
    // back. That is what the step ends on.
    target: '#genBtn',
    show: { press: '#genBtn' },
    body: `
      <p>Closing a round locks it and writes a dated snapshot of everything to your
        backup folder. The next round can then be drawn.</p>
      <p>If you need to change a score afterwards you reopen the round first -- the
        app will not let a closed round be edited by accident, because by then the
        standings have been read off it and the sheets have gone up on the wall.</p>`,
    run: ({ store }) => {
      const open = store.openRound();
      if (open) store.closeRound(open.id);
    },
  },
  {
    id: 'standings',
    title: 'The standings',
    view: 'standings',
    target: '#standingsBody table.data thead',
    show: { fill: '#standingsBody table.data tbody tr' },
    body: `
      <p>One round in. The tournament score is the sum of each player's hanchan
        scores, and with these settings the whole column adds up to zero -- a useful
        thing to glance at, because it means no table has been entered wrongly.</p>
      <p>Ties are shown as shared places. If a tie still matters at the cut line, the
        app stops and asks you rather than picking a winner, because that is a
        tournament decision and the rules leave it to you.</p>`,
  },
  {
    id: 'rounds234',
    title: 'Rounds two, three and four',
    view: 'standings',
    target: '#standingsBody table.data tbody tr',
    show: { fill: '#standingsBody table.data tbody tr' },
    body: `
      <p>The remaining three qualifying hanchan have been drawn, played and closed --
        the part of the day that takes four hours.</p>
      <p>Each round was drawn fresh, avoiding opponents people had already met. Scroll
        the round history on the Run the round tab to see all four.</p>
      <p>With four hanchan done, the qualifying standings are final and it is time to
        cut.</p>`,
    run: ({ store }) => { playRounds(store, 3); },
  },
  {
    id: 'cut',
    title: 'Making the cut',
    view: 'finals',
    target: '#finalsBody .grid.three',
    show: { fill: '#finalsBody table.data tbody tr' },
    body: `
      <p>The top four have gone through to the final, starting from zero -- so the
        final table decides it. You could instead carry their full qualifying score
        over, or half of it; the "?" next to that setting explains the difference.</p>
      <p>Had two players been level across the cut line, the app would have refused to
        guess and asked you to settle it.</p>
      <p>Everyone who did not make the cut can keep playing unranked hanchan if you
        want the tables busy.</p>`,
    run: ({ store }) => { store.applyCut({ size: 4, rounds: 1, carry: 'reset' }); },
  },
  {
    id: 'final',
    title: 'The final',
    view: 'standings',
    target: '[data-scope="final"]',
    show: { fill: '#finalsBody table.data tbody tr' },
    body: `
      <p>The final hanchan has been drawn, played and closed, exactly like a
        qualifying round.</p>
      <p>The standings tabs keep the two phases apart: <b>Qualifying</b> is how the
        cut was decided and never changes afterwards, <b>Finals</b> is the final table
        alone, and <b>Overall</b> is everything together. Your winner is top of the
        finals table.</p>`,
    run: ({ store }) => { playRounds(store, 1, 'final'); },
  },
  {
    id: 'backups',
    title: 'The one thing to do before a real event',
    view: 'backups',
    target: '#backupsBody',
    body: `
      <p>Pick a backup folder, here, before the players arrive.</p>
      <p>While you work your event is held inside this browser. That survives reloads
        and crashes, but browser storage belongs to the browser, not to the file --
        <b>copying the HTML to another laptop does not take the tournament with
        it.</b> The files in your backup folder are the real record.</p>
      <p>Choose a folder inside OneDrive, Google Drive or Dropbox and every round is
        copied off this laptop automatically: no account, no setup, the sync app you
        already have does the work.</p>
      <p>This is also where every printable sheet lives, and where you would load
        <code>restore/tournament.json</code> to bring an event back on another
        machine.</p>`,
  },
  {
    id: 'done',
    title: 'That is the whole thing',
    view: 'home',
    target: '#tournamentList',
    body: `
      <p>You have seen an event run end to end: players in, seating drawn, scores
        checked and entered, a round closed, standings read, a cut made and a final
        played.</p>
      <p>The demo tournament is still in your Events list, named
        "Tutorial — Demo Riichi Open". Poke at it as much as you like -- re-enter
        scores, undo the cut, print the sheets -- and delete it when you are done.
        None of it was written to your backup folder.</p>
      <p>The <b>Help</b> button in the top right has all of this written out, plus
        what to do when something goes wrong mid-event. The "?" bubbles next to
        fields explain individual settings.</p>
      <p>Press <b>Finish</b> to close the tutorial.</p>`,
  },
];

/* ------------------------------------------------------------- the engine */

/** The deliberately-wrong and the corrected entry for the preview steps. */
function previewEntries(store, which) {
  const open = store.openRound();
  if (!open) return null;
  const round = store.getRound(open.id);
  const table = round.tables.find((t) => t.tableNumber === 1);
  if (!table) return null;
  const seated = table.seats.filter((s) => s.playerId !== null);
  const scores = [...BAD_ENTRY];
  if (which === 'good') scores[scores.length - 1] = GOOD_LAST;
  return {
    roundId: open.id,
    tableNumber: 1,
    entries: seated.map((s, i) => ({
      playerId: s.playerId,
      rawScore: scores[i],
      chombo: 0,
      penaltyPoints: '0',
      penaltyNote: '',
    })),
  };
}

/**
 * ctx = {
 *   store,                       the TournamentStore to drive
 *   onStep(info),                called after every move; info has the step,
 *                                index, total, and any preview result
 *   onStop(),                    called when the tutorial ends
 *   onError(err),                called if a step throws
 * }
 */
function createRunner(ctx) {
  const store = ctx.store;
  let index = -1;
  let active = false;
  // history[i] is the tournament as it stood once step i had been applied.
  const history = [];

  const clone = (doc) => (doc ? JSON.parse(JSON.stringify(doc)) : null);

  const restore = (doc) => {
    if (doc) store.load(clone(doc));
    else store.doc = null;
  };

  const announce = () => {
    const step = STEPS[index];
    let preview = null;
    if (step && step.preview) {
      const p = previewEntries(store, step.preview);
      if (p) {
        try {
          preview = store.previewTable(p.roundId, p.tableNumber, p.entries);
        } catch { preview = null; }
      }
    }
    if (ctx.onStep) {
      ctx.onStep({
        step, index, total: STEPS.length, preview,
        isFirst: index === 0,
        isLast: index === STEPS.length - 1,
      });
    }
  };

  const api = {
    isActive: () => active,
    index: () => index,
    total: STEPS.length,
    current: () => STEPS[index] || null,

    start() {
      active = true;
      index = -1;
      history.length = 0;
      return api.next();
    },

    next() {
      if (!active || index >= STEPS.length - 1) return false;
      const target = index + 1;
      const step = STEPS[target];
      if (step.run) {
        try {
          step.run({ store });
        } catch (err) {
          if (ctx.onError) ctx.onError(err);
          return false;
        }
      }
      index = target;
      history[index] = clone(store.doc);
      announce();
      return true;
    },

    prev() {
      if (!active || index <= 0) return false;
      index -= 1;
      restore(history[index]);
      announce();
      return true;
    },

    stop() {
      active = false;
      index = -1;
      history.length = 0;
      if (ctx.onStop) ctx.onStop();
    },
  };

  return api;
}

const API = {
  DEMO_NAME, DEMO_PLAYERS, SCORE_PATTERNS, BAD_ENTRY, GOOD_LAST, STEPS,
  createRunner, fillOpenRound, playRounds, patternFor, previewEntries,
};

if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof window !== 'undefined') {
  window.RT = window.RT || {};
  window.RT.tutorial = API;
}
}());
