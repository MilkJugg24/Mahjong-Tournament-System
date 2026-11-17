/* Seating engine tests, ported from tests/test_seating.py. */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SeatingHistory, generateSeating, wheelSeating, seedCutSeating,
} = require('../src/seating.js');

const range = (n, from = 1) => Array.from({ length: n }, (_, i) => i + from);

function runEvent(n, rounds, {
  seed = 11, iterations = 30000, restarts = 3, timeBudget = 3.0, ...rest
} = {}) {
  const players = range(n);
  const history = new SeatingHistory(4);
  const plans = [];
  for (let r = 0; r < rounds; r++) {
    const plan = generateSeating(players, history, {
      seed: seed * 100 + r, iterations, restarts, timeBudget, ...rest,
    });
    history.record(plan);
    plans.push(plan);
  }
  return { players, history, plans };
}

const counter = (values) => {
  const m = new Map();
  for (const v of values) m.set(v, (m.get(v) || 0) + 1);
  return m;
};

/* ---------------------------------------------------------------- pairing */

test('everyone is seated exactly once per round', () => {
  const { players, plans } = runEvent(20, 3);
  for (const plan of plans) {
    const seated = plan.players();
    assert.deepEqual([...seated].sort((a, b) => a - b), players);
    assert.equal(new Set(seated).size, seated.length);
  }
});

test('repeat opponents are rare when the field allows it', () => {
  // 20 players over 4 rounds deals 120 meetings into 190 possible pairs, so a
  // perfect draw has no repeats. Rounds are drawn one at a time, as a real
  // event does, so an early round can leave a later one with no repeat-free
  // option. The bar is that repeats stay negligible and nobody meets a third
  // time.
  const { history } = runEvent(20, 4);
  const values = [...history.met.values()];
  const repeats = values.filter((v) => v > 1);
  assert.ok(Math.max(...values) <= 2, `worst repeat ${Math.max(...values)}`);
  assert.ok(repeats.length <= 3, `too many repeat pairs: ${repeats.length}`);
});

test('repeats are minimal when unavoidable', () => {
  // 16 players over 6 rounds deals 144 meetings into 120 pairs, so at least 24
  // pairs must meet twice -- and none should meet three times.
  const { history } = runEvent(16, 6);
  const counts = counter(history.met.values());
  assert.equal(Math.max(...history.met.values()), 2);
  assert.equal(counts.get(2), 24);
});

test('seat winds stay balanced over four hanchan', () => {
  // With four rounds and four winds a player's counts sum to 4, so the spread
  // is either a perfect 1/1/1/1 or something like 2/1/1/0 -- a spread of
  // exactly 1 cannot occur. The fair outcome is that most players get all four
  // winds and nobody doubles up twice.
  const { players, history } = runEvent(16, 4);
  let perfect = 0;
  for (const p of players) {
    const counts = history.windCounts(p);
    assert.equal(counts.reduce((a, b) => a + b, 0), 4);
    assert.ok(Math.max(...counts) <= 2, `player ${p} winds ${counts}`);
    if (Math.max(...counts) === 1) perfect++;
  }
  assert.ok(perfect >= players.length / 2, `only ${perfect} players got all four winds`);
});

test('seat winds even out over a longer event', () => {
  const { players, history } = runEvent(16, 8);
  for (const p of players) {
    const counts = history.windCounts(p);
    assert.ok(Math.max(...counts) - Math.min(...counts) <= 2, `player ${p} ${counts}`);
  }
});

test('players move between tables', () => {
  const { players, history } = runEvent(24, 5);
  for (const p of players) {
    // Nobody should be parked at one table for the whole event (WRC 5).
    assert.ok(history.tableCounts(p).size > 1, `player ${p} never moved table`);
  }
});

test('the same seed gives the same seating', () => {
  const a = generateSeating(range(16), null, { seed: 7, iterations: 3000, restarts: 1 });
  const b = generateSeating(range(16), null, { seed: 7, iterations: 3000, restarts: 1 });
  assert.deepEqual(a.tables, b.tables);
});

test('a different seed gives a different seating', () => {
  const a = generateSeating(range(16), null, { seed: 7, iterations: 3000, restarts: 1 });
  const b = generateSeating(range(16), null, { seed: 8, iterations: 3000, restarts: 1 });
  assert.notDeepEqual(a.tables, b.tables);
});

test('clubs are kept apart when possible', () => {
  const players = range(16);
  const clubs = new Map(players.map((p) => [p, `club-${p % 4}`]));
  const plan = generateSeating(players, null, {
    clubs, seed: 3, iterations: 20000, restarts: 3,
    weights: { repeat: 100, wind: 1, table: 1, club: 200 },
  });
  let clashes = 0;
  for (const { seats } of plan.numberedTables()) {
    const names = seats.filter(Boolean).map((p) => clubs.get(p));
    clashes += names.length - new Set(names).size;
  }
  assert.equal(clashes, 0);
});

/* ------------------------------------------------------------------ byes */

test('byes match the remainder', () => {
  for (const [n, expected] of [[38, 2], [23, 3], [21, 1], [20, 0]]) {
    const plan = generateSeating(range(n), null, { seed: 1, iterations: 2000, restarts: 1 });
    assert.equal(plan.byes.length, expected, `n=${n}`);
    assert.equal(plan.players().length + plan.byes.length, n, `n=${n}`);
  }
});

test('byes rotate fairly', () => {
  const { players, history } = runEvent(38, 6);
  const counts = players.map((p) => history.byeCount(p));
  assert.ok(Math.max(...counts) - Math.min(...counts) <= 1);
  assert.equal(counts.reduce((a, b) => a + b, 0), 12); // 6 rounds x 2 sitting out
});

test('sit-ins never sit out', () => {
  const players = range(22); // 22 -> 2 byes
  const sitIns = [21, 22];
  const history = new SeatingHistory(4);
  for (let r = 0; r < 4; r++) {
    const plan = generateSeating(players, history, {
      seed: r, iterations: 2000, restarts: 1, neverBye: sitIns,
    });
    for (const s of sitIns) assert.ok(!plan.byes.includes(s), `round ${r}: ${s} sat out`);
    history.record(plan);
  }
});

test('a forced bye is honoured', () => {
  const plan = generateSeating(range(22), null, {
    seed: 1, iterations: 2000, restarts: 1, forceBye: [5],
  });
  assert.ok(plan.byes.includes(5));
});

/* ---------------------------------------------------------- locked seats */

test('a locked player keeps their seat', () => {
  const plan = generateSeating(range(16), null, {
    seed: 2, iterations: 5000, restarts: 1,
    locked: new Map([[3, { tableNumber: 2, seatIndex: 0 }]]),
  });
  assert.deepEqual(plan.seatOf(3), { tableNumber: 2, seatIndex: 0 });
});

/* ----------------------------------------------------------------- wheel */

test('the wheel seats everyone', () => {
  const plans = wheelSeating(range(32), 4, { seed: 5 });
  assert.equal(plans.length, 4);
  for (const plan of plans) {
    assert.deepEqual([...plan.players()].sort((a, b) => a - b), range(32));
  }
});

test('the wheel keeps repeats low on a large field', () => {
  const plans = wheelSeating(range(72), 7, { seed: 5 });
  const history = SeatingHistory.fromPlans(plans);
  assert.ok(Math.max(...history.met.values()) <= 2);
});

/* ----------------------------------------------------------- cut seating */

test('a single final table', () => {
  assert.deepEqual(seedCutSeating([10, 20, 30, 40]).tables, [[10, 20, 30, 40]]);
});

test('snake spreads the seeds', () => {
  const plan = seedCutSeating(range(16), { style: 'snake' });
  assert.deepEqual(plan.tables[0], [1, 8, 9, 16]);
  assert.deepEqual(plan.tables[3], [4, 5, 12, 13]);
});

test('rank order fills in order', () => {
  const plan = seedCutSeating(range(16), { style: 'rank_order' });
  assert.deepEqual(plan.tables[0], [1, 2, 3, 4]);
});

test('leftovers become byes', () => {
  assert.deepEqual(seedCutSeating(range(6)).byes, [5, 6]);
});

/* ----------------------------------------------------------- edge cases */

test('an empty field', () => {
  assert.deepEqual(generateSeating([], null, { seed: 1 }).tables, []);
});

test('fewer players than a table', () => {
  const plan = generateSeating([1, 2, 3], null, { seed: 1 });
  assert.deepEqual(plan.tables, []);
  assert.deepEqual([...plan.byes].sort((a, b) => a - b), [1, 2, 3]);
});

test('exactly one table', () => {
  const plan = generateSeating([1, 2, 3, 4], null, { seed: 1, iterations: 500, restarts: 1 });
  assert.equal(plan.tables.length, 1);
  assert.deepEqual([...plan.players()].sort((a, b) => a - b), [1, 2, 3, 4]);
});

test('history round-trips through JSON', () => {
  const { history } = runEvent(16, 2);
  const again = SeatingHistory.fromJSON(JSON.parse(JSON.stringify(history)));
  assert.equal(again.met.size, history.met.size);
  assert.deepEqual(again.summary(), history.summary());
  assert.deepEqual(again.windCounts(1), history.windCounts(1));
});
