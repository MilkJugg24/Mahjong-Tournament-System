/* Seating and pairing engine.
 *
 * A port of mahjong/seating.py.
 *
 * The ARA's Tournament-in-a-Box pairing tool scores a candidate seating by
 * counting how often each pair has already met: a second meeting costs 1, a
 * third 4, a fourth 9. It then shuffles the field at random many times and
 * keeps the best, and its own notes say "winds and relative seating are not
 * handled by the software".
 *
 * This keeps that cost model and adds what the shuffle cannot do: seat winds
 * are balanced, table assignments are spread out (WRC Rules 2025 section 5
 * asks for it), clubs are kept apart, byes rotate fairly, and the search is
 * simulated annealing followed by a sweep that takes every improving swap
 * until none is left.
 *
 * Reproducible from a seed: Math.random cannot be seeded, so the PRNG is here.
 */
(function () {
'use strict';

/** mulberry32 -- small, fast, and good enough for shuffling a tournament. */
function makeRng(seed) {
  let a = (seed >>> 0) || 1;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const randInt = (rng, n) => Math.floor(rng() * n);

function shuffleInPlace(list, rng) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = randInt(rng, i + 1);
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** Relative importance of the competing seating goals. */
const DEFAULT_WEIGHTS = { repeat: 100, wind: 3, table: 1, club: 25 };

/* --------------------------------------------------------------- history */

/** What has happened so far, used to judge a candidate seating. */
class SeatingHistory {
  constructor(playersPerTable = 4) {
    this.playersPerTable = playersPerTable;
    this.met = new Map();      // "a|b" -> times met
    this.winds = new Map();    // playerId -> [count per seat index]
    this.tables = new Map();   // playerId -> Map(tableNumber -> count)
    this.byes = new Map();     // playerId -> count
  }

  meetings(a, b) { return this.met.get(pairKey(a, b)) || 0; }

  windCounts(player) {
    if (!this.winds.has(player)) {
      this.winds.set(player, new Array(this.playersPerTable).fill(0));
    }
    return this.winds.get(player);
  }

  tableCounts(player) {
    if (!this.tables.has(player)) this.tables.set(player, new Map());
    return this.tables.get(player);
  }

  byeCount(player) { return this.byes.get(player) || 0; }

  /** Fold a seating into the history. */
  record(plan) {
    for (const { tableNumber, seats } of plan.numberedTables()) {
      const present = seats.filter((p) => p !== null && p !== undefined);
      for (let i = 0; i < present.length; i++) {
        for (let j = i + 1; j < present.length; j++) {
          const k = pairKey(present[i], present[j]);
          this.met.set(k, (this.met.get(k) || 0) + 1);
        }
      }
      seats.forEach((player, seatIndex) => {
        if (player === null || player === undefined) return;
        const counts = this.windCounts(player);
        if (seatIndex < counts.length) counts[seatIndex] += 1;
        const tc = this.tableCounts(player);
        tc.set(tableNumber, (tc.get(tableNumber) || 0) + 1);
      });
    }
    for (const player of plan.byes) {
      this.byes.set(player, (this.byes.get(player) || 0) + 1);
    }
  }

  static fromPlans(plans, playersPerTable = 4) {
    const h = new SeatingHistory(playersPerTable);
    for (const p of plans) h.record(p);
    return h;
  }

  summary() {
    const values = [...this.met.values()];
    return {
      pairsSeen: this.met.size,
      repeatPairs: values.filter((n) => n > 1).length,
      worstRepeat: values.length ? Math.max(...values) : 0,
      totalByes: [...this.byes.values()].reduce((a, b) => a + b, 0),
    };
  }

  toJSON() {
    return {
      playersPerTable: this.playersPerTable,
      met: [...this.met],
      winds: [...this.winds],
      tables: [...this.tables].map(([p, m]) => [p, [...m]]),
      byes: [...this.byes],
    };
  }

  static fromJSON(data) {
    const h = new SeatingHistory(data.playersPerTable || 4);
    h.met = new Map(data.met || []);
    h.winds = new Map(data.winds || []);
    h.tables = new Map((data.tables || []).map(([p, m]) => [p, new Map(m)]));
    h.byes = new Map(data.byes || []);
    return h;
  }
}

/* ------------------------------------------------------------------ plan */

/**
 * A seating for one round. `tables` holds one array per table; index 0 is
 * East, 1 South, 2 West, 3 North. A null marks a deliberately empty seat.
 */
class SeatingPlan {
  constructor({ tables, byes = [], firstTableNumber = 1, cost = 0, metrics = {} }) {
    this.tables = tables;
    this.byes = byes;
    this.firstTableNumber = firstTableNumber;
    this.cost = cost;
    this.metrics = metrics;
  }

  numberedTables() {
    return this.tables.map((seats, i) => ({
      tableNumber: this.firstTableNumber + i,
      seats,
    }));
  }

  seatOf(player) {
    for (const { tableNumber, seats } of this.numberedTables()) {
      const idx = seats.indexOf(player);
      if (idx !== -1) return { tableNumber, seatIndex: idx };
    }
    return null;
  }

  players() {
    return this.tables.flat().filter((p) => p !== null && p !== undefined);
  }

  toJSON() {
    return {
      tables: this.numberedTables().map((t) => ({ table: t.tableNumber, seats: [...t.seats] })),
      byes: [...this.byes],
      cost: this.cost,
      metrics: this.metrics,
    };
  }
}

/* --------------------------------------------------------------- costing */

function makeEvaluator(history, weights, clubs, playersPerTable, firstTableNumber) {
  const windCost = (player, seatIndex) => {
    const counts = history.windCounts(player);
    if (seatIndex >= counts.length) return 0;
    // Sum of squares is minimised by an even spread; only the term for the
    // wind actually taken changes, so charge its increment.
    return 2 * counts[seatIndex] + 1;
  };

  const tableCost = (player, tableNumber) => {
    const been = history.tableCounts(player).get(tableNumber) || 0;
    return 2 * been + 1;
  };

  /** Cost of seating this set of players together at this table. */
  const costOf = (seats, tableNumber) => {
    let total = 0;
    const present = [];
    for (const p of seats) if (p !== null && p !== undefined) present.push(p);

    for (let i = 0; i < present.length; i++) {
      for (let j = i + 1; j < present.length; j++) {
        const met = history.meetings(present[i], present[j]);
        // Seating them now makes it met+1 meetings, which the ARA model
        // charges as (met+1-1)^2 == met^2.
        if (met) total += weights.repeat * met * met;
        if (weights.club) {
          const ca = clubs.get(present[i]);
          const cb = clubs.get(present[j]);
          if (ca && cb && ca === cb) total += weights.club;
        }
      }
    }

    seats.forEach((player, seatIndex) => {
      if (player === null || player === undefined) return;
      total += weights.wind * windCost(player, seatIndex);
      total += weights.table * tableCost(player, tableNumber);
    });

    return total;
  };

  return { costOf, firstTableNumber };
}

/* ---------------------------------------------------------------- search */

/** Pick who sits out, favouring players who have sat out least. */
function chooseByes(players, history, count, rng, neverBye, forceBye) {
  const playerSet = new Set(players);
  const chosen = forceBye.filter((p) => playerSet.has(p)).slice(0, count);
  const remaining = count - chosen.length;
  if (remaining <= 0) return chosen;

  const chosenSet = new Set(chosen);
  let pool = players.filter((p) => !chosenSet.has(p) && !neverBye.has(p));
  if (pool.length < remaining) {
    pool = players.filter((p) => !chosenSet.has(p));
  }
  shuffleInPlace(pool, rng);
  pool.sort((a, b) => history.byeCount(a) - history.byeCount(b));
  return chosen.concat(pool.slice(0, remaining));
}

/**
 * Build a seating for one round.
 *
 * `locked` pins players to a { tableNumber, seatIndex } and the search leaves
 * them alone, which is how an organiser fixes a player to a particular table.
 */
function generateSeating(players, history = null, options = {}) {
  const {
    playersPerTable = 4,
    weights: weightOverrides = {},
    clubs: clubsInput = null,
    seed = null,
    iterations = 30000,
    restarts = 3,
    timeBudget = 3.0,
    firstTableNumber = 1,
    locked = null,
    neverBye = [],
    forceBye = [],
    initial = null,
  } = options;

  const roster = [...new Set(players)];
  const hist = history || new SeatingHistory(playersPerTable);
  hist.playersPerTable = playersPerTable;
  const weights = { ...DEFAULT_WEIGHTS, ...weightOverrides };
  const clubs = clubsInput instanceof Map
    ? clubsInput
    : new Map(Object.entries(clubsInput || {}).map(([k, v]) => [Number(k), v]));
  const lockedMap = locked instanceof Map
    ? locked
    : new Map(Object.entries(locked || {}).map(([k, v]) => [Number(k), v]));
  const rng = makeRng(seed === null || seed === undefined ? 1 : seed);

  if (!roster.length) {
    return new SeatingPlan({ tables: [], byes: [], firstTableNumber });
  }

  const byeCount = roster.length % playersPerTable;
  const byes = chooseByes(roster, hist, byeCount, rng, new Set(neverBye), [...forceBye]);
  const byeSet = new Set(byes);
  const seated = roster.filter((p) => !byeSet.has(p));
  const numTables = Math.floor(seated.length / playersPerTable);

  if (numTables === 0) {
    return new SeatingPlan({ tables: [], byes: [...roster], firstTableNumber });
  }

  const evaluator = makeEvaluator(hist, weights, clubs, playersPerTable, firstTableNumber);

  // Positions are flat indexes: table = pos / ppt, seat = pos % ppt.
  const totalPositions = numTables * playersPerTable;
  const frozen = new Map();
  for (const [player, spot] of lockedMap) {
    if (!seated.includes(player)) continue;
    const tableIndex = spot.tableNumber - firstTableNumber;
    const seatIndex = spot.seatIndex;
    if (tableIndex >= 0 && tableIndex < numTables
        && seatIndex >= 0 && seatIndex < playersPerTable) {
      frozen.set(tableIndex * playersPerTable + seatIndex, player);
    }
  }

  const frozenPlayers = new Set(frozen.values());
  const freePlayers = seated.filter((p) => !frozenPlayers.has(p));
  const freePositions = [];
  for (let i = 0; i < totalPositions; i++) if (!frozen.has(i)) freePositions.push(i);

  const nFree = freePositions.length;
  const slotTable = freePositions.map((pos) => Math.floor(pos / playersPerTable));

  // One flat array, mutated in place. Rebuilding it per iteration was the
  // bottleneck in the Python; here it never gets rebuilt.
  const flat = new Array(totalPositions).fill(null);
  for (const [pos, player] of frozen) flat[pos] = player;

  const applyArrangement = (arrangement) => {
    for (let i = 0; i < nFree; i++) flat[freePositions[i]] = arrangement[i];
  };

  const tableSeats = (tableIndex) =>
    flat.slice(tableIndex * playersPerTable, (tableIndex + 1) * playersPerTable);

  const costsFor = () => {
    const costs = new Array(numTables);
    for (let t = 0; t < numTables; t++) {
      costs[t] = evaluator.costOf(tableSeats(t), firstTableNumber + t);
    }
    return costs;
  };

  const deadline = Date.now() + timeBudget * 1000;
  let bestArrangement = null;
  let bestCost = Infinity;

  const seeds = [];
  if (initial) {
    const freeSet = new Set(freePlayers);
    const flatInitial = initial.flat().filter((p) => p !== null && p !== undefined);
    const candidate = flatInitial.filter((p) => freeSet.has(p));
    const have = new Set(candidate);
    const missing = freePlayers.filter((p) => !have.has(p));
    if (candidate.length + missing.length === freePlayers.length) {
      seeds.push(candidate.concat(missing));
    }
  }

  /** Cost change from swapping free slots i and j, without committing. */
  const swapDelta = (arrangement, costs, i, j) => {
    const ti = slotTable[i];
    const tj = slotTable[j];
    const pi = freePositions[i];
    const pj = freePositions[j];
    const tmp = flat[pi];
    flat[pi] = flat[pj];
    flat[pj] = tmp;
    const ci = evaluator.costOf(tableSeats(ti), firstTableNumber + ti);
    let cj = ci;
    let delta;
    if (ti === tj) {
      delta = ci - costs[ti];
    } else {
      cj = evaluator.costOf(tableSeats(tj), firstTableNumber + tj);
      delta = (ci + cj) - (costs[ti] + costs[tj]);
    }
    flat[pj] = flat[pi];
    flat[pi] = tmp;
    return { delta, ci, cj };
  };

  const commit = (arrangement, costs, i, j, ci, cj) => {
    const t = arrangement[i];
    arrangement[i] = arrangement[j];
    arrangement[j] = t;
    flat[freePositions[i]] = arrangement[i];
    flat[freePositions[j]] = arrangement[j];
    costs[slotTable[i]] = ci;
    costs[slotTable[j]] = cj;
  };

  /**
   * Take the best improving swap until there are none left.
   *
   * Annealing alone can leave a repeat pairing in place that a single swap
   * would fix, so this runs the search to a local optimum before accepting.
   */
  const descend = (arrangement, costs, startCost) => {
    let current = startCost;
    while (current > 0 && Date.now() < deadline) {
      let bestMove = null;
      let bestDelta = -1e-9;
      for (let i = 0; i < nFree; i++) {
        for (let j = i + 1; j < nFree; j++) {
          const { delta, ci, cj } = swapDelta(arrangement, costs, i, j);
          if (delta < bestDelta) {
            bestDelta = delta;
            bestMove = { i, j, ci, cj };
          }
        }
        if (Date.now() > deadline) break;
      }
      if (!bestMove) break;
      commit(arrangement, costs, bestMove.i, bestMove.j, bestMove.ci, bestMove.cj);
      current += bestDelta;
    }
    return current;
  };

  let attempt = 0;
  while (attempt < Math.max(1, restarts) && Date.now() < deadline) {
    let arrangement;
    if (seeds.length) {
      arrangement = seeds.shift();
    } else if (bestArrangement && attempt > 0 && rng() < 0.5) {
      // Half the restarts perturb the best found rather than starting over,
      // which keeps hard-won structure.
      arrangement = [...bestArrangement];
      const kicks = Math.max(2, Math.floor(nFree / 6));
      for (let k = 0; k < kicks; k++) {
        const a = randInt(rng, nFree);
        const b = randInt(rng, nFree);
        [arrangement[a], arrangement[b]] = [arrangement[b], arrangement[a]];
      }
    } else {
      arrangement = shuffleInPlace([...freePlayers], rng);
    }

    applyArrangement(arrangement);
    const costs = costsFor();
    let current = costs.reduce((a, b) => a + b, 0);
    const startTemp = Math.max(1, current / Math.max(1, nFree));

    if (nFree >= 2) {
      for (let step = 0; step < iterations; step++) {
        if (current <= 0) break;
        if ((step & 0x1ff) === 0 && Date.now() > deadline) break;

        const i = randInt(rng, nFree);
        const j = randInt(rng, nFree);
        if (i === j) continue;

        const { delta, ci, cj } = swapDelta(arrangement, costs, i, j);
        const progress = step / Math.max(1, iterations);
        const temp = startTemp * (1 - progress) ** 3 + 1e-9;
        if (delta <= 0 || rng() < Math.exp(-delta / temp)) {
          commit(arrangement, costs, i, j, ci, cj);
          current += delta;
        }
      }
      current = descend(arrangement, costs, current);
    }

    if (current < bestCost) {
      bestCost = current;
      bestArrangement = [...arrangement];
    }
    if (bestCost <= 0) break;
    attempt++;
  }

  if (!bestArrangement) {
    bestArrangement = [...freePlayers];
    applyArrangement(bestArrangement);
    bestCost = costsFor().reduce((a, b) => a + b, 0);
  }

  applyArrangement(bestArrangement);
  const tables = [];
  for (let t = 0; t < numTables; t++) tables.push(tableSeats(t));

  const plan = new SeatingPlan({
    tables,
    byes,
    firstTableNumber,
    cost: Math.round(bestCost * 10000) / 10000,
  });
  plan.metrics = describePlan(plan, hist, { weights, clubs });
  return plan;
}

/** Human-readable diagnostics: how good is this seating, and why. */
function describePlan(plan, history, { clubs = new Map() } = {}) {
  const clubMap = clubs instanceof Map ? clubs : new Map(Object.entries(clubs || {}));
  const repeats = [];
  const clubClashes = [];

  for (const { seats } of plan.numberedTables()) {
    const present = seats.filter((p) => p !== null && p !== undefined);
    for (let i = 0; i < present.length; i++) {
      for (let j = i + 1; j < present.length; j++) {
        const a = present[i];
        const b = present[j];
        const met = history.meetings(a, b);
        if (met) repeats.push({ a, b, times: met + 1 });
        const ca = clubMap.get(a);
        const cb = clubMap.get(b);
        if (ca && cb && ca === cb) clubClashes.push({ a, b, club: ca });
      }
    }
  }

  let worstWind = 0;
  for (const { seats } of plan.numberedTables()) {
    seats.forEach((player, seatIndex) => {
      if (player === null || player === undefined) return;
      const counts = [...history.windCounts(player)];
      if (seatIndex < counts.length) counts[seatIndex] += 1;
      if (counts.length) worstWind = Math.max(worstWind, Math.max(...counts) - Math.min(...counts));
    });
  }

  return {
    tables: plan.tables.length,
    seated: plan.players().length,
    byes: plan.byes.length,
    repeatPairs: repeats.length,
    repeats: repeats.sort((x, y) => y.times - x.times).slice(0, 50),
    clubClashes: clubClashes.slice(0, 50),
    worstWindImbalance: worstWind,
    cost: plan.cost,
  };
}

/* ------------------------------------------------- constructive seedings */

/**
 * The ARA "wheel" system, for fields too large to optimise.
 *
 * The field splits into four ordered lists; each round, list 1 shifts up one
 * table, list 2 two, list 3 three, list 4 four. With enough tables this gives
 * very few repeat opponents with no search at all, so it also makes a good
 * starting point for the annealer on a large field.
 */
function wheelSeating(players, rounds, { playersPerTable = 4, seed = null } = {}) {
  const roster = [...players];
  const rng = makeRng(seed === null || seed === undefined ? 1 : seed);
  shuffleInPlace(roster, rng);

  const usable = Math.floor(roster.length / playersPerTable) * playersPerTable;
  const seated = roster.slice(0, usable);
  const spare = roster.slice(usable);
  const numTables = usable / playersPerTable;
  if (numTables === 0) {
    return Array.from({ length: rounds },
      () => new SeatingPlan({ tables: [], byes: [...roster] }));
  }

  // lists[k] holds the k-th player from each table.
  const lists = [];
  for (let k = 0; k < playersPerTable; k++) {
    const list = [];
    for (let t = 0; t < numTables; t++) list.push(seated[t * playersPerTable + k]);
    lists.push(list);
  }

  const plans = [];
  for (let r = 0; r < rounds; r++) {
    const tables = [];
    for (let t = 0; t < numTables; t++) {
      let seats = [];
      for (let k = 0; k < playersPerTable; k++) {
        const shift = (k + 1) * r;
        seats.push(lists[k][(t + shift) % numTables]);
      }
      // Rotate seat winds each round so the same list is not always East.
      const offset = r % playersPerTable;
      seats = seats.slice(offset).concat(seats.slice(0, offset));
      tables.push(seats);
    }
    plans.push(new SeatingPlan({ tables, byes: [...spare] }));
  }
  return plans;
}

/**
 * Seat a finals field by rank.
 *
 * "snake" spreads the top seeds across tables (1, 8, 9, 16 ... for sixteen),
 * which is the usual way to keep a cut fair when more than one table survives.
 * "rank_order" simply fills tables in rank order. With a single final table
 * both give the same thing.
 */
function seedCutSeating(rankedPlayers, {
  playersPerTable = 4, style = 'snake', firstTableNumber = 1,
} = {}) {
  const ranked = [...rankedPlayers];
  const numTables = Math.max(1, Math.floor(ranked.length / playersPerTable));
  const buckets = Array.from({ length: numTables }, () => []);

  if (style === 'rank_order') {
    ranked.forEach((player, i) => {
      const b = Math.floor(i / playersPerTable);
      if (b < numTables) buckets[b].push(player);
    });
  } else {
    ranked.forEach((player, i) => {
      const round = Math.floor(i / numTables);
      const pos = i % numTables;
      const index = round % 2 === 0 ? pos : numTables - 1 - pos;
      if (buckets[index].length < playersPerTable) buckets[index].push(player);
    });
  }

  const tables = buckets.map((bucket) => {
    const seats = bucket.slice(0, playersPerTable);
    while (seats.length < playersPerTable) seats.push(null);
    return seats;
  });

  const leftover = ranked.slice(numTables * playersPerTable);
  return new SeatingPlan({ tables, byes: leftover, firstTableNumber });
}

const API = {
  DEFAULT_WEIGHTS, SeatingHistory, SeatingPlan,
  generateSeating, describePlan, wheelSeating, seedCutSeating,
  makeRng, shuffleInPlace,
};

if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof window !== 'undefined') {
  window.RT = window.RT || {};
  window.RT.seating = API;
}
}());
