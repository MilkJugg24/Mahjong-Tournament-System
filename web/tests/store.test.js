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
