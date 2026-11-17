/* Scoring engine -- World Riichi Championship 2025.
 *
 * A direct port of mahjong/scoring.py. The formulas, the tie handling and the
 * coherency checks are the rulebook's, and the two worked examples from the WRC
 * Optional Rules extension are pinned as tests.
 *
 *   score delta      = (player score - goal) / 1,000
 *   hanchan score    = (player score - goal) / 1,000 + uma [+ oka]
 *   tournament score = sum of hanchan scores - point penalties
 *
 * Coherency (WRC Rules 2025, 10.3):
 *   - players' scores + 1,000 x remaining riichi deposits == starting x seats
 *   - the uma sums to zero
 *   - the hanchan scores + the number of remaining deposits == zero
 *
 * Everything here is pure: facts in (raw scores, deposits, penalties), derived
 * values out. Nothing derived is stored, so changing a rule and recomputing is
 * always consistent across a whole event.
 *
 * ---------------------------------------------------------------------------
 * START HERE. Five functions do all the work, in this order:
 *
 *   validateTable()   the three coherency checks above. This is what refuses a
 *                     table that does not add up to 120,000.
 *   placementsFor()   who came 1st to 4th, and who tied.
 *   scoreTable()      the main event: delta, uma, oka, hanchan score, per seat.
 *                     The tie handling is the subtle part -- see below.
 *   playerRecord()    one player's hanchan gathered into a tournament record.
 *   buildStandings()  the ranking, including the tiebreak chain.
 *
 * The one piece of arithmetic that catches people out is the tie split, inside
 * scoreTable(). When players tie, the uma for the places they share is pooled
 * and divided between them, and any oka is added to that pool BEFORE the
 * division, not after. The result is then truncated to one decimal place
 * rather than rounded, which is why a tied table can legitimately come out a
 * tenth or two away from zero.
 *
 * That is also why rational.js exists. Doing this in floating point would be
 * wrong in the fourth decimal and nobody would notice until a tie decided a
 * final. Every value here is an exact fraction of two BigInts, and BigInt
 * division truncates toward zero, which is precisely the rulebook's rounding
 * rule.
 * ---------------------------------------------------------------------------
 */
(function () {
'use strict';

/* eslint-disable no-undef */
const _rat = (typeof require === 'function')
  ? require('./rational.js')
  : window.RT.rational;
const { Rational, R, sum } = _rat;

const SEAT_WINDS = ['E', 'S', 'W', 'N'];
const SEAT_WIND_NAMES = { E: 'East', S: 'South', W: 'West', N: 'North' };

const TIEBREAK_KEYS = [
  'score', 'firsts', 'fewest_fourths', 'best_hanchan',
  'avg_placement', 'raw_delta', 'seconds', 'manual',
];

// "manual" always ends the chain: it is 0 for everyone until the organiser
// sets one, and it is how a coin toss gets recorded.
const DEFAULT_TIEBREAKS = ['score', 'firsts', 'fewest_fourths', 'best_hanchan', 'manual'];

const TRUNCATE = 'truncate';
const HALF_UP = 'half_up';

/* ------------------------------------------------------- scoring models ---
 *
 * Two shapes of tournament scoring, because not every ruleset this program
 * supports is riichi.
 *
 *   RIICHI        hanchan score = (points - goal) / divisor + uma [+ oka].
 *                 The table is zero-sum. WRC, EMA RCR, Saikouisen.
 *
 *   TABLE_POINTS  hanchan score = the placement bonus alone, 4/2/1/0 by rank.
 *                 The raw points still matter, but only as the tiebreak.
 *                 Chinese Official (MCR), as MERS tournaments score it.
 *
 * In TABLE_POINTS the hanchan score is NOT delta + uma: the delta is carried
 * separately and never added in. That is the one place these two models
 * genuinely disagree, so it is worth stating rather than discovering.
 */
const RIICHI = 'riichi';
const TABLE_POINTS = 'table_points';
const SCORING_MODELS = [RIICHI, TABLE_POINTS];

/* ------------------------------------------------------------- rulesets ---
 *
 * The published rulesets an organiser can start from, as data, so the numbers
 * can be checked against the documents they came from. Every one of them is
 * editable afterwards on the Setup tab: these are starting points, not a
 * closed list.
 *
 * Each `source` names the document the numbers are quoted from. If you add a
 * ruleset, cite one — a scoring number nobody can trace is worse than no
 * preset at all, because it decides tournaments silently.
 */
const RULESET_PRESETS = {
  wrc2025: {
    label: 'WRC 2025',
    source: 'World Riichi Championship Rules 2025',
    rules: { startingPoints: 30000, goalPoints: 30000, uma: ['15', '5', '-5', '-15'] },
  },

  /* European Mahjong Association, "Riichi — Rules for Japanese Mahjong",
   * April 2016. Identical to WRC 2025 but for the chombo penalty:
   *
   *   "the players count their scores and subtract the 30,000 points they
   *    began the game with"
   *   "Winner receives 15,000 points, second ranked player receives 5,000
   *    points, third ranked player is penalized with -5,000 and the last
   *    player is penalized with -15,000"
   *   "If there is a tie, the points for the relevant places are split
   *    between the tied players"
   *   "In a tournament the chombo penalty is 20,000 points which are deducted
   *    from the player's overall tournament score after the game is finished,
   *    and after the uma is added"
   *
   * One difference this program does not need to model: under RCR riichi bets
   * left at the end of a hanchan go to the winner, where WRC 2025 leaves them
   * on the table. Either way the scores plus any sticks still come to the
   * table total, which is what gets checked. */
  ema_rcr: {
    label: 'EMA RCR 2016',
    source: 'EMA Riichi Competition Rules, April 2016',
    rules: {
      startingPoints: 30000,
      goalPoints: 30000,
      uma: ['15', '5', '-5', '-15'],
      chomboPenalty: '20',
    },
  },

  /* Saikouisen Nihon Pro Mahjong Kyoukai, Competition Rules 1.12
   * (8 June 2026), with the scoring settings from saikouisen-usa.com/rules.
   *
   * Quoted from the rulebook:
   *   "A deduction of 20 Points from the total points of the player with the
   *    penalty"                                        (Chonbo, Article 54)
   *   "if no one has yet collected the Kyoutaku at the end of the Hanchan,
   *    the Kyoutaku will be left on the table"         (Article 39)
   *   "Ton-Ba and Nan-Ba combined together are collectively called a Hanchan"
   *
   * From the rules page:
   *   "No Oka"
   *   "Uma (Placement Points) 10000 Points - 30000 Points"
   *
   * NOT stated in either: the starting stack. The rulebook is a rulebook for
   * playing, and ends at Article 55 without one; the site says the rules "may
   * vary" by event. 30,000 is the Japanese professional convention and is used
   * here as a starting point, not as a quoted figure.
   *
   * With no oka the goal equals the start, so the table is zero-sum whatever
   * that number is: the start only decides what a table must add up to
   * (4 x 30,000 = 120,000). Change it on the Setup tab if your event differs
   * and the scores will be unaffected -- only the total check moves. */
  saikouisen: {
    label: 'Saikouisen',
    source: 'Saikouisen Competition Rules 1.12; start point not stated upstream',
    rules: {
      startingPoints: 30000,
      goalPoints: 30000,
      uma: ['30', '10', '-10', '-30'],
      chomboPenalty: '20',
    },
  },

  /* Chinese Official, as MERS tournaments in Europe score it.
   *
   * A different game and a different shape of scoring: there is no riichi, no
   * uma and no oka, and the hanchan score is a flat rank bonus rather than
   * anything derived from the points.
   *
   * Mahjong Competition Rules ("the Green Book", WMO 2006) 3.9.2:
   *   "After four rounds have been played or the allotted time for a game
   *    session has run out, all points of all played hands are added to
   *    determine the high scorer ... The high scorer for the game is awarded
   *    4 Table points. The second-place scorer is awarded 2 Table points. The
   *    third-place scorer is awarded 1 Table point. The low scorer earns 0
   *    points for the game session."
   *
   * And 3.10.1, which is why the tiebreak is the raw points:
   *   "Players are ranked based on Table Points gained during the competition.
   *    In a case in which multiple players have equal Table Points, the player
   *    who earned the most Contest Points ranks higher. (Contest Points are
   *    the sum of all scores earned by the player during each game session.)"
   *
   * Hands are zero-sum -- a win by discard takes basic+8 from the discarder
   * and 8 from each other player -- so a session's four scores come to 0, and
   * players are entered as starting from 0 rather than from a stack.
   *
   * The Green Book does not say what happens when two players finish a session
   * level. The places they share are pooled and split, which is what this
   * program does everywhere else; set it to seat order on the Setup tab if
   * your tournament rules otherwise. */
  mcr: {
    label: 'MCR (Chinese Official)',
    source: 'MCR "Green Book" (WMO 2006) 3.9.2 and 3.10.1; MERS regulations',
    rules: {
      scoringModel: TABLE_POINTS,
      startingPoints: 0,
      goalPoints: 0,
      pointDivisor: 1,
      scoreStep: 1,
      scorePrecision: 0,
      placementPoints: ['4', '2', '1', '0'],
      uma: ['0', '0', '0', '0'],
      chomboPenalty: '0',
      tiebreaks: ['score', 'raw_delta', 'manual'],
    },
  },

  oka: {
    label: 'WRC + oka',
    source: 'WRC Optional Rules extension',
    rules: { startingPoints: 25000, goalPoints: 30000, uma: ['15', '5', '-5', '-15'] },
  },

  redfives: {
    label: 'Red fives',
    source: 'common club practice; not a published ruleset',
    rules: { startingPoints: 30000, goalPoints: 30000, uma: ['30', '10', '-10', '-30'] },
  },

  custom: {
    label: 'Custom',
    source: 'whatever you set it to',
    rules: {},
  },
};

class RulesError extends Error {}

/* ------------------------------------------------------------------ rules */

class ScoreRules {
  constructor(options = {}) {
    const o = options || {};
    this.startingPoints = o.startingPoints ?? 30000;
    this.goalPoints = o.goalPoints ?? 30000;
    this.playersPerTable = o.playersPerTable ?? 4;
    this.uma = (o.uma ?? [15, 5, -5, -15]).map((u) => R(u));
    this.scoringModel = o.scoringModel ?? RIICHI;
    // Used only by TABLE_POINTS: what each finishing place is worth.
    this.placementPoints = (o.placementPoints ?? [4, 2, 1, 0]).map((v) => R(v));
    // What raw points are divided by to reach tournament units. Riichi scores
    // in thousands; MCR counts its points as they stand.
    this.pointDivisor = o.pointDivisor ?? 1000;
    // Riichi scores move in hundreds; MCR's move in ones. A score that is not
    // a multiple of this is flagged as probably mistyped.
    this.scoreStep = o.scoreStep ?? 100;
    this.tieMode = o.tieMode ?? 'split';
    this.scorePrecision = o.scorePrecision ?? 1;
    this.scoreRounding = o.scoreRounding ?? TRUNCATE;
    this.chomboMode = o.chomboMode ?? 'tournament_penalty';
    this.chomboPenalty = R(o.chomboPenalty ?? 30);
    this.byeMode = o.byeMode ?? 'fixed';
    this.byeScore = R(o.byeScore ?? 0);
    this.tiebreaks = [...(o.tiebreaks ?? DEFAULT_TIEBREAKS)];
    this.validate();
    Object.freeze(this);
  }

  validate() {
    if (this.playersPerTable < 2) {
      throw new RulesError('playersPerTable must be at least 2');
    }
    if (this.uma.length !== this.playersPerTable) {
      throw new RulesError(
        `uma has ${this.uma.length} entries but tables seat ${this.playersPerTable} players`
      );
    }
    if (!SCORING_MODELS.includes(this.scoringModel)) {
      throw new RulesError(`unknown scoringModel: ${this.scoringModel}`);
    }
    if (this.placementPoints.length !== this.playersPerTable) {
      throw new RulesError(
        `placementPoints has ${this.placementPoints.length} entries `
        + `but tables seat ${this.playersPerTable} players`);
    }
    if (!Number.isInteger(this.pointDivisor) || this.pointDivisor < 1) {
      throw new RulesError('pointDivisor must be a positive whole number');
    }
    if (!Number.isInteger(this.scoreStep) || this.scoreStep < 1) {
      throw new RulesError('scoreStep must be a positive whole number');
    }
    if (!['split', 'seat_order'].includes(this.tieMode)) {
      throw new RulesError(`unknown tieMode: ${this.tieMode}`);
    }
    if (![TRUNCATE, HALF_UP].includes(this.scoreRounding)) {
      throw new RulesError(`unknown scoreRounding: ${this.scoreRounding}`);
    }
    if (!['tournament_penalty', 'table_payment'].includes(this.chomboMode)) {
      throw new RulesError(`unknown chomboMode: ${this.chomboMode}`);
    }
    if (!['fixed', 'average'].includes(this.byeMode)) {
      throw new RulesError(`unknown byeMode: ${this.byeMode}`);
    }
    if (this.scorePrecision < 0 || this.scorePrecision > 9) {
      throw new RulesError('scorePrecision must be between 0 and 9');
    }
    for (const key of this.tiebreaks) {
      if (!TIEBREAK_KEYS.includes(key)) {
        throw new RulesError(`unknown tiebreak key: ${key}`);
      }
    }
    if (this.goalPoints < this.startingPoints) {
      throw new RulesError('goalPoints cannot be below startingPoints');
    }
  }

  /** Points that must be on the table at the end of a hanchan. */
  get tableTotal() {
    return this.startingPoints * this.playersPerTable;
  }

  /**
   * Oka in P, awarded to the winner(s).
   * The gap between the start and the goal, pooled across the table
   * (WRC Optional Rules, Mod.4.2).
   */
  get oka() {
    if (this.scoringModel !== RIICHI) return R(0);
    const gap = this.goalPoints - this.startingPoints;
    return new Rational(BigInt(gap * this.playersPerTable), BigInt(this.pointDivisor));
  }

  /** True when the hanchan score is points-based rather than a flat rank bonus. */
  get usesPointDelta() {
    return this.scoringModel === RIICHI;
  }

  /** The bonus pool for a finishing place: uma, or the table points. */
  get placementTable() {
    return this.usesPointDelta ? this.uma : this.placementPoints;
  }

  get umaSum() {
    return sum(this.uma);
  }

  /** Reduce an exact value to the configured display precision. */
  quantize(value) {
    const v = R(value);
    return this.scoreRounding === TRUNCATE
      ? v.truncate(this.scorePrecision)
      : v.roundHalfUp(this.scorePrecision);
  }

  format(value) {
    return this.quantize(value).toFixed(this.scorePrecision);
  }

  toJSON() {
    return {
      startingPoints: this.startingPoints,
      goalPoints: this.goalPoints,
      uma: this.uma.map((u) => u.toString()),
      scoringModel: this.scoringModel,
      placementPoints: this.placementPoints.map((v) => v.toString()),
      pointDivisor: this.pointDivisor,
      scoreStep: this.scoreStep,
      playersPerTable: this.playersPerTable,
      tieMode: this.tieMode,
      scorePrecision: this.scorePrecision,
      scoreRounding: this.scoreRounding,
      chomboMode: this.chomboMode,
      chomboPenalty: this.chomboPenalty.toString(),
      byeMode: this.byeMode,
      byeScore: this.byeScore.toString(),
      tiebreaks: [...this.tiebreaks],
    };
  }

  static fromJSON(data = {}) {
    return new ScoreRules(data || {});
  }

  with(changes) {
    return new ScoreRules({ ...this.toJSON(), ...changes });
  }
}

/* ----------------------------------------------------------------- inputs */

/** One player's reported result at one table. */
function seatScore({ playerId, seat, rawScore, chombo = 0, penaltyPoints = 0, penaltyNote = '' }) {
  return {
    playerId,
    seat,
    rawScore: Number(rawScore),
    chombo: Number(chombo) || 0,
    penaltyPoints: R(penaltyPoints || 0),
    penaltyNote: penaltyNote || '',
  };
}

/** A whole table's reported result for one hanchan. */
function tableScore({ tableNumber, seats, riichiLeft = 0 }) {
  return { tableNumber, seats, riichiLeft: Number(riichiLeft) || 0 };
}

const issue = (code, message, severity = 'error') => ({ code, message, severity });

const commas = (n) => Number(n).toLocaleString('en-US');

/* ------------------------------------------------------------- validation */

/**
 * Check a reported table result for coherency, the way a referee checks a
 * report sheet before signing it.
 */
function validateTable(rules, table, { strictSeats = true } = {}) {
  const issues = [];
  const seats = table.seats;
  const expected = rules.playersPerTable;

  if (seats.length !== expected) {
    issues.push(issue('seat_count',
      `Table ${table.tableNumber} has ${seats.length} players, expected ${expected}.`));
  }

  if (strictSeats) {
    const indexes = seats.map((s) => s.seat);
    if (new Set(indexes).size !== indexes.length) {
      issues.push(issue('duplicate_seat',
        `Table ${table.tableNumber} has two players in the same seat.`));
    }
    for (const s of seats) {
      if (!(s.seat >= 0 && s.seat < expected)) {
        issues.push(issue('bad_seat', `Seat index ${s.seat} is out of range.`));
      }
    }
  }

  const ids = seats.map((s) => s.playerId);
  if (new Set(ids).size !== ids.length) {
    issues.push(issue('duplicate_player',
      `Table ${table.tableNumber} lists the same player twice.`));
  }

  if (table.riichiLeft < 0) {
    issues.push(issue('negative_deposits', 'Riichi deposits cannot be negative.'));
  }

  const total = seats.reduce((a, s) => a + s.rawScore, 0) + 1000 * table.riichiLeft;
  if (seats.length === expected && total !== rules.tableTotal) {
    const diff = total - rules.tableTotal;
    issues.push(issue('table_total',
      `Table ${table.tableNumber} totals ${commas(total)} points `
      + `(including ${table.riichiLeft} riichi stick(s) left on the table) `
      + `but must total ${commas(rules.tableTotal)}. `
      + `Off by ${diff > 0 ? '+' : ''}${commas(diff)}.`));
  }

  for (const s of seats) {
    if (rules.scoreStep > 1 && s.rawScore % rules.scoreStep !== 0) {
      issues.push(issue('score_granularity',
        `Score ${commas(s.rawScore)} is not a multiple of ${commas(rules.scoreStep)}.`,
        'warning'));
    }
    if (s.chombo < 0) {
      issues.push(issue('negative_chombo', 'Chombo count cannot be negative.'));
    }
  }

  return issues;
}

/* ---------------------------------------------------------------- scoring */

/**
 * Placement (1-based) for each seat, in the order given.
 *
 * With "split", players on equal points share the best position of their group
 * and the next player takes the position after the group, so two tied for first
 * are both 1st and the others are 3rd and 4th. With "seat_order", ties break by
 * seat wind (E > S > W > N).
 */
function placementsFor(rules, seats) {
  if (rules.tieMode === 'seat_order') {
    const order = seats.map((s, i) => i).sort((a, b) => {
      const d = seats[b].rawScore - seats[a].rawScore;
      return d !== 0 ? d : seats[a].seat - seats[b].seat;
    });
    const out = new Array(seats.length);
    order.forEach((idx, position) => { out[idx] = position + 1; });
    return out;
  }
  return seats.map((s) => 1 + seats.filter((o) => o.rawScore > s.rawScore).length);
}

/** Compute placements, uma, oka and hanchan scores for one table. */
function scoreTable(rules, table, { validate = true } = {}) {
  const seats = [...table.seats];
  const issues = validate ? validateTable(rules, table) : [];

  const placements = placementsFor(rules, seats);

  // Group seats sharing a placement so their uma -- and the oka, if the group
  // includes first place -- can be split. WRC Optional Rules Mod.4.2: add the
  // uma and the oka together before splitting, to keep the rounding error as
  // small as possible.
  const groups = new Map();
  placements.forEach((place, idx) => {
    if (!groups.has(place)) groups.set(place, []);
    groups.get(place).push(idx);
  });

  const umaShare = new Array(seats.length);
  const okaShare = new Array(seats.length);

  // Riichi splits the uma; MCR splits the table points. Same machinery, since
  // both are "what the places this group shares are worth, divided between
  // them".
  const bonusTable = rules.placementTable;

  for (const [place, members] of groups) {
    const size = members.length;
    let umaTotal = R(0);
    for (let p = place - 1; p < place - 1 + size; p++) {
      if (p >= 0 && p < bonusTable.length) umaTotal = umaTotal.add(bonusTable[p]);
    }
    const okaTotal = place === 1 ? rules.oka : R(0);
    const combined = umaTotal.add(okaTotal).div(R(size));
    const okaEach = okaTotal.div(R(size));
    // Reported separately for the score sheet, but split as one figure so the
    // rounding matches the rules.
    for (const idx of members) {
      umaShare[idx] = combined.sub(okaEach);
      okaShare[idx] = okaEach;
    }
  }

  const outcomes = seats.map((s, idx) => {
    const delta = new Rational(BigInt(s.rawScore - rules.goalPoints),
      BigInt(rules.pointDivisor));
    // Under MCR the hanchan score is the table points alone: the raw points
    // decide the rank and then carry on only as the tiebreak (the Green Book's
    // "Contest Points"), never added into the score itself.
    const total = rules.usesPointDelta
      ? delta.add(umaShare[idx]).add(okaShare[idx])
      : umaShare[idx];
    const chomboPenalty = rules.chomboMode === 'tournament_penalty'
      ? rules.chomboPenalty.mul(R(s.chombo))
      : R(0);
    return {
      playerId: s.playerId,
      seat: s.seat,
      seatWind: SEAT_WINDS[s.seat] ?? '?',
      rawScore: s.rawScore,
      placement: placements[idx],
      sharedPlacement: groups.get(placements[idx]).length > 1,
      scoreDelta: rules.quantize(delta),
      uma: rules.quantize(umaShare[idx]),
      oka: rules.quantize(okaShare[idx]),
      hanchanScore: rules.quantize(total),
      chombo: s.chombo,
      penaltyPoints: rules.quantize(s.penaltyPoints.add(chomboPenalty)),
      penaltyNote: s.penaltyNote,
    };
  });

  // The rules' third coherency check: hanchan scores plus abandoned deposits
  // must come to zero. With a uma that does not divide evenly this can be off
  // by a fraction, which the rules accept, so it is a warning not an error.
  if (validate && rules.usesPointDelta && seats.length === rules.playersPerTable) {
    const totalScores = sum(outcomes.map((o) => o.hanchanScore));
    const residual = totalScores.add(R(table.riichiLeft));
    const totalOk = !issues.some((i) => i.code === 'table_total');
    if (!residual.isZero && totalOk) {
      issues.push(issue('score_residual',
        `Hanchan scores sum to ${totalScores.toFixed(rules.scorePrecision)} with `
        + `${table.riichiLeft} deposit(s) left, leaving `
        + `${residual.toFixed(rules.scorePrecision)} instead of 0. `
        + 'This uma does not divide evenly on a tie; the rules accept the small difference.',
        'warning'));
    }
  }

  return {
    tableNumber: table.tableNumber,
    riichiLeft: table.riichiLeft,
    seats: outcomes,
    issues,
    get ok() { return !issues.some((i) => i.severity === 'error'); },
  };
}

/* -------------------------------------------------------------- standings */

/** Everything that feeds one player's place in the standings. */
function playerRecord({
  playerId, name,
  hanchanScores = [], placements = [], deltas = [], penalties = [],
  byeScores = [], carryOver = 0, manualTiebreak = 0,
}) {
  return {
    playerId,
    name,
    hanchanScores: hanchanScores.map((v) => R(v)),
    placements: [...placements],
    deltas: deltas.map((v) => R(v)),
    penalties: penalties.map((v) => R(v)),
    byeScores: byeScores.map((v) => R(v)),
    carryOver: R(carryOver),
    manualTiebreak: R(manualTiebreak),
  };
}

/** Tournament score: hanchan scores and byes, less penalties. */
function recordTotal(rec) {
  return sum(rec.hanchanScores)
    .add(sum(rec.byeScores))
    .add(rec.carryOver)
    .sub(sum(rec.penalties));
}

function countPlacements(placements) {
  const counts = new Map();
  for (const p of placements) counts.set(p, (counts.get(p) || 0) + 1);
  return counts;
}

function sortKey(rules, rec, score) {
  const counts = countPlacements(rec.placements);
  let chain = rules.tiebreaks;
  if (!chain.includes('manual')) chain = [...chain, 'manual'];
  const key = [];
  for (const name of chain) {
    if (name === 'score') key.push(score.neg());
    else if (name === 'firsts') key.push(R(-(counts.get(1) || 0)));
    else if (name === 'seconds') key.push(R(-(counts.get(2) || 0)));
    else if (name === 'fewest_fourths') key.push(R(counts.get(rules.playersPerTable) || 0));
    else if (name === 'best_hanchan') {
      const best = rec.hanchanScores.length
        ? rec.hanchanScores.reduce((a, b) => (b.gt(a) ? b : a))
        : R(-1000000000);
      key.push(best.neg());
    } else if (name === 'avg_placement') {
      key.push(rec.placements.length
        ? new Rational(BigInt(rec.placements.reduce((a, b) => a + b, 0)),
          BigInt(rec.placements.length))
        : R(rules.playersPerTable));
    } else if (name === 'raw_delta') key.push(sum(rec.deltas).neg());
    else if (name === 'manual') key.push(rec.manualTiebreak.neg());
  }
  return key;
}

function compareKeys(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const c = a[i].cmp(b[i]);
    if (c !== 0) return c;
  }
  return 0;
}

function averagePlacement(placements) {
  if (!placements.length) return null;
  return new Rational(
    BigInt(placements.reduce((a, b) => a + b, 0)),
    BigInt(placements.length)
  );
}

/**
 * Rank players by tournament score, applying the configured tiebreaks.
 *
 * Players left level after every tiebreak are flagged with needsCoinToss, which
 * is WRC's final tiebreaker. Ranking stays deterministic: they are ordered by
 * name and share a rank.
 */
function buildStandings(rules, records) {
  const recs = [...records];
  const totals = new Map(recs.map((r) => [r.playerId, recordTotal(r)]));

  const decorated = recs.map((rec) => ({
    key: sortKey(rules, rec, totals.get(rec.playerId)),
    name: (rec.name || '').toLowerCase(),
    rec,
  }));
  decorated.sort((a, b) => {
    const c = compareKeys(a.key, b.key);
    if (c !== 0) return c;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });

  const standings = [];
  let rank = 0;
  let previousKey = null;
  decorated.forEach(({ key, rec }, index) => {
    if (previousKey === null || compareKeys(key, previousKey) !== 0) {
      rank = index + 1;
      previousKey = key;
    }
    const counts = countPlacements(rec.placements);
    standings.push({
      playerId: rec.playerId,
      name: rec.name,
      rank,
      tournamentScore: totals.get(rec.playerId),
      hanchanPlayed: rec.hanchanScores.length,
      placements: counts,
      firsts: counts.get(1) || 0,
      seconds: counts.get(2) || 0,
      thirds: counts.get(3) || 0,
      fourths: counts.get(4) || 0,
      bestHanchan: rec.hanchanScores.length
        ? rec.hanchanScores.reduce((a, b) => (b.gt(a) ? b : a))
        : null,
      penaltyTotal: sum(rec.penalties),
      rawDelta: sum(rec.deltas),
      byes: rec.byeScores.length,
      byeTotal: sum(rec.byeScores),
      carryOver: rec.carryOver,
      averagePlacement: averagePlacement(rec.placements),
      scores: [...rec.hanchanScores],
      needsCoinToss: false,
      tiedWith: [],
    });
  });

  const byRank = new Map();
  for (const st of standings) {
    if (!byRank.has(st.rank)) byRank.set(st.rank, []);
    byRank.get(st.rank).push(st);
  }
  for (const group of byRank.values()) {
    if (group.length > 1) {
      const ids = group.map((s) => s.playerId);
      for (const st of group) {
        st.needsCoinToss = true;
        st.tiedWith = ids.filter((i) => i !== st.playerId);
      }
    }
  }

  return standings;
}

const API = {
  SEAT_WINDS, SEAT_WIND_NAMES, TIEBREAK_KEYS, DEFAULT_TIEBREAKS, RULESET_PRESETS,
  RIICHI, TABLE_POINTS, SCORING_MODELS,
  ScoreRules, RulesError,
  seatScore, tableScore,
  validateTable, scoreTable, placementsFor,
  playerRecord, recordTotal, buildStandings, averagePlacement,
};

if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof window !== 'undefined') {
  window.RT = window.RT || {};
  window.RT.scoring = API;
}
}());
