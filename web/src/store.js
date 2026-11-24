/* Tournament operations -- the layer the interface sits on.
 *
 * A port of mahjong/store.py. The SQLite tables become one plain object graph,
 * which is what gets persisted to IndexedDB and what gets written out as a
 * restore point. Everything that changes state goes through here, so every
 * change lands in the event log and triggers a backup.
 */
(function () {
'use strict';

/* eslint-disable no-undef */
const _scoring = (typeof require === 'function') ? require('./scoring.js') : window.RT.scoring;
const _seating = (typeof require === 'function') ? require('./seating.js') : window.RT.seating;
const _rat = (typeof require === 'function') ? require('./rational.js') : window.RT.rational;

const {
  ScoreRules, seatScore, tableScore, scoreTable, playerRecord, buildStandings, SEAT_WINDS,
} = _scoring;
const {
  SeatingHistory, SeatingPlan, generateSeating, seedCutSeating, wheelSeating,
} = _seating;
const { R, sum } = _rat;

const SCORING_PHASES = ['qualifying', 'final'];
const ALL_PHASES = ['qualifying', 'final', 'free_play'];

const DEFAULT_CONFIG = {
  plannedRounds: 6,
  hanchanMinutes: 90,
  breakMinutes: 30,
  seating: {
    weights: { repeat: 100, wind: 3, table: 1, club: 25 },
    iterations: 30000,
    restarts: 3,
    timeBudget: 3.0,
    method: 'optimise',
  },
  cut: {
    size: 4,
    rounds: 2,
    carry: 'reset',
    seeding: 'snake',
    freePlayForRest: true,
    applied: false,
    qualified: [],
    carryScores: {},
  },
  online: { platform: '', note: '' },
  venue: '',
  rulesetLabel: 'WRC 2025',
};

/** A request that cannot be carried out, with a message meant for the user. */
class StoreError extends Error {}

const now = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

function deepMerge(base, updates) {
  const out = { ...base };
  for (const [key, value] of Object.entries(updates || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)
        && out[key] && typeof out[key] === 'object' && !Array.isArray(out[key])) {
      out[key] = deepMerge(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

const clone = (value) => JSON.parse(JSON.stringify(value));

/* -------------------------------------------------------- the data shape */

function emptyTournament(id, name, { mode = 'in_person', rules = {}, config = {} } = {}) {
  const stamp = now();
  return {
    id,
    name,
    mode,
    status: 'setup',
    rules: new ScoreRules(rules).toJSON(),
    config: deepMerge(DEFAULT_CONFIG, config),
    createdAt: stamp,
    updatedAt: stamp,
    nextPlayerId: 1,
    nextRoundId: 1,
    nextPenaltyId: 1,
    players: [],    // { id, name, club, contact, externalId, status, role, manualTiebreak, notes }
    rounds: [],     // { id, number, phase, label, status, seating, seed, createdAt, closedAt,
                    //   tables: [{ tableNumber, riichiLeft, status, enteredBy, verifiedBy,
                    //              lobby, seats: [{ seatIndex, playerId }],
                    //              results: { playerId: {rawScore, chombo, penaltyPoints, penaltyNote} } }],
                    //   byes: [{ playerId, score }] }
    penalties: [],  // { id, playerId, roundId, points, reason, createdAt }
    events: [],     // { at, kind, payload }
  };
}

/* ------------------------------------------------------------------ store */

class TournamentStore {
  /**
   * @param {object} doc      the tournament object graph (or null for none yet)
   * @param {function} onChange  called after every mutation: (doc, kind, payload)
   */
  constructor(doc = null, onChange = null) {
    this.doc = doc;
    this.onChange = onChange;
    this.lastError = null;
  }

  /* -------------------------------------------------------------- hooks */

  changed(kind, payload = {}) {
    if (!this.doc) return;
    this.doc.updatedAt = now();
    this.doc.events.push({ at: now(), kind, payload: clone(payload) });
    if (this.doc.events.length > 5000) this.doc.events.splice(0, this.doc.events.length - 5000);
    if (this.onChange) {
      try {
        this.onChange(this.doc, kind, payload);
      } catch (err) {
        // A failed backup must never lose the edit.
        this.lastError = String(err && err.message ? err.message : err);
        this.doc.events.push({
          at: now(), kind: 'backup_failed', payload: { error: this.lastError, after: kind },
        });
      }
    }
  }

  require() {
    if (!this.doc) throw new StoreError('No tournament is open.');
    return this.doc;
  }

  get rules() {
    return ScoreRules.fromJSON(this.require().rules);
  }

  /* -------------------------------------------------------- tournaments */

  create(name, { mode = 'in_person', rules = {}, config = {}, id = null } = {}) {
    const trimmed = (name || '').trim();
    if (!trimmed) throw new StoreError('The tournament needs a name.');
    this.doc = emptyTournament(id || `t${Date.now()}`, trimmed, { mode, rules, config });
    this.changed('tournament_created', { name: trimmed, mode });
    return this.doc;
  }

  load(doc) {
    this.doc = doc;
    return this.doc;
  }

  update({ name, mode, status, rules, config } = {}) {
    const t = this.require();
    const newName = name === undefined ? t.name : String(name).trim();
    if (!newName) throw new StoreError('The tournament needs a name.');
    const newRules = rules === undefined ? t.rules : deepMerge(t.rules, rules);
    // Validate before storing, so a bad uma can never be saved.
    new ScoreRules(newRules);
    t.name = newName;
    t.mode = mode || t.mode;
    t.status = status || t.status;
    t.rules = new ScoreRules(newRules).toJSON();
    if (config !== undefined) t.config = deepMerge(t.config, config);
    this.changed('tournament_updated', { name: newName });
    return t;
  }

  /* ------------------------------------------------------------ players */

  addPlayer(name, {
    club = '', contact = '', externalId = '', role = 'player', notes = '',
  } = {}) {
    const t = this.require();
    const trimmed = (name || '').trim();
    if (!trimmed) throw new StoreError('A player needs a name.');
    if (!['player', 'sit_in'].includes(role)) throw new StoreError(`Unknown player role: ${role}`);
    const player = {
      id: t.nextPlayerId++,
      name: trimmed,
      club: club.trim(),
      contact: contact.trim(),
      externalId: externalId.trim(),
      status: 'active',
      role,
      manualTiebreak: '0',
      notes: notes.trim(),
      createdAt: now(),
    };
    t.players.push(player);
    this.changed('player_added', { playerId: player.id, name: trimmed });
    return player;
  }

  /**
   * Add players from pasted text: one per line, a comma or tab separating the
   * name from the club, so a roster pastes straight out of a spreadsheet.
   */
  addPlayersBulk(text) {
    const t = this.require();
    const seen = new Set(t.players.map((p) => p.name.toLowerCase()));
    const added = [];
    for (const rawLine of String(text || '').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const parts = line.replace(/\t/g, ',').split(',').map((p) => p.trim());
      const name = parts[0];
      if (!name || seen.has(name.toLowerCase())) continue;
      added.push(this.addPlayer(name, { club: parts[1] || '', contact: parts[2] || '' }));
      seen.add(name.toLowerCase());
    }
    return added;
  }

  listPlayers() {
    return [...this.require().players].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }

  playingPlayers() {
    return this.listPlayers().filter((p) => p.status === 'active');
  }

  findPlayer(playerId) {
    const p = this.require().players.find((x) => x.id === Number(playerId));
    if (!p) throw new StoreError(`No player with id ${playerId}.`);
    return p;
  }

  updatePlayer(playerId, fields = {}) {
    const player = this.findPlayer(playerId);
    const allowed = ['name', 'club', 'contact', 'externalId', 'status', 'role',
      'manualTiebreak', 'notes'];
    const changes = {};
    for (const [k, v] of Object.entries(fields)) {
      if (allowed.includes(k) && v !== undefined && v !== null) changes[k] = v;
    }
    if (changes.name !== undefined) {
      changes.name = String(changes.name).trim();
      if (!changes.name) throw new StoreError('A player needs a name.');
    }
    if (changes.status !== undefined
        && !['active', 'withdrawn', 'disqualified'].includes(changes.status)) {
      throw new StoreError(`Unknown status: ${changes.status}`);
    }
    if (changes.role !== undefined && !['player', 'sit_in'].includes(changes.role)) {
      throw new StoreError(`Unknown player role: ${changes.role}`);
    }
    if (changes.manualTiebreak !== undefined) {
      changes.manualTiebreak = R(changes.manualTiebreak).toString();
    }
    if (!Object.keys(changes).length) return player;
    Object.assign(player, changes);
    this.changed('player_updated', { playerId: player.id, changes });
    return player;
  }

  deletePlayer(playerId) {
    const t = this.require();
    const player = this.findPlayer(playerId);
    const hasPlayed = t.rounds.some((r) =>
      r.tables.some((tb) => tb.results && tb.results[player.id] !== undefined));
    if (hasPlayed) {
      throw new StoreError(
        `${player.name} already has results recorded. `
        + 'Withdraw them instead of deleting, so the history stays intact.');
    }
    t.players = t.players.filter((p) => p.id !== player.id);
    this.changed('player_deleted', { playerId: player.id, name: player.name });
  }

  /* ------------------------------------------------------------- rounds */

  listRounds() {
    return [...this.require().rounds].sort((a, b) => a.number - b.number);
  }

  findRound(roundId) {
    const r = this.require().rounds.find((x) => x.id === Number(roundId));
    if (!r) throw new StoreError(`No round with id ${roundId}.`);
    return r;
  }

  openRound() {
    return this.listRounds().find((r) => r.status !== 'complete') || null;
  }

  history() {
    const t = this.require();
    const ppt = this.rules.playersPerTable;
    const history = new SeatingHistory(ppt);
    for (const round of this.listRounds()) {
      history.record(this.planForRound(round));
    }
    return history;
  }

  planForRound(round) {
    const ppt = this.rules.playersPerTable;
    const tables = [...round.tables]
      .sort((a, b) => a.tableNumber - b.tableNumber)
      .map((t) => {
        const seats = new Array(ppt).fill(null);
        for (const s of t.seats) seats[s.seatIndex] = s.playerId;
        return seats;
      });
    const first = round.tables.length
      ? Math.min(...round.tables.map((t) => t.tableNumber))
      : 1;
    return new SeatingPlan({
      tables,
      byes: round.byes.map((b) => b.playerId),
      firstTableNumber: first,
    });
  }

  phasePool(phase) {
    const t = this.require();
    const active = this.playingPlayers();
    if (phase !== 'final') return active;
    const qualified = new Set((t.config.cut.qualified || []).map(Number));
    if (!qualified.size) {
      throw new StoreError(
        'No cut has been made yet. Make the cut first, then seat the finals.');
    }
    return active.filter((p) => qualified.has(p.id));
  }

  /**
   * How a field divides into tables, before anyone is drawn.
   *
   * Sit-ins are there to make up the last table, so they are seated only when
   * there are enough of them to complete it. Otherwise they would take seats
   * from ranked players, who would then sit out on a bye: 32 ranked players
   * and three sit-ins would leave three ranked players out every round so that
   * the sit-ins could play. When the ranked field fills its tables on its own,
   * or the sit-ins on hand cannot complete the last one, none are used.
   */
  fieldPlan(players = this.playingPlayers()) {
    const ppt = this.rules.playersPerTable;
    const ranked = players.filter((p) => p.role !== 'sit_in').length;
    const onHand = players.filter((p) => p.role === 'sit_in').length;
    const short = (ppt - (ranked % ppt)) % ppt;
    const used = short && onHand >= short ? short : 0;
    return {
      ranked,
      sitInsOnHand: onHand,
      sitInsUsed: used,
      tables: Math.floor((ranked + used) / ppt),
      sittingOut: (ranked + used) % ppt,
      short,
    };
  }

  /** The draw's pool: every ranked player, plus only the sit-ins a table needs. */
  withSitInsAsNeeded(pool) {
    const { sitInsUsed } = this.fieldPlan(pool);
    const ranked = pool.filter((p) => p.role !== 'sit_in');
    if (!sitInsUsed) return ranked;
    // Spread the work: the sit-ins who have been seated least go in first.
    const seated = new Map();
    for (const round of this.require().rounds) {
      for (const table of round.tables) {
        for (const s of table.seats) {
          if (s.playerId !== null) seated.set(s.playerId, (seated.get(s.playerId) || 0) + 1);
        }
      }
    }
    const sitIns = pool.filter((p) => p.role === 'sit_in')
      .sort((a, b) => (seated.get(a.id) || 0) - (seated.get(b.id) || 0) || a.id - b.id);
    return ranked.concat(sitIns.slice(0, sitInsUsed));
  }

  byeScoresFor(byes) {
    if (!byes.length) return {};
    const rules = this.rules;
    if (rules.byeMode === 'fixed') {
      const value = rules.quantize(rules.byeScore);
      return Object.fromEntries(byes.map((p) => [p, value.toFixed(rules.scorePrecision)]));
    }
    const records = new Map(this.records('overall').map((r) => [r.playerId, r]));
    const out = {};
    for (const pid of byes) {
      const rec = records.get(Number(pid));
      if (rec && rec.hanchanScores.length) {
        const mean = sum(rec.hanchanScores).div(R(rec.hanchanScores.length));
        out[pid] = rules.quantize(mean).toFixed(rules.scorePrecision);
      } else {
        out[pid] = rules.quantize(R(0)).toFixed(rules.scorePrecision);
      }
    }
    return out;
  }

  defaultLabel(phase, number) {
    if (phase === 'final') return `Final hanchan ${number}`;
    if (phase === 'free_play') return `Free play ${number}`;
    return `Hanchan ${number}`;
  }

  generateRound({
    phase = 'qualifying', label = '', seed = null, playerIds = null,
    method = null, locked = null, forceBye = [],
  } = {}) {
    const t = this.require();
    if (!ALL_PHASES.includes(phase)) throw new StoreError(`Unknown phase: ${phase}`);
    const rules = this.rules;
    const ppt = rules.playersPerTable;

    const open = this.openRound();
    if (open) {
      throw new StoreError(
        `Round ${open.number} is still open. `
        + 'Finish entering its scores and close it first.');
    }

    let pool;
    if (playerIds === null) {
      pool = this.phasePool(phase);
      if (phase !== 'final') pool = this.withSitInsAsNeeded(pool);
    } else {
      const known = new Map(t.players.map((p) => [p.id, p]));
      pool = playerIds.map((i) => known.get(Number(i))).filter(Boolean);
    }
    if (pool.length < ppt) {
      throw new StoreError(
        `Need at least ${ppt} players to seat a table; ${pool.length} available.`);
    }

    const cfg = t.config.seating || {};
    const ids = pool.map((p) => p.id);
    const clubs = new Map(pool.map((p) => [p.id, p.club || '']));
    const nextNumber = 1 + t.rounds.reduce((m, r) => Math.max(m, r.number), 0);
    const actualSeed = (seed === null || seed === undefined || seed === '')
      ? nextNumber * 7919 + ids.length
      : Number(seed);
    const chosen = method || cfg.method || 'optimise';
    const history = this.history();

    const searchOptions = {
      playersPerTable: ppt,
      weights: cfg.weights,
      clubs,
      seed: actualSeed,
      iterations: Number(cfg.iterations ?? 30000),
      restarts: Number(cfg.restarts ?? 3),
      timeBudget: Number(cfg.timeBudget ?? 3.0),
      locked,
      forceBye,
    };

    let plan;
    if (phase === 'final' && chosen !== 'manual') {
      const idSet = new Set(ids);
      const ranked = this.standings('qualifying')
        .filter((s) => idSet.has(s.playerId))
        .map((s) => s.playerId);
      for (const i of ids) if (!ranked.includes(i)) ranked.push(i);
      const finalsSoFar = t.rounds.filter((r) => r.phase === 'final').length;
      if (finalsSoFar === 0) {
        plan = seedCutSeating(ranked, {
          playersPerTable: ppt,
          style: (t.config.cut || {}).seeding || 'snake',
        });
      } else {
        // Later final rounds re-pair, so the same four do not always sit together.
        plan = generateSeating(ranked, history, searchOptions);
      }
    } else if (chosen === 'wheel') {
      [plan] = wheelSeating(ids, 1, { playersPerTable: ppt, seed: actualSeed });
    } else {
      let initial = null;
      if (ids.length >= 48 && history.met.size) {
        // On a big field, start the search from a wheel round.
        initial = wheelSeating(ids, 1, { playersPerTable: ppt, seed: actualSeed })[0].tables;
      }
      plan = generateSeating(ids, history, {
        ...searchOptions,
        neverBye: pool.filter((p) => p.role === 'sit_in').map((p) => p.id),
        initial,
      });
    }

    // Everyone who missed the cut plays at free-play tables alongside each
    // final: seated, printed and posted like any other table, never scored.
    // Only one round can be open at a time, so a separate free-play round
    // could not run beside a final -- this is the only way the two coexist.
    let free = null;
    let freeOut = [];
    if (phase === 'final' && playerIds === null
        && (t.config.cut || {}).freePlayForRest !== false) {
      const through = new Set(ids);
      const rest = this.withSitInsAsNeeded(
        this.playingPlayers().filter((p) => !through.has(p.id)));
      if (rest.length >= ppt) {
        free = generateSeating(rest.map((p) => p.id), history, {
          ...searchOptions,
          clubs: new Map(rest.map((p) => [p.id, p.club || ''])),
          seed: actualSeed + 1,
          firstTableNumber: plan.firstTableNumber + plan.tables.length,
        });
        freeOut = free.byes;
      } else {
        freeOut = rest.map((p) => p.id);
      }
    }

    const tableDoc = (tableNumber, seats, freePlay) => ({
      tableNumber,
      riichiLeft: 0,
      status: 'pending',
      enteredBy: '',
      verifiedBy: '',
      lobby: '',
      updatedAt: now(),
      seats: seats.map((playerId, seatIndex) => ({ seatIndex, playerId })),
      results: {},
      ...(freePlay ? { freePlay: true } : {}),
    });

    const byeValues = this.byeScoresFor(plan.byes);
    const round = {
      id: t.nextRoundId++,
      number: nextNumber,
      phase,
      label: label || this.defaultLabel(phase, nextNumber),
      status: 'open',
      seating: { metrics: plan.metrics, method: chosen, cost: plan.cost },
      seed: actualSeed,
      createdAt: now(),
      closedAt: null,
      tables: plan.numberedTables()
        .map(({ tableNumber, seats }) => tableDoc(tableNumber, seats, false))
        .concat(free
          ? free.numberedTables().map(({ tableNumber, seats }) => tableDoc(tableNumber, seats, true))
          : []),
      byes: plan.byes.map((playerId) => ({ playerId, score: byeValues[playerId] })),
      ...(phase === 'final' ? { freePlayOut: freeOut } : {}),
    };
    t.rounds.push(round);
    if (t.status === 'setup') t.status = 'running';

    this.changed('round_generated', {
      roundId: round.id,
      number: round.number,
      phase,
      tables: round.tables.filter((tb) => !tb.freePlay).length,
      freePlayTables: round.tables.filter((tb) => tb.freePlay).length,
      byes: plan.byes,
      seed: actualSeed,
      method: chosen,
      cost: plan.cost,
    });
    return this.getRound(round.id);
  }

  /** A round with names, results and computed outcomes attached. */
  getRound(roundId) {
    const t = this.require();
    const round = this.findRound(roundId);
    const rules = this.rules;
    const names = new Map(t.players.map((p) => [p.id, p]));

    const tables = [...round.tables]
      .sort((a, b) => a.tableNumber - b.tableNumber)
      .map((tb) => {
        const seats = [...tb.seats].sort((a, b) => a.seatIndex - b.seatIndex).map((s) => {
          const player = s.playerId === null ? null : names.get(s.playerId);
          const res = (tb.results || {})[s.playerId];
          return {
            seatIndex: s.seatIndex,
            seatWind: SEAT_WINDS[s.seatIndex] ?? '?',
            playerId: s.playerId,
            name: player ? player.name : null,
            club: player ? player.club : '',
            rawScore: res ? res.rawScore : null,
            chombo: res ? res.chombo : 0,
            penaltyPoints: res ? res.penaltyPoints : '0',
            penaltyNote: res ? res.penaltyNote : '',
          };
        });
        return {
          tableNumber: tb.tableNumber,
          riichiLeft: tb.riichiLeft,
          status: tb.status,
          enteredBy: tb.enteredBy,
          verifiedBy: tb.verifiedBy,
          lobby: tb.lobby,
          overridden: Boolean(tb.overridden),
          freePlay: Boolean(tb.freePlay),
          seats,
          outcome: this.tableOutcome(rules, tb, seats),
        };
      });

    // Free-play tables are not scored, so they count towards nothing here.
    const scored = tables.filter((x) => !x.freePlay);
    return {
      ...round,
      tables,
      byes: round.byes.map((b) => ({
        playerId: b.playerId,
        name: (names.get(b.playerId) || {}).name || '?',
        score: b.score,
      })),
      freePlayOut: (round.freePlayOut || []).map((id) => ({
        playerId: id, name: (names.get(id) || {}).name || '?',
      })),
      tablesTotal: scored.length,
      tablesReported: scored.filter((x) => ['entered', 'verified'].includes(x.status)).length,
      freePlayTables: tables.length - scored.length,
    };
  }

  tableOutcome(rules, rawTable, seats) {
    const filled = seats.filter((s) => s.rawScore !== null && s.rawScore !== undefined);
    if (filled.length !== rules.playersPerTable) return null;
    const ts = tableScore({
      tableNumber: rawTable.tableNumber,
      riichiLeft: rawTable.riichiLeft,
      seats: filled.map((s) => seatScore({
        playerId: s.playerId,
        seat: s.seatIndex,
        rawScore: s.rawScore,
        chombo: s.chombo,
        penaltyPoints: s.penaltyPoints,
        penaltyNote: s.penaltyNote,
      })),
    });
    const outcome = scoreTable(rules, ts);
    const p = rules.scorePrecision;
    return {
      ok: outcome.ok,
      issues: outcome.issues,
      seats: outcome.seats.map((o) => ({
        playerId: o.playerId,
        seatIndex: o.seat,
        seatWind: o.seatWind,
        placement: o.placement,
        sharedPlacement: o.sharedPlacement,
        scoreDelta: o.scoreDelta.toFixed(p),
        uma: o.uma.toFixed(p),
        oka: o.oka.toFixed(p),
        hanchanScore: o.hanchanScore.toFixed(p),
        penaltyPoints: o.penaltyPoints.toFixed(p),
      })),
    };
  }

  reseatRound(roundId, seed = null) {
    const t = this.require();
    const detail = this.getRound(roundId);
    if (detail.tablesReported) {
      throw new StoreError(
        'Scores have already been entered for this round, so the seating cannot be '
        + 'redrawn. Clear the entered tables first.');
    }
    const { number, phase, label } = detail;
    // Without a seed, generateRound derives one from the round number and the
    // field size -- both of which a redraw leaves untouched -- so it would hand
    // back the identical seating. Step past the seed this round already used
    // instead: every press is a new draw, and the document still records the
    // exact seed behind it. (mulberry32 decorrelates adjacent seeds, so +1 is a
    // genuinely different shuffle, not a near-miss of the last one.)
    const used = Number(detail.seed);
    const base = Number.isFinite(used) ? used : number * 7919 + 1;
    const nextSeed = (seed === null || seed === undefined || seed === '')
      ? base + 1
      : Number(seed);
    t.rounds = t.rounds.filter((r) => r.id !== Number(roundId));
    if (!t.rounds.length && t.status === 'running') t.status = 'setup';
    const fresh = this.generateRound({ phase, label, seed: nextSeed });
    this.changed('round_reseated', {
      roundNumber: number, roundId: fresh.id, seed: nextSeed,
    });
    return fresh;
  }

  /**
   * Change who sits where after the draw.
   *
   *   both seated          they swap seats
   *   one seated, one bye  the bye player takes the seat and the other sits out,
   *                        on the bye score already worked out for the round
   *   one not in the round they take the seat and the other leaves the round
   *                        with no score -- a late arrival, or a sit-in for a
   *                        no-show. Nobody else at the table moves.
   *
   * A player whose table already has a score cannot be moved, and in a final
   * round a finalist cannot be put on a free-play table.
   */
  swapSeats(roundId, playerA, playerB) {
    const t = this.require();
    const round = this.findRound(roundId);
    if (round.status === 'complete') {
      throw new StoreError('This round is closed. Reopen it before changing seats.');
    }
    const a = Number(playerA);
    const b = Number(playerB);
    if (a === b) throw new StoreError('Choose two different players.');

    for (const pid of [a, b]) {
      if (round.tables.some((tb) => (tb.results || {})[pid] !== undefined)) {
        throw new StoreError(
          `${this.findPlayer(pid).name} already has a score for this round. `
          + 'Clear the table result before moving them.');
      }
    }

    const placeOf = (pid) => {
      for (const table of round.tables) {
        const seat = table.seats.find((s) => s.playerId === pid);
        if (seat) return { table, seat };
      }
      return null;
    };
    const at = { [a]: placeOf(a), [b]: placeOf(b) };
    const bye = {
      [a]: round.byes.find((x) => x.playerId === a),
      [b]: round.byes.find((x) => x.playerId === b),
    };

    // Where each would end up, checked before anything changes.
    const finalists = new Set(((t.config.cut || {}).qualified || []).map(Number));
    const refuseFreeSeat = (pid, place) => {
      if (place && place.table.freePlay && finalists.has(pid)) {
        throw new StoreError(
          `${this.findPlayer(pid).name} is in the final and cannot be moved to a `
          + 'free-play table.');
      }
    };

    if (at[a] && at[b]) {
      refuseFreeSeat(a, at[b]);
      refuseFreeSeat(b, at[a]);
      at[a].seat.playerId = b;
      at[b].seat.playerId = a;
      this.changed('seats_swapped', { roundId: round.id, a, b });
      return this.getRound(round.id);
    }

    const seated = at[a] ? a : (at[b] ? b : null);
    if (seated === null) {
      throw new StoreError('At least one of the two has to be seated in this round.');
    }
    const other = seated === a ? b : a;
    const place = at[seated];

    if (bye[other]) {
      refuseFreeSeat(other, place);
      place.seat.playerId = other;
      round.byes = round.byes.filter((x) => x.playerId !== other);
      round.byes.push({ playerId: seated, score: bye[other].score });
      this.changed('seats_swapped', { roundId: round.id, a, b });
      return this.getRound(round.id);
    }

    // Someone from outside the round takes the seat.
    const arriving = this.findPlayer(other);
    if (arriving.status !== 'active') {
      throw new StoreError(
        `${arriving.name} is marked ${arriving.status}. Set them back to playing on the `
        + 'Players tab before seating them.');
    }
    refuseFreeSeat(other, place);
    place.seat.playerId = other;
    place.table.updatedAt = now();
    this.changed('seat_substituted', {
      roundId: round.id, table: place.table.tableNumber, out: seated, in: other,
    });
    return this.getRound(round.id);
  }

  setTableLobby(roundId, tableNumber, lobby) {
    const round = this.findRound(roundId);
    const table = round.tables.find((t) => t.tableNumber === Number(tableNumber));
    if (!table) throw new StoreError(`Table ${tableNumber} does not exist in this round.`);
    table.lobby = String(lobby || '').trim();
    table.updatedAt = now();
    this.changed('lobby_set', { roundId: round.id, table: table.tableNumber, lobby: table.lobby });
    return this.getRound(round.id);
  }

  /* ------------------------------------------------------------ results */

  /** Score a table without saving, so the interface can show what will happen. */
  previewTable(roundId, tableNumber, entries, { riichiLeft = 0 } = {}) {
    const t = this.require();
    const round = this.findRound(roundId);
    const rules = this.rules;
    const table = round.tables.find((x) => x.tableNumber === Number(tableNumber));
    if (!table) throw new StoreError(`Table ${tableNumber} does not exist in this round.`);
    if (table.freePlay) {
      throw new StoreError(`Table ${tableNumber} is a free-play table, which is not scored.`);
    }
    const seatOf = new Map(table.seats.filter((s) => s.playerId !== null)
      .map((s) => [s.playerId, s.seatIndex]));
    const names = new Map(t.players.map((p) => [p.id, p.name]));

    const seats = [];
    for (const entry of entries) {
      const pid = Number(entry.playerId);
      if (!seatOf.has(pid)) continue;
      const raw = entry.rawScore;
      if (raw === null || raw === undefined || raw === '') continue;
      seats.push(seatScore({
        playerId: pid,
        seat: seatOf.get(pid),
        rawScore: Number(raw),
        chombo: Number(entry.chombo) || 0,
        penaltyPoints: entry.penaltyPoints || 0,
        penaltyNote: entry.penaltyNote || '',
      }));
    }

    const complete = seats.length === rules.playersPerTable;
    const outcome = scoreTable(rules,
      tableScore({ tableNumber: Number(tableNumber), seats, riichiLeft: Number(riichiLeft) || 0 }),
      { validate: complete });
    const p = rules.scorePrecision;
    return {
      complete,
      ok: complete ? outcome.ok : false,
      tableTotal: rules.tableTotal,
      enteredTotal: seats.reduce((a, s) => a + s.rawScore, 0) + 1000 * (Number(riichiLeft) || 0),
      issues: outcome.issues,
      seats: [...outcome.seats].sort((a, b) => a.placement - b.placement).map((o) => ({
        playerId: o.playerId,
        name: names.get(o.playerId) || '?',
        seatIndex: o.seat,
        seatWind: o.seatWind,
        placement: o.placement,
        sharedPlacement: o.sharedPlacement,
        scoreDelta: o.scoreDelta.toFixed(p),
        uma: o.uma.toFixed(p),
        oka: o.oka.toFixed(p),
        hanchanScore: o.hanchanScore.toFixed(p),
        penaltyPoints: o.penaltyPoints.toFixed(p),
      })),
    };
  }

  /** Record one table's result. */
  saveTable(roundId, tableNumber, entries, {
    riichiLeft = 0, enteredBy = '', verifiedBy = '', allowIssues = false,
  } = {}) {
    const round = this.findRound(roundId);
    if (round.status === 'complete') {
      throw new StoreError('This round is closed. Reopen it before changing a score.');
    }
    const rules = this.rules;
    const table = round.tables.find((x) => x.tableNumber === Number(tableNumber));
    if (!table) throw new StoreError(`Table ${tableNumber} does not exist in this round.`);
    if (table.freePlay) {
      throw new StoreError(`Table ${tableNumber} is a free-play table, which is not scored.`);
    }
    const seatOf = new Map(table.seats.filter((s) => s.playerId !== null)
      .map((s) => [s.playerId, s.seatIndex]));

    const seats = [];
    for (const entry of entries) {
      const pid = Number(entry.playerId);
      if (!seatOf.has(pid)) {
        throw new StoreError(`Player ${pid} is not seated at table ${tableNumber}.`);
      }
      const raw = entry.rawScore;
      if (raw === null || raw === undefined || raw === '') {
        throw new StoreError('Every player at the table needs a score.');
      }
      seats.push(seatScore({
        playerId: pid,
        seat: seatOf.get(pid),
        rawScore: Number(raw),
        chombo: Number(entry.chombo) || 0,
        penaltyPoints: entry.penaltyPoints || 0,
        penaltyNote: String(entry.penaltyNote || '').trim(),
      }));
    }

    const outcome = scoreTable(rules, tableScore({
      tableNumber: Number(tableNumber), seats, riichiLeft: Number(riichiLeft) || 0,
    }));
    const blocking = outcome.issues.filter((i) => i.severity === 'error');
    if (blocking.length && !allowIssues) {
      throw new StoreError(blocking.map((i) => i.message).join(' '));
    }

    table.results = {};
    for (const s of seats) {
      table.results[s.playerId] = {
        rawScore: s.rawScore,
        chombo: s.chombo,
        penaltyPoints: s.penaltyPoints.toString(),
        penaltyNote: s.penaltyNote,
      };
    }
    table.riichiLeft = Number(riichiLeft) || 0;
    table.status = verifiedBy ? 'verified' : 'entered';
    table.enteredBy = String(enteredBy).trim();
    table.verifiedBy = String(verifiedBy).trim();
    // Recorded as the signed sheet says, although it does not add up. Kept on
    // the table so it stays visible, and in the log so it can be found later.
    table.overridden = blocking.length > 0;
    table.updatedAt = now();

    this.changed('table_saved', {
      roundId: round.id,
      roundNumber: round.number,
      table: table.tableNumber,
      riichiLeft: table.riichiLeft,
      enteredBy: table.enteredBy,
      scores: Object.fromEntries(seats.map((s) => [s.playerId, s.rawScore])),
      issues: outcome.issues,
      overridden: table.overridden,
    });
    return this.getRound(round.id);
  }

  clearTable(roundId, tableNumber) {
    const round = this.findRound(roundId);
    const table = round.tables.find((x) => x.tableNumber === Number(tableNumber));
    if (!table) throw new StoreError(`Table ${tableNumber} does not exist in this round.`);
    if (table.freePlay) {
      throw new StoreError(`Table ${tableNumber} is a free-play table, which is not scored.`);
    }
    table.results = {};
    table.riichiLeft = 0;
    table.overridden = false;
    table.status = 'pending';
    table.enteredBy = '';
    table.verifiedBy = '';
    table.updatedAt = now();
    this.changed('table_cleared', { roundId: round.id, table: table.tableNumber });
    return this.getRound(round.id);
  }

  verifyTable(roundId, tableNumber, verifiedBy) {
    const round = this.findRound(roundId);
    const table = round.tables.find((x) => x.tableNumber === Number(tableNumber));
    if (!table) throw new StoreError(`Table ${tableNumber} does not exist in this round.`);
    if (table.freePlay) {
      throw new StoreError(`Table ${tableNumber} is a free-play table, which is not scored.`);
    }
    if (table.status === 'pending') {
      throw new StoreError("Enter the table's scores before verifying it.");
    }
    table.status = 'verified';
    table.verifiedBy = String(verifiedBy || '').trim();
    table.updatedAt = now();
    this.changed('table_verified', {
      roundId: round.id, table: table.tableNumber, by: table.verifiedBy,
    });
    return this.getRound(round.id);
  }

  closeRound(roundId, { force = false } = {}) {
    const detail = this.getRound(roundId);
    const round = this.findRound(roundId);
    const missing = detail.tables
      .filter((t) => !t.freePlay && !['entered', 'verified'].includes(t.status))
      .map((t) => t.tableNumber);
    if (missing.length && !force) {
      throw new StoreError(
        `These tables have no result yet: ${missing.join(', ')}. `
        + 'Enter them, or close the round anyway if they did not play.');
    }
    round.status = 'complete';
    round.closedAt = now();
    this.changed('round_closed', {
      roundId: round.id, number: round.number,
      forced: missing.length > 0, missingTables: missing,
    });
    return this.getRound(roundId);
  }

  reopenRound(roundId) {
    const t = this.require();
    const round = this.findRound(roundId);
    const later = t.rounds.find((r) => r.number > round.number);
    if (later) {
      throw new StoreError(
        `Round ${later.number} has already been seated. `
        + 'Delete it before reopening an earlier round.');
    }
    round.status = 'open';
    round.closedAt = null;
    this.changed('round_reopened', { roundId: round.id, number: round.number });
    return this.getRound(roundId);
  }

  deleteRound(roundId) {
    const t = this.require();
    const round = this.findRound(roundId);
    const later = t.rounds.find((r) => r.number > round.number);
    if (later) {
      throw new StoreError(
        `Round ${later.number} comes after this one. `
        + 'Delete rounds from the last one backwards.');
    }
    t.rounds = t.rounds.filter((r) => r.id !== round.id);
    this.changed('round_deleted', { roundId: round.id, number: round.number });
  }

  /* ---------------------------------------------------------- penalties */

  /**
   * A point penalty off the tournament score.
   *
   * Every penalty belongs to a stage -- qualifying or the finals -- and counts
   * only there. Without that, a penalty from the qualifying day was taken
   * again in the finals: twice over under a full carry, since the carried
   * score already had it, and into a final that was meant to start level under
   * a reset. A penalty tied to a round takes that round's stage; otherwise it
   * goes to the stage given, or to whichever the event is in now.
   */
  addPenalty(playerId, points, { reason = '', roundId = null, phase = null } = {}) {
    const t = this.require();
    this.findPlayer(playerId);
    const round = roundId === null || roundId === '' ? null : this.findRound(roundId);
    const stage = round ? round.phase : (phase || this.currentStage());
    if (!SCORING_PHASES.includes(stage)) {
      throw new StoreError('A penalty counts towards qualifying or the finals; '
        + `"${stage}" is neither.`);
    }
    if (stage === 'final' && !(t.config.cut || {}).applied) {
      throw new StoreError('No cut has been made, so there is no finals score to take '
        + 'a penalty from yet.');
    }
    const penalty = {
      id: t.nextPenaltyId++,
      playerId: Number(playerId),
      roundId: round ? round.id : null,
      phase: stage,
      points: R(points || 0).toString(),
      reason: String(reason || '').trim(),
      createdAt: now(),
    };
    t.penalties.push(penalty);
    this.changed('penalty_added', {
      penaltyId: penalty.id, playerId: penalty.playerId,
      points: penalty.points, reason: penalty.reason, phase: stage,
    });
    return penalty;
  }

  /** Qualifying until the cut is made, the finals after. */
  currentStage() {
    return (this.require().config.cut || {}).applied ? 'final' : 'qualifying';
  }

  /**
   * The stage a penalty counts towards. Penalties saved before stages were
   * recorded carry no phase; they are placed by when they were given, which
   * is the only evidence there is.
   */
  penaltyPhase(penalty) {
    const t = this.require();
    if (penalty.roundId !== null && penalty.roundId !== undefined) {
      const round = t.rounds.find((r) => r.id === Number(penalty.roundId));
      if (round) return round.phase;
    }
    if (penalty.phase) return penalty.phase;
    const cut = t.config.cut || {};
    return cut.applied && cut.appliedAt && penalty.createdAt >= cut.appliedAt
      ? 'final' : 'qualifying';
  }

  listPenalties() {
    const t = this.require();
    const names = new Map(t.players.map((p) => [p.id, p.name]));
    const rounds = new Map(t.rounds.map((r) => [r.id, r.number]));
    return t.penalties.map((p) => ({
      ...p,
      phase: this.penaltyPhase(p),
      playerName: names.get(p.playerId) || '?',
      roundNumber: p.roundId === null ? null : (rounds.get(p.roundId) ?? null),
    }));
  }

  deletePenalty(penaltyId) {
    const t = this.require();
    const penalty = t.penalties.find((p) => p.id === Number(penaltyId));
    if (!penalty) throw new StoreError(`No penalty with id ${penaltyId}.`);
    t.penalties = t.penalties.filter((p) => p.id !== penalty.id);
    this.changed('penalty_deleted', { penaltyId: penalty.id, playerId: penalty.playerId });
  }

  /* ---------------------------------------------------------- standings */

  records(scope = 'overall') {
    const t = this.require();
    const rules = this.rules;
    const cut = t.config.cut || {};

    let phases;
    if (scope === 'qualifying') phases = ['qualifying'];
    else if (scope === 'final') phases = ['final'];
    else phases = SCORING_PHASES;

    let ranked = t.players.filter((p) => p.role === 'player' && p.status !== 'disqualified');
    if (scope === 'final') {
      const qualified = new Set((cut.qualified || []).map(Number));
      ranked = ranked.filter((p) => qualified.has(p.id));
    }

    const records = new Map(ranked.map((p) => [p.id, playerRecord({
      playerId: p.id, name: p.name, manualTiebreak: p.manualTiebreak || 0,
    })]));

    for (const round of this.listRounds()) {
      if (!phases.includes(round.phase)) continue;
      for (const table of round.tables) {
        if (table.freePlay) continue;
        const entries = Object.entries(table.results || {});
        if (entries.length !== rules.playersPerTable) continue;
        const seatOf = new Map(table.seats.filter((s) => s.playerId !== null)
          .map((s) => [s.playerId, s.seatIndex]));
        const outcome = scoreTable(rules, tableScore({
          tableNumber: table.tableNumber,
          riichiLeft: table.riichiLeft,
          seats: entries.map(([pid, res]) => seatScore({
            playerId: Number(pid),
            seat: seatOf.get(Number(pid)) ?? 0,
            rawScore: res.rawScore,
            chombo: res.chombo,
            penaltyPoints: res.penaltyPoints,
            penaltyNote: res.penaltyNote,
          })),
        }), { validate: false });
        for (const seat of outcome.seats) {
          const rec = records.get(seat.playerId);
          if (!rec) continue;
          rec.hanchanScores.push(seat.hanchanScore);
          rec.placements.push(seat.placement);
          rec.deltas.push(seat.scoreDelta);
          if (!seat.penaltyPoints.isZero) rec.penalties.push(seat.penaltyPoints);
        }
      }
      for (const bye of round.byes) {
        const rec = records.get(bye.playerId);
        if (rec) rec.byeScores.push(R(bye.score));
      }
    }

    for (const penalty of t.penalties) {
      if (!phases.includes(this.penaltyPhase(penalty))) continue;
      const rec = records.get(penalty.playerId);
      if (rec) rec.penalties.push(R(penalty.points));
    }

    if (scope === 'final' && ['full', 'half'].includes(cut.carry)) {
      const factor = cut.carry === 'full' ? R(1) : R('0.5');
      for (const [pid, value] of Object.entries(cut.carryScores || {})) {
        const rec = records.get(Number(pid));
        if (rec) rec.carryOver = rules.quantize(R(value).mul(factor));
      }
    }

    return [...records.values()];
  }

  /**
   * The ranking for a scope. Before a cut, "overall" is every scored hanchan
   * added up. Once a cut is made it is the event's finishing order instead --
   * see eventStandings() -- because adding qualifying and finals together
   * gives the wrong answer under the ARA's reset.
   */
  standings(scope = 'overall') {
    if (scope === 'overall' && (this.require().config.cut || {}).applied) {
      return this.eventStandings();
    }
    return buildStandings(this.rules, this.records(scope));
  }

  /**
   * How the event finished: the finalists in their finals order, then everyone
   * else in their qualifying order, placed after them.
   *
   * Summing both stages crowned the wrong player under a reset -- the winner of
   * the final could come second to someone with a bigger qualifying score --
   * and could rank a player who missed the cut above one who made it. Until a
   * final hanchan has been scored, the finalists stand in their seeding order,
   * since a reset final would otherwise show all of them tied on zero.
   *
   * Each row says which stage its score comes from, in `stage`.
   */
  eventStandings() {
    const rules = this.rules;
    const through = new Set((this.require().config.cut.qualified || []).map(Number));
    const qualifying = buildStandings(rules, this.records('qualifying'));
    const finalRecords = this.records('final');
    const finalists = finalRecords.some((r) => r.hanchanScores.length)
      ? buildStandings(rules, finalRecords)
      : qualifying.filter((s) => through.has(s.playerId));
    const rest = qualifying.filter((s) => !through.has(s.playerId));

    // Renumber from `offset`, keeping shared places shared.
    const placed = (rows, offset, stage) => {
      const first = new Map();
      rows.forEach((s, i) => { if (!first.has(s.rank)) first.set(s.rank, i); });
      return rows.map((s) => ({ ...s, rank: offset + 1 + first.get(s.rank), stage }));
    };
    return placed(finalists, 0, 'final')
      .concat(placed(rest, finalists.length, 'qualifying'));
  }

  /* ---------------------------------------------------------------- cut */

  applyCut({ size = null, carry = null, rounds = null, freePlayForRest = null } = {}) {
    const t = this.require();
    const cut = { ...(t.config.cut || {}) };
    const cutSize = Number(size === null ? cut.size ?? 4 : size);
    const cutCarry = carry || cut.carry || 'reset';
    const cutRounds = Number(rounds === null ? cut.rounds ?? 2 : rounds);
    if (!['reset', 'full', 'half'].includes(cutCarry)) {
      throw new StoreError(`Unknown carry-over mode: ${cutCarry}`);
    }
    if (cutSize < 1) throw new StoreError('The cut needs at least one player.');

    const open = this.openRound();
    if (open) {
      throw new StoreError(`Round ${open.number} is still open. Close it before cutting.`);
    }

    // Only players still in the event go through. A withdrawn player keeps
    // their qualifying place, but putting them through left the final a player
    // short, with no way out but to disqualify someone who had done nothing
    // wrong. They are passed over, and the next player goes through instead.
    const playing = new Set(this.playingPlayers().map((p) => p.id));
    const everyone = this.standings('qualifying');
    const table = everyone.filter((s) => playing.has(s.playerId));
    if (table.length < cutSize) {
      throw new StoreError(
        `Only ${table.length} ranked players are still playing; `
        + `cannot cut to a top ${cutSize}.`);
    }

    const qualified = table.slice(0, cutSize).map((s) => s.playerId);
    const boundary = table[cutSize - 1];
    const contested = table.filter((s) =>
      s.rank === boundary.rank && !qualified.includes(s.playerId));
    if (contested.length) {
      const names = table.filter((s) => s.rank === boundary.rank).map((s) => s.name);
      throw new StoreError(
        `The cut line is tied: ${names.join(', ')} share rank ${boundary.rank}. `
        + 'Settle it (a coin toss, per WRC) by setting a manual tiebreak on the roster, '
        + 'then cut again.');
    }

    const passedOver = everyone
      .filter((s) => !playing.has(s.playerId) && s.rank <= boundary.rank)
      .map((s) => s.playerId);

    Object.assign(cut, {
      size: cutSize,
      carry: cutCarry,
      rounds: cutRounds,
      applied: true,
      appliedAt: now(),
      qualified,
      passedOver,
      carryScores: Object.fromEntries(
        table.slice(0, cutSize).map((s) => [s.playerId, s.tournamentScore.toString()])),
      freePlayForRest: freePlayForRest === null
        ? (cut.freePlayForRest ?? true)
        : Boolean(freePlayForRest),
    });
    t.config = deepMerge(t.config, { cut });
    t.status = 'finals';
    this.changed('cut_applied', {
      size: cutSize, carry: cutCarry, rounds: cutRounds, qualified,
      names: table.slice(0, cutSize).map((s) => s.name),
      passedOver,
    });
    return t;
  }

  undoCut() {
    const t = this.require();
    if (t.rounds.some((r) => r.phase === 'final')) {
      throw new StoreError(
        'Final rounds have already been seated. Delete them before undoing the cut.');
    }
    t.config = deepMerge(t.config, {
      cut: { applied: false, qualified: [], carryScores: {}, passedOver: [] },
    });
    t.status = 'running';
    this.changed('cut_undone', {});
    return t;
  }

  /* --------------------------------------------------------------- misc */

  events(limit = 200) {
    const t = this.require();
    return t.events.slice(-limit).reverse();
  }

  summary() {
    const t = this.require();
    const rules = this.rules;
    const players = this.listPlayers();
    const rounds = this.listRounds().map((r) => {
      const detail = this.getRound(r.id);
      return {
        id: r.id, number: r.number, phase: r.phase, label: r.label, status: r.status,
        seed: r.seed, createdAt: r.createdAt, closedAt: r.closedAt,
        tables: detail.tablesTotal, tablesReported: detail.tablesReported,
        seating: r.seating,
      };
    });
    const active = players.filter((p) => p.status === 'active');
    return {
      tournament: { ...t, players: undefined, rounds: undefined, events: undefined },
      counts: {
        players: players.length,
        active: active.length,
        ranked: active.filter((p) => p.role === 'player').length,
        sitIns: active.filter((p) => p.role === 'sit_in').length,
        rounds: rounds.length,
        roundsComplete: rounds.filter((r) => r.status === 'complete').length,
      },
      rulesSummary: {
        startingPoints: rules.startingPoints,
        goalPoints: rules.goalPoints,
        uma: rules.uma.map((u) => u.toString()),
        oka: rules.oka.toString(),
        tableTotal: rules.tableTotal,
        playersPerTable: rules.playersPerTable,
      },
      rounds,
      openRound: rounds.find((r) => r.status !== 'complete') || null,
    };
  }
}

const API = {
  TournamentStore, StoreError, DEFAULT_CONFIG,
  SCORING_PHASES, ALL_PHASES, emptyTournament, deepMerge,
};

if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof window !== 'undefined') {
  window.RT = window.RT || {};
  window.RT.store = API;
}
}());
