/* Generated rosters and scores.
 *
 * These exist so an organiser can try the program without inventing a field
 * by hand. The names are deliberately Player1 and Club1 rather than anything
 * that reads like a person: test rosters end up in screenshots and issues.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { TournamentStore } = require('../src/store.js');
const {
  SCORE_PATTERNS, patternFor, testRoster, isSubName, fillOpenRound, playRounds,
} = require('../src/testdata.js');

const FAST = { seating: { iterations: 1500, restarts: 1, timeBudget: 0.8 } };

/* ---------------------------------------------------------- the roster */

test('a roster is numbered players in numbered clubs', () => {
  const lines = testRoster(8, { clubs: 4 });
  assert.equal(lines.length, 8);
  assert.equal(lines[0], 'Player1, Club1');
  assert.equal(lines[3], 'Player4, Club4');
  assert.equal(lines[4], 'Player5, Club1', 'clubs should cycle');
});

test('no generated name could be mistaken for a person', () => {
  for (const line of testRoster(30, { clubs: 5, subs: 4 })) {
    const [name, club] = line.split(',').map((x) => x.trim());
    assert.match(name, /^(Player|Sub)\d+$/, `"${name}" does not announce itself as test data`);
    assert.match(club, /^Club\d+$/, `"${club}" does not announce itself as test data`);
  }
});

test('sit-ins are generated and recognisable', () => {
  const lines = testRoster(4, { subs: 3 });
  assert.equal(lines.length, 7);
  const subs = lines.slice(4).map((l) => l.split(',')[0]);
  assert.deepEqual(subs, ['Sub1', 'Sub2', 'Sub3']);
  for (const s of subs) assert.ok(isSubName(s), `${s} not recognised as a sit-in`);
  for (const p of ['Player1', 'Player12', 'Substitute', 'Sub', 'subzero']) {
    assert.ok(!isSubName(p), `${p} should not be read as a sit-in`);
  }
});

test('odd requests do not produce nonsense', () => {
  assert.deepEqual(testRoster(0), []);
  assert.deepEqual(testRoster(-5), []);
  assert.equal(testRoster(3, { clubs: 0 }).length, 3, 'zero clubs should not divide by zero');
  for (const line of testRoster(3, { clubs: 0 })) assert.match(line, /Club1$/);
});

test('a roster can start from a number, for topping one up', () => {
  const lines = testRoster(2, { startAt: 9 });
  assert.deepEqual(lines.map((l) => l.split(',')[0]), ['Player9', 'Player10']);
});

/* ---------------------------------------------------------- the scores */

test('every score pattern makes a legal table', () => {
  for (const p of SCORE_PATTERNS) {
    assert.equal(p.length, 4);
    assert.equal(p.reduce((a, b) => a + b, 0), 120000, `${p} does not come to 120,000`);
  }
});

test('the same table always gets the same scores', () => {
  for (let r = 1; r <= 5; r += 1) {
    for (let t = 1; t <= 4; t += 1) {
      assert.deepEqual(patternFor(r, t), patternFor(r, t));
      assert.equal(patternFor(r, t).reduce((a, b) => a + b, 0), 120000);
    }
  }
});

function started(players = 8) {
  const store = new TournamentStore();
  store.create('Test Event', { config: { ...FAST, demo: true } });
  store.addPlayersBulk(testRoster(players).join('\n'));
  store.generateRound();
  return store;
}

test('filling a round scores every table and says how many', () => {
  const store = started(8);
  const filled = fillOpenRound(store);
  assert.equal(filled, 2, 'eight players is two tables');

  const round = store.getRound(store.openRound().id);
  for (const t of round.tables) {
    assert.ok(t.outcome, `table ${t.tableNumber} was left unscored`);
    assert.ok(t.outcome.ok, t.outcome.issues.map((i) => i.message).join(' '));
  }
});

test('filling twice does not double-score a table', () => {
  const store = started(8);
  assert.equal(fillOpenRound(store), 2);
  assert.equal(fillOpenRound(store), 0, 'already-scored tables should be left alone');
});

test('a filled round is zero-sum, so the standings are usable', () => {
  const store = started(12);
  fillOpenRound(store);
  store.closeRound(store.openRound().id);
  const total = store.standings('overall')
    .reduce((a, s) => a + Number(s.tournamentScore), 0);
  assert.ok(Math.abs(total) < 1e-9, `standings sum to ${total}`);
});

test('a table can be left out, which is how the tutorial does one by hand', () => {
  const store = started(8);
  assert.equal(fillOpenRound(store, { skipTable: 1 }), 1);
  const round = store.getRound(store.openRound().id);
  assert.equal(round.tables.find((t) => t.tableNumber === 1).outcome, null);
});

test('filling with no open round is a no-op rather than a throw', () => {
  const store = new TournamentStore();
  store.create('Empty', { config: FAST });
  assert.equal(fillOpenRound(store), 0);
});

test('whole rounds can be played through', () => {
  // The round started() opened counts as the first: playRounds fills an open
  // round rather than insisting on generating its own.
  const store = started(8);
  playRounds(store, 3);
  const rounds = store.listRounds();
  assert.equal(rounds.length, 3);
  assert.equal(rounds.filter((r) => r.status !== 'complete').length, 0);
  assert.equal(store.openRound(), null);
});

/* ------------------------------------------------- test events are inert */

test('a test event is marked so nothing leaves the machine', async () => {
  const { BackupManager } = require('../src/backup.js');
  const writes = [];
  const manager = new BackupManager();
  manager.setTarget({
    async write(p) { writes.push(p); },
    async append(p) { writes.push(p); },
    async read() { return ''; },
    async ensurePermission() { return true; },
  });

  const store = started(8);
  assert.equal(store.doc.config.demo, true, 'a test event must carry the flag');
  await manager.handleChange(store, 'round_generated', {});
  assert.deepEqual(writes, [], 'a test event wrote to the backup folder');
});
