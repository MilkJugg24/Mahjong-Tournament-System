/* Scoring engine tests, ported from tests/test_scoring.py.
 * Checked against the published WRC worked examples.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { R, sum } = require('../src/rational.js');
const {
  ScoreRules, RulesError, seatScore, tableScore,
  validateTable, scoreTable, playerRecord, buildStandings,
  RULESET_PRESETS,
} = require('../src/scoring.js');

const table = (scores, { riichi = 0, chombo = null, penalties = null } = {}) => tableScore({
  tableNumber: 1,
  riichiLeft: riichi,
  seats: scores.map((s, i) => seatScore({
    playerId: i + 1,
    seat: i,
    rawScore: s,
    chombo: chombo ? chombo[i] : 0,
    penaltyPoints: penalties ? penalties[i] : 0,
  })),
});

const scoresOf = (outcome) => outcome.seats.map((s) => s.hanchanScore.toFixed(1));
const totalOf = (outcome) => sum(outcome.seats.map((s) => s.hanchanScore));

/* ------------------------------------------------------------ WRC 2025 */

test('defaults match WRC 2025', () => {
  const rules = new ScoreRules();
  assert.equal(rules.startingPoints, 30000);
  assert.equal(rules.goalPoints, 30000);
  assert.deepEqual(rules.uma.map(String), ['15', '5', '-5', '-15']);
  assert.equal(rules.oka.toString(), '0');
  assert.equal(rules.tableTotal, 120000);
  assert.equal(rules.umaSum.toString(), '0');
});

test('a basic hanchan', () => {
  const out = scoreTable(new ScoreRules(), table([45000, 32000, 25000, 18000]));
  assert.ok(out.ok);
  assert.deepEqual(scoresOf(out), ['30.0', '7.0', '-10.0', '-27.0']);
  assert.deepEqual(out.seats.map((s) => s.placement), [1, 2, 3, 4]);
});

test('scores sum to zero', () => {
  const out = scoreTable(new ScoreRules(), table([45000, 32000, 25000, 18000]));
  assert.equal(totalOf(out).toString(), '0');
});

test('riichi sticks left on the table: scores plus deposits come to zero', () => {
  const out = scoreTable(new ScoreRules(), table([45000, 32000, 25000, 16000], { riichi: 2 }));
  assert.ok(out.ok);
  assert.equal(totalOf(out).add(R(2)).toString(), '0');
});

test('a tie splits the uma -- the WRC example', () => {
  // Two tied for first get +10 each; 3rd and 4th still get -5 and -15.
  const out = scoreTable(new ScoreRules(), table([40000, 40000, 25000, 15000]));
  const bySeat = new Map(out.seats.map((s) => [s.seat, s]));
  assert.equal(bySeat.get(0).uma.toFixed(1), '10.0');
  assert.equal(bySeat.get(1).uma.toFixed(1), '10.0');
  assert.equal(bySeat.get(2).uma.toFixed(1), '-5.0');
  assert.equal(bySeat.get(3).uma.toFixed(1), '-15.0');
  assert.deepEqual([0, 1, 2, 3].map((i) => bySeat.get(i).placement), [1, 1, 3, 4]);
  assert.equal(totalOf(out).toString(), '0');
});

test('a four-way tie', () => {
  const out = scoreTable(new ScoreRules(), table([30000, 30000, 30000, 30000]));
  assert.deepEqual(scoresOf(out), ['0.0', '0.0', '0.0', '0.0']);
  assert.ok(out.seats.every((s) => s.placement === 1));
});

test('seat-order tie breaking gives a strict order', () => {
  const rules = new ScoreRules({ tieMode: 'seat_order' });
  const out = scoreTable(rules, table([30000, 30000, 30000, 30000]));
  assert.deepEqual(out.seats.map((s) => s.placement), [1, 2, 3, 4]);
  assert.deepEqual(scoresOf(out), ['15.0', '5.0', '-5.0', '-15.0']);
});

/* -------------------------------------------- WRC Optional Rules examples */

test('WORKED EXAMPLE: uneven uma truncates to one decimal', () => {
  // "with a +20P / +10P / -10P / -20P uma, in case three players are tied to
  //  the top, they will get +6.6P / +6.6P / +6.6P / -20P and the sum of
  //  hanchan scores will be off by 0.2P"
  const rules = new ScoreRules({ uma: [20, 10, -10, -20] });
  const out = scoreTable(rules, table([35000, 35000, 35000, 15000]));
  const top = out.seats.filter((s) => s.placement === 1);
  assert.deepEqual(top.map((s) => s.uma.toFixed(1)), ['6.6', '6.6', '6.6']);
  assert.equal(totalOf(out).toFixed(1), '-0.2');
});

test('WORKED EXAMPLE: oka, split with the uma before rounding', () => {
  // "with a +20P / +10P / -10P / -20P uma and 20P oka, in case three players
  //  are tied to the top, they will get +13.3P ... off by 0.1P"
  const rules = new ScoreRules({
    startingPoints: 25000, goalPoints: 30000, uma: [20, 10, -10, -20],
  });
  assert.equal(rules.oka.toString(), '20');
  assert.equal(rules.tableTotal, 100000);
  const out = scoreTable(rules, table([30000, 30000, 30000, 10000]));
  const top = out.seats.filter((s) => s.placement === 1);
  assert.deepEqual(top.map((s) => s.hanchanScore.toFixed(1)), ['13.3', '13.3', '13.3']);
  assert.equal(totalOf(out).toFixed(1), '-0.1');
});

test('oka to a single winner', () => {
  const rules = new ScoreRules({ startingPoints: 25000, goalPoints: 30000 });
  const out = scoreTable(rules, table([45000, 30000, 15000, 10000]));
  const winner = out.seats.find((s) => s.placement === 1);
  assert.equal(winner.oka.toFixed(1), '20.0');
  assert.equal(winner.hanchanScore.toFixed(1), '50.0');
  assert.equal(totalOf(out).toString(), '0');
});

/* ------------------------------------------------------------ validation */

test('a wrong total is an error', () => {
  const issues = validateTable(new ScoreRules(), table([45000, 32000, 25000, 19000]));
  const totals = issues.filter((i) => i.code === 'table_total');
  assert.equal(totals.length, 1);
  assert.equal(totals[0].severity, 'error');
  assert.match(totals[0].message, /120,000/);
  // 45000+32000+25000+19000 = 121,000, so the message must say it is 1,000 over.
  assert.match(totals[0].message, /\+1,000/);
});

test('a shortfall is reported as negative', () => {
  const issues = validateTable(new ScoreRules(), table([45000, 32000, 25000, 17000]));
  const totals = issues.filter((i) => i.code === 'table_total');
  assert.equal(totals.length, 1);
  assert.match(totals[0].message, /-1,000/);
});

test('a total including deposits is accepted', () => {
  const issues = validateTable(new ScoreRules(), table([45000, 32000, 25000, 17000], { riichi: 1 }));
  assert.deepEqual(issues.filter((i) => i.severity === 'error'), []);
});

test('odd hundreds warn but do not block', () => {
  const issues = validateTable(new ScoreRules(), table([45050, 31950, 25000, 18000]));
  assert.ok(issues.some((i) => i.code === 'score_granularity'));
  assert.ok(!issues.some((i) => i.severity === 'error'));
});

test('a duplicate player is an error', () => {
  const t = table([30000, 30000, 30000, 30000]);
  t.seats[1].playerId = t.seats[0].playerId;
  assert.ok(validateTable(new ScoreRules(), t).some((i) => i.code === 'duplicate_player'));
});

test('a duplicate seat is an error', () => {
  const t = table([30000, 30000, 30000, 30000]);
  t.seats[1].seat = 0;
  assert.ok(validateTable(new ScoreRules(), t).some((i) => i.code === 'duplicate_seat'));
});

test('no residual warning when the total is already wrong', () => {
  const out = scoreTable(new ScoreRules(), table([45000, 32000, 25000, 19000]));
  const codes = out.issues.map((i) => i.code);
  assert.ok(codes.includes('table_total'));
  assert.ok(!codes.includes('score_residual'));
});

/* ---------------------------------------------------------------- chombo */

test('chombo is a tournament penalty, not a table payment', () => {
  const rules = new ScoreRules();
  const out = scoreTable(rules, table([45000, 32000, 25000, 18000], { chombo: [0, 0, 0, 1] }));
  assert.ok(out.ok);
  assert.equal(totalOf(out).toString(), '0'); // the table total is untouched
  const fourth = out.seats.find((s) => s.chombo);
  assert.equal(fourth.penaltyPoints.toFixed(1), '30.0');
});

test('table-payment mode adds nothing', () => {
  const rules = new ScoreRules({ chomboMode: 'table_payment' });
  const out = scoreTable(rules, table([45000, 32000, 25000, 18000], { chombo: [0, 0, 0, 1] }));
  assert.deepEqual(out.seats.map((s) => s.penaltyPoints.toFixed(1)),
    ['0.0', '0.0', '0.0', '0.0']);
});

/* ------------------------------------------------------------- standings */

const rec = (id, name, scores, places, extra = {}) => playerRecord({
  playerId: id, name, hanchanScores: scores, placements: places, ...extra,
});

test('ranks by score', () => {
  const t = buildStandings(new ScoreRules(), [
    rec(1, 'A', [10], [2]), rec(2, 'B', [30], [1]), rec(3, 'C', [-40], [4]),
  ]);
  assert.deepEqual(t.map((s) => s.name), ['B', 'A', 'C']);
  assert.deepEqual(t.map((s) => s.rank), [1, 2, 3]);
});

test('tiebreak: most firsts, then fewest fourths', () => {
  let t = buildStandings(new ScoreRules(), [
    rec(1, 'A', [10, 10], [1, 4]), rec(2, 'B', [10, 10], [2, 2]),
  ]);
  assert.equal(t[0].name, 'A');

  t = buildStandings(new ScoreRules(), [
    rec(1, 'A', [10, 10], [1, 4]), rec(2, 'B', [10, 10], [1, 3]),
  ]);
  assert.equal(t[0].name, 'B');
});

test('tiebreak: best single hanchan', () => {
  const t = buildStandings(new ScoreRules(), [
    rec(1, 'A', [30, -10], [1, 3]), rec(2, 'B', [25, -5], [1, 3]),
  ]);
  assert.equal(t[0].name, 'A');
});

test('an unbreakable tie is flagged for a coin toss', () => {
  const t = buildStandings(new ScoreRules(), [rec(1, 'A', [10], [1]), rec(2, 'B', [10], [1])]);
  assert.ok(t.every((s) => s.needsCoinToss));
  assert.deepEqual(t.map((s) => s.rank), [1, 1]);
});

test('a manual tiebreak resolves it', () => {
  const t = buildStandings(new ScoreRules(), [
    rec(1, 'A', [10], [1]), rec(2, 'B', [10], [1], { manualTiebreak: 1 }),
  ]);
  assert.equal(t[0].name, 'B');
  assert.ok(!t.some((s) => s.needsCoinToss));
});

test('penalties come off the total', () => {
  const t = buildStandings(new ScoreRules(), [rec(1, 'A', [10], [1], { penalties: [30] })]);
  assert.equal(t[0].tournamentScore.toString(), '-20');
});

test('byes add score without a placement', () => {
  const t = buildStandings(new ScoreRules(),
    [rec(1, 'A', [10], [1], { byeScores: [0, 0] })]);
  assert.equal(t[0].hanchanPlayed, 1);
  assert.equal(t[0].byes, 2);
  assert.equal(t[0].tournamentScore.toString(), '10');
});

test('carry-over is included', () => {
  const t = buildStandings(new ScoreRules(), [rec(1, 'A', [10], [1], { carryOver: 25 })]);
  assert.equal(t[0].tournamentScore.toString(), '35');
});

/* --------------------------------------------------------- rule guarding */

test('uma length must match the table size', () => {
  assert.throws(() => new ScoreRules({ uma: [15, 5, -5] }), RulesError);
});

test('an unknown tie mode is rejected', () => {
  assert.throws(() => new ScoreRules({ tieMode: 'nonsense' }), RulesError);
});

test('a goal below the start is rejected', () => {
  assert.throws(() => new ScoreRules({ startingPoints: 30000, goalPoints: 25000 }), RulesError);
});

test('rules round-trip through JSON', () => {
  const rules = new ScoreRules({
    startingPoints: 25000, goalPoints: 30000, uma: [20, 10, -10, -20],
  });
  const again = ScoreRules.fromJSON(JSON.parse(JSON.stringify(rules)));
  assert.deepEqual(again.toJSON(), rules.toJSON());
});

/* ------------------------------------------------------------- rulesets */

/* These numbers decide tournaments, so they are pinned to the documents they
 * were quoted from rather than left to look reasonable. */

test('every ruleset preset is complete and cites a source', () => {
  const ids = Object.keys(RULESET_PRESETS);
  assert.ok(ids.length >= 4, 'expected several presets');
  for (const id of ids) {
    const p = RULESET_PRESETS[id];
    assert.ok(p.label, `${id} has no label`);
    assert.ok(p.source && p.source.trim(), `${id} cites no source document`);
    assert.equal(typeof p.rules, 'object', `${id} has no rules`);
  }
});

test('every preset builds a usable ScoreRules', () => {
  for (const [id, preset] of Object.entries(RULESET_PRESETS)) {
    const rules = new ScoreRules(preset.rules);
    // MCR players start from zero rather than a stack, so its table total is
    // legitimately 0 -- the check is that it follows from the start, not that
    // it is positive.
    assert.equal(rules.tableTotal, rules.startingPoints * rules.playersPerTable,
      `${id}: table total does not follow from the starting points`);
    assert.equal(rules.playersPerTable, 4);
  }
});

test('WRC 2025 is 30,000 flat with uma 15/5/-5/-15 and chombo 30', () => {
  const rules = new ScoreRules(RULESET_PRESETS.wrc2025.rules);
  assert.equal(rules.startingPoints, 30000);
  assert.equal(rules.goalPoints, 30000);
  assert.deepEqual(rules.uma.map((u) => u.toString()), ['15', '5', '-5', '-15']);
  assert.equal(rules.chomboPenalty.toString(), '30');
  assert.equal(rules.tableTotal, 120000);
});

/* EMA Riichi Competition Rules, April 2016. Quotes in scoring.js. */
test('EMA RCR matches the 2016 rulebook', () => {
  const rules = new ScoreRules(RULESET_PRESETS.ema_rcr.rules);

  // "subtract the 30,000 points they began the game with"
  assert.equal(rules.startingPoints, 30000);
  assert.equal(rules.goalPoints, 30000, 'RCR has no oka, so goal == start');

  // "Winner receives 15,000 ... second 5,000 ... third -5,000 ... last -15,000"
  assert.deepEqual(rules.uma.map((u) => u.toString()), ['15', '5', '-5', '-15']);

  // "the chombo penalty is 20,000 points ... deducted from the player's
  // overall tournament score ... after the uma is added"
  assert.equal(rules.chomboPenalty.toString(), '20',
    'RCR deducts 20,000 for a chombo, not WRC 2025\'s 30,000');
  assert.equal(rules.chomboMode, 'tournament_penalty',
    'the deduction is from the tournament score, not paid at the table');

  // "If there is a tie, the points for the relevant places are split"
  assert.equal(rules.tieMode, 'split');
});

test('RCR differs from WRC 2025 in exactly one number', () => {
  const a = new ScoreRules(RULESET_PRESETS.wrc2025.rules).toJSON();
  const b = new ScoreRules(RULESET_PRESETS.ema_rcr.rules).toJSON();
  const differing = Object.keys(a).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
  assert.deepEqual(differing, ['chomboPenalty'],
    `expected only the chombo penalty to differ, got: ${differing.join(', ')}`);
});

test("the RCR tie split gives the rulebook's own worked figure", () => {
  // "if two players are tied at the first position, each gets a bonus of
  // 10,000 points" -- the 15 and the 5 pooled and halved.
  const rules = new ScoreRules(RULESET_PRESETS.ema_rcr.rules);
  const out = scoreTable(rules, tableScore({
    tableNumber: 1,
    seats: [
      seatScore({ playerId: 1, seat: 0, rawScore: 40000 }),
      seatScore({ playerId: 2, seat: 1, rawScore: 40000 }),
      seatScore({ playerId: 3, seat: 2, rawScore: 25000 }),
      seatScore({ playerId: 4, seat: 3, rawScore: 15000 }),
    ],
  }));
  const by = new Map(out.seats.map((s) => [s.playerId, s]));
  assert.equal(by.get(1).uma.toString(), '10', 'tied first should get 10, not 15');
  assert.equal(by.get(2).uma.toString(), '10');
  assert.equal(by.get(3).uma.toString(), '-5');
  assert.equal(by.get(4).uma.toString(), '-15');
  // Still zero-sum.
  const total = out.seats.reduce((a, s) => a.add(s.hanchanScore), R(0));
  assert.equal(total.toString(), '0');
});

test('an RCR chombo takes 20 off the tournament score, not 30', () => {
  const rules = new ScoreRules(RULESET_PRESETS.ema_rcr.rules);
  const plain = scoreTable(rules, tableScore({
    tableNumber: 1,
    seats: [
      seatScore({ playerId: 1, seat: 0, rawScore: 45000 }),
      seatScore({ playerId: 2, seat: 1, rawScore: 32000 }),
      seatScore({ playerId: 3, seat: 2, rawScore: 25000 }),
      seatScore({ playerId: 4, seat: 3, rawScore: 18000 }),
    ],
  }));
  const withChombo = scoreTable(rules, tableScore({
    tableNumber: 1,
    seats: [
      seatScore({ playerId: 1, seat: 0, rawScore: 45000, chombo: 1 }),
      seatScore({ playerId: 2, seat: 1, rawScore: 32000 }),
      seatScore({ playerId: 3, seat: 2, rawScore: 25000 }),
      seatScore({ playerId: 4, seat: 3, rawScore: 18000 }),
    ],
  }));

  const before = plain.seats.find((s) => s.playerId === 1);
  const after = withChombo.seats.find((s) => s.playerId === 1);

  // The points at the table do not move: a chombo is a tournament penalty.
  assert.equal(after.scoreDelta.toString(), before.scoreDelta.toString(),
    'a chombo must not change the points in front of the players');
  assert.equal(after.penaltyPoints.toString(), '20',
    'RCR takes 20 for a chombo');

  // And under WRC the same table takes 30, which is the whole difference.
  const wrc = new ScoreRules(RULESET_PRESETS.wrc2025.rules);
  const wrcOut = scoreTable(wrc, tableScore({
    tableNumber: 1,
    seats: [
      seatScore({ playerId: 1, seat: 0, rawScore: 45000, chombo: 1 }),
      seatScore({ playerId: 2, seat: 1, rawScore: 32000 }),
      seatScore({ playerId: 3, seat: 2, rawScore: 25000 }),
      seatScore({ playerId: 4, seat: 3, rawScore: 18000 }),
    ],
  }));
  assert.equal(wrcOut.seats.find((s) => s.playerId === 1).penaltyPoints.toString(), '30');
});

/* ------------------------------------------------- Saikouisen and MCR */

test('Saikouisen matches what the rulebook and rules page do state', () => {
  const rules = new ScoreRules(RULESET_PRESETS.saikouisen.rules);

  // Rules page: "No Oka". With no oka the goal must equal the start, which is
  // what keeps the table zero-sum.
  assert.equal(rules.goalPoints, rules.startingPoints, 'Saikouisen has no oka');
  assert.equal(rules.oka.toString(), '0');

  // Rules page: "Uma (Placement Points) 10000 Points - 30000 Points".
  assert.deepEqual(rules.uma.map((u) => u.toString()), ['30', '10', '-10', '-30']);

  // Rulebook Article 54: "A deduction of 20 Points from the total points of
  // the player with the penalty."
  assert.equal(rules.chomboPenalty.toString(), '20');
  assert.equal(rules.chomboMode, 'tournament_penalty');
});

test('the Saikouisen starting stack only moves the total check, not any score', () => {
  // The rulebook does not state a starting stack, so the preset picks one.
  // This test is the reason that is defensible: with no oka, changing it
  // changes what a table must add up to and nothing else.
  const seats = (base) => [
    seatScore({ playerId: 1, seat: 0, rawScore: base + 15000 }),
    seatScore({ playerId: 2, seat: 1, rawScore: base + 2000 }),
    seatScore({ playerId: 3, seat: 2, rawScore: base - 5000 }),
    seatScore({ playerId: 4, seat: 3, rawScore: base - 12000 }),
  ];
  const at = (start) => {
    const rules = new ScoreRules({
      ...RULESET_PRESETS.saikouisen.rules, startingPoints: start, goalPoints: start,
    });
    const out = scoreTable(rules, tableScore({ tableNumber: 1, seats: seats(start) }));
    assert.ok(out.ok, `a balanced table at ${start} should be accepted`);
    return out.seats
      .sort((a, b) => a.placement - b.placement)
      .map((s) => s.hanchanScore.toString());
  };

  assert.deepEqual(at(25000), at(30000),
    'the starting stack must not change anybody\'s hanchan score');
  assert.equal(new ScoreRules({
    ...RULESET_PRESETS.saikouisen.rules, startingPoints: 25000, goalPoints: 25000,
  }).tableTotal, 100000);
});

test('a Saikouisen table is zero-sum, ties included', () => {
  const rules = new ScoreRules(RULESET_PRESETS.saikouisen.rules);
  const out = scoreTable(rules, tableScore({
    tableNumber: 1,
    seats: [
      seatScore({ playerId: 1, seat: 0, rawScore: 40000 }),
      seatScore({ playerId: 2, seat: 1, rawScore: 40000 }),
      seatScore({ playerId: 3, seat: 2, rawScore: 25000 }),
      seatScore({ playerId: 4, seat: 3, rawScore: 15000 }),
    ],
  }));
  // 30 and 10 pooled between the two tied at the top: 20 each.
  const tied = out.seats.filter((s) => s.placement === 1);
  assert.equal(tied.length, 2);
  for (const s of tied) assert.equal(s.uma.toString(), '20');
  assert.equal(sum(out.seats.map((s) => s.hanchanScore)).toString(), '0');
});

/* MCR -- a different game, and the only ruleset here that is not riichi. */

test('MCR scores by table points, not by points plus uma', () => {
  const rules = new ScoreRules(RULESET_PRESETS.mcr.rules);
  assert.equal(rules.scoringModel, 'table_points');
  assert.equal(rules.usesPointDelta, false);
  assert.equal(rules.startingPoints, 0, 'MCR players start from zero, not a stack');
  assert.equal(rules.tableTotal, 0, 'MCR hands are zero-sum, so a session totals 0');
  assert.equal(rules.pointDivisor, 1, 'MCR counts its points as they stand');

  const out = scoreTable(rules, tableScore({
    tableNumber: 1,
    seats: [
      seatScore({ playerId: 1, seat: 0, rawScore: 120 }),
      seatScore({ playerId: 2, seat: 1, rawScore: 40 }),
      seatScore({ playerId: 3, seat: 2, rawScore: -30 }),
      seatScore({ playerId: 4, seat: 3, rawScore: -130 }),
    ],
  }));
  assert.ok(out.ok, out.issues.map((i) => i.message).join(' '));

  const byPlace = new Map(out.seats.map((s) => [s.placement, s]));
  // Green Book 3.9.2: 4 / 2 / 1 / 0 by rank.
  assert.equal(byPlace.get(1).hanchanScore.toString(), '4');
  assert.equal(byPlace.get(2).hanchanScore.toString(), '2');
  assert.equal(byPlace.get(3).hanchanScore.toString(), '1');
  assert.equal(byPlace.get(4).hanchanScore.toString(), '0');

  // The raw points survive as the tiebreak and are NOT folded into the score.
  assert.equal(byPlace.get(1).scoreDelta.toString(), '120');
  assert.notEqual(byPlace.get(1).hanchanScore.toString(),
    byPlace.get(1).scoreDelta.toString());
});

test('MCR does not warn about scores that are not multiples of 100', () => {
  // Riichi scores move in hundreds; MCR's move in ones. The old check would
  // have flagged every single MCR table.
  const rules = new ScoreRules(RULESET_PRESETS.mcr.rules);
  const out = scoreTable(rules, tableScore({
    tableNumber: 1,
    seats: [
      seatScore({ playerId: 1, seat: 0, rawScore: 88 }),
      seatScore({ playerId: 2, seat: 1, rawScore: 16 }),
      seatScore({ playerId: 3, seat: 2, rawScore: -8 }),
      seatScore({ playerId: 4, seat: 3, rawScore: -96 }),
    ],
  }));
  assert.deepEqual(out.issues.filter((i) => i.code === 'score_granularity'), []);
  assert.ok(out.ok);
});

test('MCR still refuses a session that does not come to zero', () => {
  const rules = new ScoreRules(RULESET_PRESETS.mcr.rules);
  const out = scoreTable(rules, tableScore({
    tableNumber: 1,
    seats: [
      seatScore({ playerId: 1, seat: 0, rawScore: 120 }),
      seatScore({ playerId: 2, seat: 1, rawScore: 40 }),
      seatScore({ playerId: 3, seat: 2, rawScore: -30 }),
      seatScore({ playerId: 4, seat: 3, rawScore: -100 }),
    ],
  }));
  assert.equal(out.ok, false, 'a session that does not balance must be refused');
  assert.ok(out.issues.some((i) => i.code === 'table_total' && i.severity === 'error'));
});

test('MCR table points are not expected to sum to zero', () => {
  // 4 + 2 + 1 + 0 = 7. The riichi coherency check would have called that an
  // error on every table, so it has to be a riichi-only check.
  const rules = new ScoreRules(RULESET_PRESETS.mcr.rules);
  const out = scoreTable(rules, tableScore({
    tableNumber: 1,
    seats: [
      seatScore({ playerId: 1, seat: 0, rawScore: 120 }),
      seatScore({ playerId: 2, seat: 1, rawScore: 40 }),
      seatScore({ playerId: 3, seat: 2, rawScore: -30 }),
      seatScore({ playerId: 4, seat: 3, rawScore: -130 }),
    ],
  }));
  assert.equal(sum(out.seats.map((s) => s.hanchanScore)).toString(), '7');
  assert.deepEqual(out.issues.filter((i) => i.code === 'score_residual'), [],
    'the zero-sum check must not apply to table points');
});

test('MCR ranks on table points and breaks ties on contest points', () => {
  // Green Book 3.10.1. Two players on the same table points; the one with more
  // raw points ranks higher.
  const rules = new ScoreRules(RULESET_PRESETS.mcr.rules);
  const mk = (playerId, sessions) => playerRecord({
    playerId,
    name: `P${playerId}`,
    hanchanScores: sessions.map(([tablePoints]) => R(tablePoints)),
    deltas: sessions.map(([, raw]) => R(raw)),
    placements: sessions.map(() => 1),
  });

  const standings = buildStandings(rules, [
    mk(1, [[4, 50], [2, 10]]),   // 6 table points, 60 contest points
    mk(2, [[4, 200], [2, 30]]),  // 6 table points, 230 contest points
    mk(3, [[4, 10], [4, 10]]),   // 8 table points
  ]);

  assert.equal(standings[0].playerId, 3, 'most table points ranks first');
  assert.equal(standings[1].playerId, 2, 'tied on table points, more contest points wins');
  assert.equal(standings[2].playerId, 1);
  // Rationals are objects, so compare their values, not their identities.
  assert.equal(standings[1].tournamentScore.toString(), standings[2].tournamentScore.toString(),
    'those two really are level on table points');
  assert.equal(standings[0].tournamentScore.toString(), '8');
});

test('every preset round-trips through toJSON', () => {
  for (const [id, preset] of Object.entries(RULESET_PRESETS)) {
    const a = new ScoreRules(preset.rules);
    const b = new ScoreRules(a.toJSON());
    assert.deepEqual(b.toJSON(), a.toJSON(), `${id} does not survive a round trip`);
  }
});

test('an unknown scoring model is refused rather than ignored', () => {
  assert.throws(() => new ScoreRules({ scoringModel: 'vibes' }), /unknown scoringModel/);
  assert.throws(() => new ScoreRules({ placementPoints: ['1', '2'] }),
    /placementPoints has 2 entries/);
  assert.throws(() => new ScoreRules({ pointDivisor: 0 }), /pointDivisor/);
  assert.throws(() => new ScoreRules({ scoreStep: -5 }), /scoreStep/);
});
