/* Tournament operations, ported from tests/test_store.py. */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { TournamentStore, StoreError } = require('../src/store.js');

const FAST = { seating: { iterations: 2000, restarts: 1, timeBudget: 1.0 } };

function newStore() {
  const store = new TournamentStore();
  store.create('Test Cup', { config: FAST });
  return store;
}

function addPlayers(store, n) {
  const lines = [];
  for (let i = 1; i <= n; i++) lines.push(`Player ${String(i).padStart(2, '0')},Club ${i % 3}`);
  return store.addPlayersBulk(lines.join('\n'));
}

function playRound(store, roundId, scores = [45000, 32000, 25000, 18000], riichi = 0) {
  const round = store.getRound(roundId);
  for (const table of round.tables) {
    const seats = table.seats.filter((s) => s.playerId);
    store.saveTable(roundId, table.tableNumber,
      seats.map((s, i) => ({ playerId: s.playerId, rawScore: scores[i] })),
      { riichiLeft: riichi });
  }
  return store.getRound(roundId);
}

/* -------------------------------------------------------- the tournament */

test('create and fetch', () => {
  const store = newStore();
  assert.equal(store.doc.name, 'Test Cup');
  assert.equal(store.doc.status, 'setup');
  assert.equal(store.rules.startingPoints, 30000);
});

test('a name is required', () => {
  assert.throws(() => new TournamentStore().create('   '), StoreError);
});

test('invalid rules are rejected before saving', () => {
  const store = newStore();
  assert.throws(() => store.update({ rules: { uma: ['15', '5', '-5'] } }));
  assert.equal(store.doc.rules.uma.length, 4); // untouched
});

/* ------------------------------------------------------------- players */

test('bulk add splits name and club', () => {
  const store = newStore();
  store.addPlayersBulk('Player 01, Club A\nPlayer 02\tClub B\n\n# comment');
  const players = store.listPlayers();
  assert.deepEqual(players.map((p) => p.name), ['Player 01', 'Player 02']);
  assert.equal(players[0].club, 'Club A');
  assert.equal(players[1].club, 'Club B');
});

test('duplicate names are skipped', () => {
  const store = newStore();
  store.addPlayersBulk('Player 01\nPlayer 01\nplayer 01');
  assert.equal(store.listPlayers().length, 1);
});

test('cannot delete a player who has played', () => {
  const store = newStore();
  addPlayers(store, 4);
  const round = store.generateRound();
  playRound(store, round.id);
  const pid = store.listPlayers()[0].id;
  assert.throws(() => store.deletePlayer(pid), /Withdraw/);
});

test('withdrawn players are not seated', () => {
  const store = newStore();
  const ids = addPlayers(store, 8);
  store.updatePlayer(ids[0].id, { status: 'withdrawn' });
  const round = store.generateRound();
  const seated = round.tables.flatMap((t) => t.seats.map((s) => s.playerId));
  assert.ok(!seated.includes(ids[0].id));
});

/* -------------------------------------------------------------- rounds */

test('needs enough players for a table', () => {
  const store = newStore();
  addPlayers(store, 3);
  assert.throws(() => store.generateRound(), StoreError);
});

test('cannot open two rounds at once', () => {
  const store = newStore();
  addPlayers(store, 8);
  store.generateRound();
  assert.throws(() => store.generateRound(), /still open/);
});

test('round numbers increment', () => {
  const store = newStore();
  addPlayers(store, 8);
  for (const expected of [1, 2, 3]) {
    const round = store.generateRound();
    assert.equal(round.number, expected);
    playRound(store, round.id);
    store.closeRound(round.id);
  }
});

test('byes are recorded with a score', () => {
  const store = newStore();
  addPlayers(store, 6); // 1 table + 2 sitting out
  const round = store.generateRound();
  assert.equal(round.byes.length, 2);
  assert.equal(round.byes[0].score, '0.0');
});

test('closing needs every table, or a force', () => {
  const store = newStore();
  addPlayers(store, 8);
  const round = store.generateRound();
  assert.throws(() => store.closeRound(round.id), /no result yet/);
  assert.equal(store.closeRound(round.id, { force: true }).status, 'complete');
});

test('cannot reseat after scores are in', () => {
  const store = newStore();
  addPlayers(store, 8);
  const round = store.generateRound();
  playRound(store, round.id);
  assert.throws(() => store.reseatRound(round.id), StoreError);
});

test('cannot delete an earlier round first', () => {
  const store = newStore();
  addPlayers(store, 8);
  const first = store.generateRound();
  playRound(store, first.id);
  store.closeRound(first.id);
  store.generateRound();
  assert.throws(() => store.deleteRound(first.id), /backwards/);
});

test('swap seats', () => {
  const store = newStore();
  addPlayers(store, 8);
  const round = store.generateRound();
  const a = round.tables[0].seats[0].playerId;
  const b = round.tables[1].seats[0].playerId;
  const after = store.swapSeats(round.id, a, b);
  assert.equal(after.tables[0].seats[0].playerId, b);
  assert.equal(after.tables[1].seats[0].playerId, a);
});

test('reseating produces a different draw', () => {
  const store = newStore();
  addPlayers(store, 12);
  const first = store.generateRound({ seed: 1 });
  const before = first.tables.map((t) => t.seats.map((s) => s.playerId));
  const again = store.reseatRound(first.id, 999);
  const after = again.tables.map((t) => t.seats.map((s) => s.playerId));
  assert.notDeepEqual(before, after);
  assert.equal(store.listRounds().length, 1);
});

// The button in the UI passes no seed, which is the path that was broken: the
// derived seed depends only on the round number and the field size, so a redraw
// reproduced the draw it was meant to replace.
test('reseating with no seed produces a different draw', () => {
  const store = newStore();
  addPlayers(store, 12);
  const first = store.generateRound();
  const seen = [JSON.stringify(first.tables.map((t) => t.seats.map((s) => s.playerId)))];

  let round = first;
  for (let i = 0; i < 3; i++) {
    round = store.reseatRound(round.id);
    const draw = JSON.stringify(round.tables.map((t) => t.seats.map((s) => s.playerId)));
    assert.ok(!seen.includes(draw), `redraw ${i + 1} repeated an earlier draw`);
    seen.push(draw);
  }
  assert.equal(store.listRounds().length, 1);
});

test('reseating a later round with no seed also redraws', () => {
  const store = newStore();
  addPlayers(store, 16);
  const first = store.generateRound();
  playRound(store, first.id);
  store.closeRound(first.id);

  const second = store.generateRound();
  const before = second.tables.map((t) => t.seats.map((s) => s.playerId));
  const again = store.reseatRound(second.id);
  assert.notDeepEqual(before, again.tables.map((t) => t.seats.map((s) => s.playerId)));
  assert.equal(again.number, second.number);
  assert.equal(store.listRounds().length, 2);
});

test('a redraw records the seed it used', () => {
  const store = newStore();
  addPlayers(store, 8);
  const first = store.generateRound();
  const again = store.reseatRound(first.id);
  assert.notEqual(again.seed, first.seed);
  const event = store.doc.events.filter((e) => e.kind === 'round_reseated').pop();
  assert.equal(event.payload.seed, again.seed);
});

/* --------------------------------------------------------- score entry */

function seededTable(store) {
  addPlayers(store, 8);
  return store.generateRound();
}

const entriesFor = (round, scores) =>
  round.tables[0].seats.filter((s) => s.playerId)
    .map((s, i) => ({ playerId: s.playerId, rawScore: scores[i] }));

test('rejects a table that does not add up', () => {
  const store = newStore();
  const round = seededTable(store);
  assert.throws(
    () => store.saveTable(round.id, 1, entriesFor(round, [45000, 32000, 25000, 19000])),
    /120,000/);
});

test('accepts the shortfall as riichi sticks', () => {
  const store = newStore();
  const round = seededTable(store);
  const out = store.saveTable(round.id, 1, entriesFor(round, [45000, 32000, 25000, 17000]),
    { riichiLeft: 1 });
  const table = out.tables.find((t) => t.tableNumber === 1);
  assert.ok(table.outcome.ok);
  const total = table.outcome.seats.reduce((a, s) => a + Number(s.hanchanScore), 0);
  assert.equal(total + 1, 0);
});

test('an override lets a bad total through', () => {
  const store = newStore();
  const round = seededTable(store);
  const out = store.saveTable(round.id, 1, entriesFor(round, [45000, 32000, 25000, 19000]),
    { allowIssues: true });
  assert.equal(out.tables.find((t) => t.tableNumber === 1).outcome.ok, false);
});

test('a missing score is rejected', () => {
  const store = newStore();
  const round = seededTable(store);
  const bad = entriesFor(round, [45000, 32000, 25000, 18000]);
  bad[2].rawScore = null;
  assert.throws(() => store.saveTable(round.id, 1, bad), /needs a score/);
});

test('a player not at the table is rejected', () => {
  const store = newStore();
  const round = seededTable(store);
  const other = round.tables[1].seats[0].playerId;
  const bad = entriesFor(round, [45000, 32000, 25000, 18000]);
  bad[0].playerId = other;
  assert.throws(() => store.saveTable(round.id, 1, bad), /not seated/);
});

test('resaving replaces rather than duplicates', () => {
  const store = newStore();
  const round = seededTable(store);
  store.saveTable(round.id, 1, entriesFor(round, [45000, 32000, 25000, 18000]));
  store.saveTable(round.id, 1, entriesFor(round, [40000, 35000, 25000, 20000]));
  const raw = store.findRound(round.id).tables.find((t) => t.tableNumber === 1);
  assert.equal(Object.keys(raw.results).length, 4);
  assert.equal(Math.max(...Object.values(raw.results).map((r) => r.rawScore)), 40000);
});

test('clearing a table resets it', () => {
  const store = newStore();
  const round = seededTable(store);
  store.saveTable(round.id, 1, entriesFor(round, [45000, 32000, 25000, 18000]));
  const out = store.clearTable(round.id, 1);
  const table = out.tables.find((t) => t.tableNumber === 1);
  assert.equal(table.status, 'pending');
  assert.equal(table.outcome, null);
});

test('preview does not save', () => {
  const store = newStore();
  const round = seededTable(store);
  const preview = store.previewTable(round.id, 1, entriesFor(round, [45000, 32000, 25000, 18000]));
  assert.ok(preview.complete);
  assert.equal(preview.seats[0].placement, 1);
  assert.equal(preview.seats[0].hanchanScore, '30.0');
  assert.equal(store.getRound(round.id).tablesReported, 0);
});

test('a closed round rejects edits', () => {
  const store = newStore();
  const round = seededTable(store);
  playRound(store, round.id);
  store.closeRound(round.id);
  assert.throws(
    () => store.saveTable(round.id, 1, entriesFor(round, [45000, 32000, 25000, 18000])),
    /closed/);
});

test('verify then clear', () => {
  const store = newStore();
  const round = seededTable(store);
  store.saveTable(round.id, 1, entriesFor(round, [45000, 32000, 25000, 18000]));
  const verified = store.verifyTable(round.id, 1, 'judge');
  assert.equal(verified.tables[0].status, 'verified');
  assert.equal(verified.tables[0].verifiedBy, 'judge');
  assert.equal(store.clearTable(round.id, 1).tables[0].status, 'pending');
});

test('verifying before entering is refused', () => {
  const store = newStore();
  const round = seededTable(store);
  assert.throws(() => store.verifyTable(round.id, 1, 'judge'), /before verifying/);
});

/* ---------------------------------------------------- standings and cut */

test('standings accumulate', () => {
  const store = newStore();
  addPlayers(store, 8);
  for (let i = 0; i < 2; i++) {
    const round = store.generateRound();
    playRound(store, round.id);
    store.closeRound(round.id);
  }
  const table = store.standings('qualifying');
  assert.equal(table.length, 8);
  assert.equal(table.reduce((a, s) => a + Number(s.tournamentScore.toString()), 0), 0);
  assert.ok(table.every((s) => s.hanchanPlayed === 2));
});

test('a penalty reduces the score', () => {
  const store = newStore();
  addPlayers(store, 4);
  const round = store.generateRound();
  playRound(store, round.id);
  store.closeRound(round.id);
  const winner = store.standings('qualifying')[0];
  const before = Number(winner.tournamentScore.toString());
  store.addPenalty(winner.playerId, 30, { reason: 'late' });
  const after = store.standings('qualifying').find((s) => s.playerId === winner.playerId);
  assert.equal(Number(after.tournamentScore.toString()), before - 30);
});

/* One qualifying round of eight, so two tables: the winners on 30, then 7. */
function qualified8() {
  const store = newStore();
  addPlayers(store, 8);
  const round = store.generateRound();
  playRound(store, round.id);
  store.closeRound(round.id);
  return store;
}
const scoreOf = (rows, pid) => Number(rows.find((s) => s.playerId === pid).tournamentScore.toString());

test('a qualifying penalty is not taken again under a full carry', () => {
  const store = qualified8();
  const winner = store.standings('qualifying')[0].playerId;
  store.addPenalty(winner, 10, { reason: 'late' });
  assert.equal(scoreOf(store.standings('qualifying'), winner), 20);
  store.applyCut({ size: 4, carry: 'full', rounds: 1 });
  // The carried 20 already has the penalty in it. It used to come out at 10.
  assert.equal(scoreOf(store.standings('final'), winner), 20);
});

test('a qualifying penalty does not follow a player into a reset final', () => {
  const store = qualified8();
  const winner = store.standings('qualifying')[0].playerId;
  store.addPenalty(winner, 10, { reason: 'late' });
  store.applyCut({ size: 4, carry: 'reset', rounds: 1 });
  assert.equal(scoreOf(store.standings('final'), winner), 0, 'the finals start level');
});

test('a penalty given after the cut counts towards the finals', () => {
  const store = qualified8();
  store.applyCut({ size: 4, carry: 'reset', rounds: 1 });
  const finalist = store.standings('final')[0].playerId;
  const before = scoreOf(store.standings('qualifying'), finalist);
  const penalty = store.addPenalty(finalist, 5, { reason: 'slow play' });
  assert.equal(penalty.phase, 'final');
  assert.equal(scoreOf(store.standings('final'), finalist), -5);
  assert.equal(scoreOf(store.standings('qualifying'), finalist), before);
});

test('a penalty tied to a round takes that round\'s stage', () => {
  const store = qualified8();
  const round = store.listRounds()[0];
  store.applyCut({ size: 4, carry: 'reset', rounds: 1 });
  const finalist = store.standings('final')[0].playerId;
  const penalty = store.addPenalty(finalist, 5, { roundId: round.id, phase: 'final' });
  assert.equal(penalty.phase, 'qualifying', 'the round decides, not the default');
  assert.equal(scoreOf(store.standings('final'), finalist), 0);
});

test('a finals penalty is refused before the cut', () => {
  const store = qualified8();
  const pid = store.listPlayers()[0].id;
  assert.throws(() => store.addPenalty(pid, 5, { phase: 'final' }), StoreError);
});

test('penalties saved without a stage are placed by when they were given', () => {
  // Documents written before penalties recorded a stage.
  const store = qualified8();
  store.applyCut({ size: 4, carry: 'reset', rounds: 1 });
  const at = store.doc.config.cut.appliedAt;
  const [a, b] = store.standings('final').map((s) => s.playerId);
  store.doc.penalties.push(
    { id: 90, playerId: a, roundId: null, points: '7', reason: '', createdAt: '2000-01-01T00:00:00Z' },
    { id: 91, playerId: b, roundId: null, points: '7', reason: '', createdAt: at },
  );
  assert.equal(scoreOf(store.standings('final'), a), 0, 'given before the cut: qualifying');
  assert.equal(scoreOf(store.standings('final'), b), -7, 'given at the cut or after: finals');
});

test('a cut requires a closed round', () => {
  const store = newStore();
  addPlayers(store, 8);
  store.generateRound();
  assert.throws(() => store.applyCut({ size: 4 }), /still open/);
});

test('a cut refuses a tied cut line', () => {
  const store = newStore();
  addPlayers(store, 8);
  const round = store.generateRound();
  playRound(store, round.id, [40000, 30000, 30000, 20000]); // both tables identical
  store.closeRound(round.id);
  assert.throws(() => store.applyCut({ size: 4 }), /cut line is tied/);
});

test('a manual tiebreak unblocks the cut', () => {
  const store = newStore();
  addPlayers(store, 8);
  const round = store.generateRound();
  playRound(store, round.id, [40000, 30000, 30000, 20000]);
  store.closeRound(round.id);
  const tied = store.standings('qualifying').filter((s) => s.needsCoinToss);
  assert.ok(tied.length);
  tied.forEach((s, i) => store.updatePlayer(s.playerId, { manualTiebreak: tied.length - i }));
  assert.ok(!store.standings('qualifying').some((s) => s.needsCoinToss));
  const out = store.applyCut({ size: 4 });
  assert.ok(out.config.cut.applied);
  assert.equal(out.config.cut.qualified.length, 4);
});

test('finals reset points', () => {
  const store = newStore();
  addPlayers(store, 8);
  const round = store.generateRound();
  playRound(store, round.id);
  store.closeRound(round.id);
  store.applyCut({ size: 4, carry: 'reset', rounds: 1 });
  const final = store.generateRound({ phase: 'final' });
  assert.equal(final.tables.length, 1);
  playRound(store, final.id);
  store.closeRound(final.id);
  const finals = store.standings('final');
  assert.equal(finals.length, 4);
  assert.ok(finals.every((s) => s.carryOver.isZero));
  assert.equal(finals.reduce((a, s) => a + Number(s.tournamentScore.toString()), 0), 0);
});

test('finals can carry half', () => {
  const store = newStore();
  addPlayers(store, 8);
  const round = store.generateRound();
  playRound(store, round.id);
  store.closeRound(round.id);
  const qualifying = new Map(
    store.standings('qualifying').map((s) => [s.playerId, Number(s.tournamentScore.toString())]));
  store.applyCut({ size: 4, carry: 'half', rounds: 1 });
  for (const s of store.standings('final')) {
    assert.equal(Number(s.carryOver.toString()), qualifying.get(s.playerId) / 2);
  }
});

test('cannot undo a cut once finals are seated', () => {
  const store = newStore();
  addPlayers(store, 8);
  const round = store.generateRound();
  playRound(store, round.id);
  store.closeRound(round.id);
  store.applyCut({ size: 4, rounds: 1 });
  store.generateRound({ phase: 'final' });
  assert.throws(() => store.undoCut(), StoreError);
});

test('free-play rounds do not score', () => {
  const store = newStore();
  addPlayers(store, 8);
  const round = store.generateRound({ phase: 'free_play' });
  playRound(store, round.id);
  store.closeRound(round.id);
  assert.equal(store.standings('overall')[0].hanchanPlayed, 0);
});

test('sit-ins are not ranked', () => {
  const store = newStore();
  const ids = addPlayers(store, 8);
  store.updatePlayer(ids[0].id, { role: 'sit_in' });
  const round = store.generateRound();
  playRound(store, round.id);
  store.closeRound(round.id);
  const ranked = store.standings('qualifying').map((s) => s.playerId);
  assert.ok(!ranked.includes(ids[0].id));
  assert.equal(ranked.length, 7);
});

function withSitIns(ranked, sitIns) {
  const store = newStore();
  addPlayers(store, ranked);
  for (let i = 1; i <= sitIns; i++) store.addPlayer(`Sit-in ${i}`, { role: 'sit_in' });
  return store;
}

const seatedIn = (round) => round.tables.flatMap((t) => t.seats.map((s) => s.playerId));
const sitInIds = (store) => new Set(store.listPlayers()
  .filter((p) => p.role === 'sit_in').map((p) => p.id));

test('sit-ins do not take seats from a field that fills its own tables', () => {
  // The bug this pins: 32 ranked and three sit-ins left three ranked players
  // out on a bye every round, so that the sit-ins could play.
  const store = withSitIns(32, 3);
  const round = store.generateRound();
  assert.equal(round.byes.length, 0, 'no ranked player should sit out');
  assert.equal(round.tables.length, 8);
  const subs = sitInIds(store);
  assert.ok(!seatedIn(round).some((id) => subs.has(id)), 'no sit-in should be seated');
});

test('sit-ins make up the last table when there are enough of them', () => {
  const store = withSitIns(30, 3);
  const round = store.generateRound();
  assert.equal(round.byes.length, 0);
  assert.equal(round.tables.length, 8);
  const subs = sitInIds(store);
  assert.equal(seatedIn(round).filter((id) => subs.has(id)).length, 2,
    'exactly the two sit-ins the last table needs');
});

test('too few sit-ins to complete a table leaves them out', () => {
  // 29 ranked need three to complete the eighth table; one sit-in cannot, and
  // seating it would only turn one ranked bye into two.
  const store = withSitIns(29, 1);
  const round = store.generateRound();
  assert.equal(round.tables.length, 7);
  assert.equal(round.byes.length, 1);
  const subs = sitInIds(store);
  assert.ok(!round.byes.some((b) => subs.has(b.playerId)));
  assert.ok(!seatedIn(round).some((id) => subs.has(id)));
});

test('the sit-in who has played least goes in first', () => {
  const store = withSitIns(31, 2);
  const first = store.generateRound();
  playRound(store, first.id);
  store.closeRound(first.id);
  const second = store.generateRound();
  const subs = sitInIds(store);
  const a = seatedIn(first).find((id) => subs.has(id));
  const b = seatedIn(second).find((id) => subs.has(id));
  assert.ok(a && b && a !== b, 'the work should rotate between the sit-ins');
});

test('the field plan says what fills the last table', () => {
  assert.deepEqual(withSitIns(63, 0).fieldPlan(), {
    ranked: 63, sitInsOnHand: 0, sitInsUsed: 0, tables: 15, sittingOut: 3, short: 1,
  });
  assert.equal(withSitIns(63, 3).fieldPlan().sitInsUsed, 1);
  assert.equal(withSitIns(64, 3).fieldPlan().sitInsUsed, 0);
});

/* -------------------------------------------------------- bookkeeping */

test('the event log records every change', () => {
  const store = newStore();
  addPlayers(store, 4);
  const kinds = store.events().map((e) => e.kind);
  assert.ok(kinds.includes('player_added'));
  assert.ok(kinds.includes('tournament_created'));
});

test('a failing backup hook does not lose the edit', () => {
  const store = new TournamentStore(null, () => { throw new Error('disk full'); });
  store.create('Resilient Cup', { config: FAST });
  const player = store.addPlayer('Resilient Rita');
  assert.ok(store.listPlayers().some((p) => p.id === player.id));
  assert.ok(store.events().some((e) => e.kind === 'backup_failed'));
  assert.match(store.lastError, /disk full/);
});

test('the document round-trips through JSON', () => {
  const store = newStore();
  addPlayers(store, 8);
  const round = store.generateRound();
  playRound(store, round.id);
  store.closeRound(round.id);
  const before = store.standings('qualifying').map((s) => s.tournamentScore.toString());

  const revived = new TournamentStore();
  revived.load(JSON.parse(JSON.stringify(store.doc)));
  const after = revived.standings('qualifying').map((s) => s.tournamentScore.toString());
  assert.deepEqual(after, before);
  assert.equal(revived.getRound(round.id).tablesReported, 2);
});

test('summary reports the shape of the event', () => {
  const store = newStore();
  addPlayers(store, 9);
  const s = store.summary();
  assert.equal(s.counts.players, 9);
  assert.equal(s.counts.ranked, 9);
  assert.equal(s.rulesSummary.tableTotal, 120000);
  assert.equal(s.openRound, null);
});
