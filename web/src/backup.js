/* Backups: the CSV files, the folder on disk, and restore points.
 *
 * A port of mahjong/backup.py, with one important change of emphasis.
 *
 * In the server version the CSVs were a mirror of a database that lived on
 * disk. Here the working copy lives in the browser, and the browser's storage
 * belongs to the browser profile, not to the folder the app was opened from:
 * copy the folder to another laptop and the tournament does not come with it.
 *
 * So the files this module writes are not a mirror. They are the record.
 *
 *   live/        the full CSV set, rewritten after every change
 *   log/         append-only: every change, and every score ever entered
 *   snapshots/   a dated copy each time a round closes
 *   restore/     tournament.json -- everything needed to rebuild the event
 *
 * On Chrome and Edge these are written straight into a folder the organiser
 * picks once. Point that at a OneDrive or Google Drive folder and every round
 * is backed up offsite with no account, no API and no network code: the
 * desktop sync client does the work. Safari and Firefox have no File System
 * Access API, so they fall back to ordinary downloads.
 */
(function () {
'use strict';

/* eslint-disable no-undef */
const _scoring = (typeof require === 'function') ? require('./scoring.js') : window.RT.scoring;
const { SEAT_WINDS, ScoreRules } = _scoring;

const LIVE_FILES = [
  'tournament.csv', 'players.csv', 'rounds.csv', 'seating.csv', 'results.csv',
  'standings.csv', 'standings_qualifying.csv', 'standings_final.csv',
  'byes.csv', 'penalties.csv', 'ara_sheet.csv',
];

const SNAPSHOT_EVENTS = new Set([
  'round_closed', 'cut_applied', 'tournament_created', 'round_generated',
]);

/* ------------------------------------------------------------------- csv */

/** Quote a CSV field the way Python's csv module does. */
function csvField(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Rows to CSV text. Uses \r\n, matching Python's csv default dialect. */
function csvText(rows) {
  return rows.map((row) => row.map(csvField).join(',')).join('\r\n') + (rows.length ? '\r\n' : '');
}

const slug = (text, fallback = 'tournament') =>
  (String(text || '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase()
    || fallback);

const stamp = (d = new Date()) =>
  d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

const wind = (seatIndex) => SEAT_WINDS[seatIndex] ?? '?';

/* --------------------------------------------------------- the CSV files */

function tournamentRows(store) {
  const t = store.doc;
  const rules = store.rules;
  const c = t.config;
  const cut = c.cut || {};
  return [
    ['setting', 'value'],
    ['name', t.name],
    ['mode', t.mode],
    ['status', t.status],
    ['ruleset', c.rulesetLabel || ''],
    ['venue', c.venue || ''],
    ['created_at', t.createdAt],
    ['updated_at', t.updatedAt],
    ['players_per_table', rules.playersPerTable],
    ['starting_points', rules.startingPoints],
    ['goal_points', rules.goalPoints],
    ['oka_p', rules.oka.toString()],
    ['uma', rules.uma.map((u) => u.toString()).join(' / ')],
    ['tie_mode', rules.tieMode],
    ['score_precision', rules.scorePrecision],
    ['score_rounding', rules.scoreRounding],
    ['chombo_mode', rules.chomboMode],
    ['chombo_penalty_p', rules.chomboPenalty.toString()],
    ['bye_mode', rules.byeMode],
    ['bye_score_p', rules.byeScore.toString()],
    ['tiebreaks', rules.tiebreaks.join(' > ')],
    ['table_total_check', rules.tableTotal],
    ['planned_rounds', c.plannedRounds ?? ''],
    ['hanchan_minutes', c.hanchanMinutes ?? ''],
    ['cut_size', cut.size ?? ''],
    ['cut_rounds', cut.rounds ?? ''],
    ['cut_carry', cut.carry ?? ''],
    ['cut_applied', cut.applied ? 'True' : 'False'],
  ];
}

function playerRows(store) {
  const rows = [['player_id', 'name', 'club', 'contact', 'external_id', 'role',
    'status', 'manual_tiebreak', 'notes']];
  for (const p of store.listPlayers()) {
    rows.push([p.id, p.name, p.club, p.contact, p.externalId, p.role,
      p.status, p.manualTiebreak, p.notes]);
  }
  return rows;
}

function roundRows(details) {
  const rows = [['round', 'phase', 'label', 'status', 'tables', 'tables_reported',
    'seed', 'created_at', 'closed_at']];
  for (const r of details) {
    rows.push([r.number, r.phase, r.label, r.status, r.tablesTotal, r.tablesReported,
      r.seed, r.createdAt, r.closedAt || '']);
  }
  return rows;
}

function seatingRows(details) {
  const rows = [['round', 'phase', 'label', 'table', 'seat_index', 'seat_wind',
    'player_id', 'player_name', 'club', 'lobby']];
  for (const r of details) {
    for (const table of r.tables) {
      for (const seat of table.seats) {
        rows.push([r.number, r.phase, r.label, table.tableNumber, seat.seatIndex,
          wind(seat.seatIndex), seat.playerId ?? '', seat.name || '(empty)',
          seat.club, table.lobby || '']);
      }
    }
  }
  return rows;
}

function resultRows(details) {
  const rows = [['round', 'phase', 'table', 'seat_wind', 'player_id', 'player_name',
    'raw_score', 'placement', 'score_delta', 'uma', 'oka', 'hanchan_score',
    'chombo', 'penalty_points', 'penalty_note', 'riichi_left', 'table_total_check',
    'entered_by', 'verified_by']];
  for (const r of details) {
    for (const table of r.tables) {
      const byPlayer = new Map(
        (table.outcome ? table.outcome.seats : []).map((s) => [s.playerId, s]));
      const total = table.seats.reduce((a, s) => a + (s.rawScore || 0), 0)
        + 1000 * table.riichiLeft;
      for (const seat of table.seats) {
        if (seat.rawScore === null || seat.rawScore === undefined) continue;
        const o = byPlayer.get(seat.playerId) || {};
        rows.push([r.number, r.phase, table.tableNumber, wind(seat.seatIndex),
          seat.playerId, seat.name, seat.rawScore,
          o.placement ?? '', o.scoreDelta ?? '', o.uma ?? '', o.oka ?? '',
          o.hanchanScore ?? '', seat.chombo, seat.penaltyPoints, seat.penaltyNote,
          table.riichiLeft, total, table.enteredBy || '', table.verifiedBy || '']);
      }
    }
  }
  return rows;
}

function byeRows(details) {
  const rows = [['round', 'phase', 'player_id', 'player_name', 'score']];
  for (const r of details) {
    for (const b of r.byes) rows.push([r.number, r.phase, b.playerId, b.name, b.score]);
  }
  return rows;
}

function penaltyRows(store) {
  // `phase` was added at the end, where a new column breaks nobody's sheet.
  const rows = [['penalty_id', 'player_id', 'player_name', 'round', 'points',
    'reason', 'created_at', 'phase']];
  for (const p of store.listPenalties()) {
    rows.push([p.id, p.playerId, p.playerName, p.roundNumber ?? '',
      p.points, p.reason, p.createdAt, p.phase]);
  }
  return rows;
}

function standingRows(standings, players, precision) {
  const clubs = new Map(players.map((p) => [p.id, p.club]));
  const rows = [['rank', 'player_id', 'name', 'club', 'tournament_score',
    'hanchan_played', 'firsts', 'seconds', 'thirds', 'fourths', 'best_hanchan',
    'average_placement', 'byes', 'bye_total', 'carry_over', 'penalty_total',
    'raw_delta', 'needs_tiebreak', 'stage']];
  for (const s of standings) {
    rows.push([
      s.rank, s.playerId, s.name, clubs.get(s.playerId) || '',
      s.tournamentScore.toFixed(precision), s.hanchanPlayed,
      s.firsts, s.seconds, s.thirds, s.fourths,
      s.bestHanchan ? s.bestHanchan.toFixed(precision) : '',
      s.averagePlacement ? s.averagePlacement.truncate(3).toFixed(3) : '',
      s.byes, s.byeTotal.toFixed(precision), s.carryOver.toFixed(precision),
      s.penaltyTotal.toFixed(precision), s.rawDelta.toFixed(precision),
      s.needsCoinToss ? 'yes' : '',
      // After a cut, the overall file mixes two stages: which score this is.
      s.stage || '',
    ]);
  }
  return rows;
}

/**
 * One row per player, one column per round -- the ARA sheet layout.
 * Qualifying and finals total separately, because a cut that resets points
 * makes a combined total meaningless.
 */
function araSheetRows(store, details, players, precision) {
  const cutApplied = Boolean((store.doc.config.cut || {}).applied);
  const perRound = new Map();
  const roundPhase = new Map();

  for (const r of details) {
    if (!['qualifying', 'final'].includes(r.phase)) continue;
    const column = new Map();
    for (const table of r.tables) {
      if (!table.outcome) continue;
      for (const seat of table.outcome.seats) column.set(seat.playerId, seat.hanchanScore);
    }
    for (const b of r.byes) column.set(b.playerId, b.score);
    perRound.set(r.number, column);
    roundPhase.set(r.number, r.phase);
  }

  const numbers = [...perRound.keys()].sort((a, b) => a - b);
  const qualifying = new Map(store.standings('qualifying').map((s) => [s.playerId, s]));
  const finals = cutApplied
    ? new Map(store.standings('final').map((s) => [s.playerId, s]))
    : new Map();

  const header = ['player_id', 'name', 'club'];
  for (const n of numbers) header.push(roundPhase.get(n) === 'final' ? `R${n} final` : `R${n}`);
  header.push('Qualifying total', 'Qualifying rank');
  if (cutApplied) header.push('Finals total', 'Finals rank');
  const rows = [header];

  const sorted = [...players].sort((a, b) => {
    const fa = finals.has(a.id) ? finals.get(a.id).rank : 1e6;
    const fb = finals.has(b.id) ? finals.get(b.id).rank : 1e6;
    if (fa !== fb) return fa - fb;
    const qa = qualifying.has(a.id) ? qualifying.get(a.id).rank : 1e6;
    const qb = qualifying.has(b.id) ? qualifying.get(b.id).rank : 1e6;
    if (qa !== qb) return qa - qb;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });

  for (const p of sorted) {
    const row = [p.id, p.name, p.club];
    for (const n of numbers) row.push(perRound.get(n).get(p.id) ?? '');
    const qs = qualifying.get(p.id);
    row.push(qs ? qs.tournamentScore.toFixed(precision) : '', qs ? qs.rank : '');
    if (cutApplied) {
      const fs = finals.get(p.id);
      row.push(fs ? fs.tournamentScore.toFixed(precision) : '', fs ? fs.rank : '');
    }
    rows.push(row);
  }
  return rows;
}

/** Build every live CSV for the tournament currently in the store. */
function buildAll(store) {
  const t = store.doc;
  const precision = store.rules.scorePrecision;
  const players = store.listPlayers();
  const details = store.listRounds().map((r) => store.getRound(r.id));
  const cut = t.config.cut || {};

  const out = {
    'tournament.csv': tournamentRows(store),
    'players.csv': playerRows(store),
    'rounds.csv': roundRows(details),
    'seating.csv': seatingRows(details),
    'results.csv': resultRows(details),
    'byes.csv': byeRows(details),
    'penalties.csv': penaltyRows(store),
    'standings.csv': standingRows(store.standings('overall'), players, precision),
    'ara_sheet.csv': araSheetRows(store, details, players, precision),
  };
  if (cut.applied) {
    out['standings_qualifying.csv'] =
      standingRows(store.standings('qualifying'), players, precision);
    out['standings_final.csv'] =
      standingRows(store.standings('final'), players, precision);
  }
  return out;
}

/** The restore point: everything needed to rebuild the event. */
function restorePoint(store) {
  return {
    format: 'riichi-tournament-restore',
    version: 2,
    savedAt: new Date().toISOString(),
    tournament: store.doc,
  };
}

function readRestorePoint(text) {
  let data;
  try {
    data = typeof text === 'string' ? JSON.parse(text) : text;
  } catch (err) {
    throw new Error('That file is not a restore point (it is not valid JSON).');
  }
  if (!data || typeof data !== 'object') {
    throw new Error('That file is not a restore point.');
  }
  const doc = data.tournament || (data.players && data.rounds ? data : null);
  if (!doc || !Array.isArray(doc.players) || !Array.isArray(doc.rounds)) {
    throw new Error('That file does not look like a tournament restore point.');
  }
  // Validate the rules before handing it back, so a corrupt file is caught
  // here rather than halfway through a round.
  ScoreRules.fromJSON(doc.rules || {});
  return doc;
}

/* ------------------------------------------------- destinations on disk */

/**
 * Writes into a real folder via the File System Access API.
 * Chrome and Edge only; the caller falls back to downloads elsewhere.
 */
class FolderTarget {
  constructor(handle) {
    this.handle = handle;
    this.kind = 'folder';
  }

  static get supported() {
    return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
  }

  static async pick() {
    const handle = await window.showDirectoryPicker({ id: 'riichi-backups', mode: 'readwrite' });
    return new FolderTarget(handle);
  }

  get name() { return this.handle.name; }

  /**
   * Whether the folder can be written to right now, without asking. A query
   * needs no click, so this is what the page can safely call as it loads.
   */
  async hasPermission() {
    return (await this.handle.queryPermission({ mode: 'readwrite' })) === 'granted';
  }

  /**
   * Re-prompt only if the grant has lapsed. A prompt needs a click to answer
   * -- the browser refuses one asked for as the page loads -- so call this
   * from a button.
   */
  async ensurePermission() {
    const opts = { mode: 'readwrite' };
    if ((await this.handle.queryPermission(opts)) === 'granted') return true;
    return (await this.handle.requestPermission(opts)) === 'granted';
  }

  async subdir(path) {
    let dir = this.handle;
    for (const part of path.split('/').filter(Boolean)) {
      dir = await dir.getDirectoryHandle(part, { create: true });
    }
    return dir;
  }

  async write(path, contents) {
    const parts = path.split('/');
    const filename = parts.pop();
    const dir = parts.length ? await this.subdir(parts.join('/')) : this.handle;
    const file = await dir.getFileHandle(filename, { create: true });
    const writable = await file.createWritable();
    await writable.write(contents);
    await writable.close();
  }

  async append(path, contents) {
    const parts = path.split('/');
    const filename = parts.pop();
    const dir = parts.length ? await this.subdir(parts.join('/')) : this.handle;
    const file = await dir.getFileHandle(filename, { create: true });
    let existing = '';
    try {
      existing = await (await file.getFile()).text();
    } catch { /* new file */ }
    const writable = await file.createWritable();
    await writable.write(existing + contents);
    await writable.close();
  }

  async read(path) {
    const parts = path.split('/');
    const filename = parts.pop();
    const dir = parts.length ? await this.subdir(parts.join('/')) : this.handle;
    const file = await dir.getFileHandle(filename, { create: false });
    return (await file.getFile()).text();
  }
}

/** Fallback for Safari and Firefox: hand the browser a download. */
function downloadFile(filename, contents, type = 'text/csv;charset=utf-8') {
  const blob = contents instanceof Blob ? contents : new Blob([contents], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/* ------------------------------------------------------- backup manager */

class BackupManager {
  constructor({ target = null, onStatus = null } = {}) {
    this.target = target;
    this.onStatus = onStatus;
    this.lastError = null;
    this.lastWrite = null;
    this.lastSnapshot = null;
    this.pendingSinceRound = 0;
    this.writing = Promise.resolve();
    // A folder chosen in an earlier session whose grant has lapsed. Nothing is
    // written while it waits; reconnect() asks again, from a click.
    this.awaiting = null;
  }

  get mode() {
    if (this.target) return 'folder';
    return FolderTarget.supported ? 'none' : 'download';
  }

  get folderName() {
    return this.target ? this.target.name : null;
  }

  setTarget(target) {
    this.target = target;
    this.awaiting = null;
    this.pendingSinceRound = 0;
  }

  /**
   * Hold on to a folder the browser will not let us write to yet.
   *
   * After a browser restart Chrome forgets the grant and wants it asked for
   * again, but refuses a request made as the page loads. That used to fail
   * silently, and backups simply stopped, with nothing outside the Backups tab
   * to say so. Now the folder waits here and the interface says so everywhere.
   */
  setAwaiting(target) {
    this.awaiting = target;
  }

  /** Ask for the waiting folder again. Call from a click. */
  async reconnect() {
    if (!this.awaiting) return Boolean(this.target);
    if (!(await this.awaiting.ensurePermission())) return false;
    this.setTarget(this.awaiting);
    return true;
  }

  status() {
    return {
      mode: this.mode,
      folder: this.folderName,
      lastWrite: this.lastWrite,
      lastSnapshot: this.lastSnapshot,
      lastError: this.lastError,
      pendingSinceRound: this.pendingSinceRound,
      supported: FolderTarget.supported,
      awaitingFolder: this.awaiting ? this.awaiting.name : null,
    };
  }

  /** Serialise writes so two rapid changes cannot interleave on one file. */
  queue(work) {
    this.writing = this.writing.then(work, work).catch((err) => {
      this.lastError = String(err && err.message ? err.message : err);
      if (this.onStatus) this.onStatus(this.status());
    });
    return this.writing;
  }

  prefix(store) {
    return `${slug(store.doc.name)}`;
  }

  /** Called after every change the store makes. */
  handleChange(store, kind, payload) {
    // The tutorial's demo event is never written to the organiser's folder. It
    // would put a fake tournament in among the real ones, and the tutorial
    // promises in as many words that it does not.
    if (store && store.doc && store.doc.config && store.doc.config.demo) {
      return Promise.resolve();
    }
    if (!this.target) {
      // Rounds closed, as the warning says -- not every snapshot-worthy event,
      // which counted creating the event and drawing a round as well, and
      // reported three rounds overdue after the first one closed.
      if (kind === 'round_closed') this.pendingSinceRound += 1;
      return Promise.resolve();
    }
    return this.queue(async () => {
      await this.appendAudit(store, kind, payload);
      if (kind === 'table_saved') await this.appendResultLog(store, payload);
      await this.refresh(store);
      if (SNAPSHOT_EVENTS.has(kind)) await this.snapshot(store, kind);
      this.lastError = null;
      this.pendingSinceRound = 0;
      if (this.onStatus) this.onStatus(this.status());
    });
  }

  async appendAudit(store, kind, payload) {
    const base = this.prefix(store);
    const line = csvText([[new Date().toISOString(), kind, JSON.stringify(payload || {})]]);
    const path = `${base}/log/audit.csv`;
    let header = '';
    try {
      const existing = await this.target.read(path);
      if (!existing) header = csvText([['timestamp_utc', 'event', 'detail_json']]);
    } catch {
      header = csvText([['timestamp_utc', 'event', 'detail_json']]);
    }
    await this.target.append(path, header + line);
  }

  async appendResultLog(store, payload) {
    const base = this.prefix(store);
    const names = new Map(store.listPlayers().map((p) => [p.id, p.name]));
    const at = new Date().toISOString();
    const rows = Object.entries(payload.scores || {}).map(([pid, raw]) => [
      at, payload.roundNumber ?? '', payload.table ?? '', pid,
      names.get(Number(pid)) || '?', raw, payload.riichiLeft ?? 0, payload.enteredBy || '',
    ]);
    if (!rows.length) return;
    const path = `${base}/log/results_log.csv`;
    let header = '';
    try {
      const existing = await this.target.read(path);
      if (!existing) throw new Error('empty');
    } catch {
      header = csvText([['timestamp_utc', 'round', 'table', 'player_id',
        'player_name', 'raw_score', 'riichi_left', 'entered_by']]);
    }
    await this.target.append(path, header + csvText(rows));
  }

  /** Rewrite the live CSV set and the restore point. */
  async refresh(store) {
    const base = this.prefix(store);
    const files = buildAll(store);
    for (const [name, rows] of Object.entries(files)) {
      await this.target.write(`${base}/live/${name}`, csvText(rows));
    }
    await this.target.write(
      `${base}/restore/tournament.json`,
      JSON.stringify(restorePoint(store), null, 2));
    this.lastWrite = new Date().toISOString();
    return files;
  }

  /** A dated copy, kept forever. */
  async snapshot(store, label = 'manual') {
    const base = this.prefix(store);
    const dir = `${base}/snapshots/${stamp()}-${slug(label, 'snapshot')}`;
    const files = buildAll(store);
    for (const [name, rows] of Object.entries(files)) {
      await this.target.write(`${dir}/${name}`, csvText(rows));
    }
    await this.target.write(`${dir}/tournament.json`,
      JSON.stringify(restorePoint(store), null, 2));
    this.lastSnapshot = dir;
    return dir;
  }

  /** Download everything as one file, for the browsers with no folder access. */
  downloadRestorePoint(store) {
    downloadFile(
      `${slug(store.doc.name)}-${stamp()}.json`,
      JSON.stringify(restorePoint(store), null, 2),
      'application/json');
    this.pendingSinceRound = 0;
    if (this.onStatus) this.onStatus(this.status());
  }

  downloadCsv(store, name) {
    const files = buildAll(store);
    if (!files[name]) {
      throw new Error(`Unknown export ${name}. Available: ${Object.keys(files).sort().join(', ')}`);
    }
    downloadFile(name, csvText(files[name]));
  }

  downloadAllCsv(store) {
    for (const [name, rows] of Object.entries(buildAll(store))) {
      downloadFile(name, csvText(rows));
    }
  }
}

/* ------------------------------------------------------------ importing */

/**
 * Read a roster from CSV, or a plain list of names.
 *
 * Accepts a header row naming the columns in any order, or a headerless file
 * where the columns are name, club, contact.
 */
function parsePlayerCsv(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return [];

  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const src = trimmed.replace(/\r\n?/g, '\n');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  row.push(field);
  rows.push(row);

  const used = rows.filter((r) => r.some((c) => String(c || '').trim()));
  if (!used.length) return [];

  const aliases = {
    name: 'name', player: 'name', player_name: 'name', 'full name': 'name',
    club: 'club', team: 'club', affiliation: 'club',
    contact: 'contact', email: 'contact',
    external_id: 'externalId', id: 'externalId', account: 'externalId',
    role: 'role', notes: 'notes', note: 'notes',
  };
  const header = used[0].map((c) => String(c || '').trim().toLowerCase());
  const mapped = header.map((h) => aliases[h]);
  const hasHeader = mapped.includes('name');

  const out = [];
  for (const line of hasHeader ? used.slice(1) : used) {
    const record = {};
    if (hasHeader) {
      mapped.forEach((key, index) => {
        if (key && index < line.length) record[key] = String(line[index] || '').trim();
      });
    } else {
      record.name = String(line[0] || '').trim();
      if (line.length > 1) record.club = String(line[1] || '').trim();
      if (line.length > 2) record.contact = String(line[2] || '').trim();
    }
    if (record.name) {
      if (!['player', 'sit_in'].includes(record.role)) record.role = 'player';
      out.push(record);
    }
  }
  return out;
}

/**
 * What to tell the organiser about backups on every page, or null.
 *
 * Backups failing used to show only on the Backups tab, which nobody looks at
 * mid-event. Kept pure so it can be tested without a browser.
 *
 *   paused   a folder is chosen but the browser wants permission again
 *   failed   the last write to the folder went wrong
 *   overdue  no folder access, and rounds have closed since the last download
 */
function backupNotice(status, { demo = false } = {}) {
  if (demo || !status) return null;
  if (status.awaitingFolder) {
    return {
      kind: 'paused',
      level: 'warn',
      message: `Backups are paused. After a restart the browser needs your permission `
        + `again to write to "${status.awaitingFolder}". Your work is still saved in `
        + 'this browser.',
      action: 'Reconnect',
    };
  }
  if (status.mode === 'folder' && status.lastError) {
    return {
      kind: 'failed',
      level: 'error',
      message: `The last backup failed: ${status.lastError}. Your work is still saved `
        + 'in this browser.',
      action: 'Open Backups',
    };
  }
  if (status.mode === 'download' && status.pendingSinceRound > 0) {
    const n = status.pendingSinceRound;
    return {
      kind: 'overdue',
      level: 'warn',
      message: `${n} round${n === 1 ? ' has' : 's have'} closed since the last saved `
        + 'backup.',
      action: 'Save a restore point',
    };
  }
  return null;
}

const API = {
  LIVE_FILES, SNAPSHOT_EVENTS, backupNotice,
  csvField, csvText, slug, stamp,
  buildAll, restorePoint, readRestorePoint,
  FolderTarget, downloadFile, BackupManager, parsePlayerCsv,
};

if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof window !== 'undefined') {
  window.RT = window.RT || {};
  window.RT.backup = API;
}
}());
