/* Backup tests: CSV generation, restore points, roster import.
 *
 * The CSVs are checked against the Python version's, so an organiser's
 * existing spreadsheets keep working across the rewrite.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { TournamentStore } = require('../src/store.js');
const {
  csvText, csvField, buildAll, restorePoint, readRestorePoint, parsePlayerCsv, slug,
} = require('../src/backup.js');

const FAST = { seating: { iterations: 2000, restarts: 1, timeBudget: 1.0 } };

function builtTournament({ players = 8, rounds = 1, cut = false } = {}) {
  const store = new TournamentStore();
  store.create('Backup Cup', { config: FAST });
  const lines = [];
  for (let i = 1; i <= players; i++) lines.push(`Player ${String(i).padStart(2, '0')},Club ${i % 3}`);
  store.addPlayersBulk(lines.join('\n'));
  for (let r = 0; r < rounds; r++) {
    const round = store.generateRound();
    for (const table of store.getRound(round.id).tables) {
      const seats = table.seats.filter((s) => s.playerId);
      store.saveTable(round.id, table.tableNumber,
        seats.map((s, i) => ({ playerId: s.playerId, rawScore: [45000, 32000, 25000, 17000][i] })),
        { riichiLeft: 1, enteredBy: 'runner' });
    }
    store.closeRound(round.id);
  }
  if (cut) store.applyCut({ size: 4, carry: 'reset', rounds: 1 });
  return store;
}

/* ------------------------------------------------------------ csv basics */

test('csv quoting matches the usual dialect', () => {
  assert.equal(csvField('plain'), 'plain');
  assert.equal(csvField('has,comma'), '"has,comma"');
  assert.equal(csvField('has"quote'), '"has""quote"');
  assert.equal(csvField('has\nnewline'), '"has\nnewline"');
  assert.equal(csvField(null), '');
  assert.equal(csvField(0), '0');
});

test('csv rows end with CRLF, as Python writes them', () => {
  assert.equal(csvText([['a', 'b'], [1, 2]]), 'a,b\r\n1,2\r\n');
  assert.equal(csvText([]), '');
});

test('slug is filesystem-safe', () => {
  assert.equal(slug('Autumn Riichi Open 2026!'), 'autumn-riichi-open-2026');
  assert.equal(slug('   '), 'tournament');
});

/* ------------------------------------------------------- the file set */

test('every expected file is produced', () => {
  const files = buildAll(builtTournament());
  // byes.csv and penalties.csv are legitimately header-only here: eight
  // players fill two tables exactly, and nobody has been penalised.
  const alwaysHasData = ['tournament.csv', 'players.csv', 'rounds.csv', 'seating.csv',
    'results.csv', 'standings.csv', 'ara_sheet.csv'];
  const headerOnlyWhenEmpty = ['byes.csv', 'penalties.csv'];

  for (const name of [...alwaysHasData, ...headerOnlyWhenEmpty]) {
    assert.ok(files[name], `${name} missing`);
    assert.ok(files[name].length >= 1, `${name} has no header`);
    assert.ok(files[name][0].length > 1, `${name} header looks wrong`);
  }
  for (const name of alwaysHasData) {
    assert.ok(files[name].length > 1, `${name} has a header but no rows`);
  }
});

test('byes appear once the field does not divide evenly', () => {
  const files = buildAll(builtTournament({ players: 10 })); // 2 tables + 2 sitting out
  const rows = files['byes.csv'];
  assert.equal(rows.length - 1, 2);
  assert.deepEqual(rows[0], ['round', 'phase', 'player_id', 'player_name', 'score']);
});

test('a cut adds the split standings files', () => {
  const files = buildAll(builtTournament({ cut: true }));
  assert.ok(files['standings_qualifying.csv']);
  assert.ok(files['standings_final.csv']);
  const finals = files['standings_final.csv'];
  assert.equal(finals.length - 1, 4); // header + the four who went through
});

test('results carry the table total check on every row', () => {
  const files = buildAll(builtTournament());
  const rows = files['results.csv'];
  const header = rows[0];
  const totalCol = header.indexOf('table_total_check');
  const riichiCol = header.indexOf('riichi_left');
  assert.ok(totalCol > -1 && riichiCol > -1);
  assert.ok(rows.length > 1);
  for (const row of rows.slice(1)) {
    assert.equal(Number(row[totalCol]), 120000);
    assert.equal(Number(row[riichiCol]), 1);
  }
});

test('the ARA sheet has a column per round and separate totals', () => {
  const store = builtTournament({ rounds: 2 });
  const rows = buildAll(store)['ara_sheet.csv'];
  assert.ok(rows[0].includes('R1'));
  assert.ok(rows[0].includes('R2'));
  assert.ok(rows[0].includes('Qualifying total'));
  assert.equal(rows.length - 1, 8);
});

/* ------------------------------------------------------- restore points */

test('a restore point round-trips an entire event', () => {
  const store = builtTournament({ rounds: 2, cut: true });
  const before = store.standings('qualifying').map((s) => s.tournamentScore.toString());

  const text = JSON.stringify(restorePoint(store));
  const revived = new TournamentStore();
  revived.load(readRestorePoint(text));

  assert.deepEqual(
    revived.standings('qualifying').map((s) => s.tournamentScore.toString()), before);
  assert.equal(revived.listPlayers().length, 8);
  assert.equal(revived.listRounds().length, 2);
  assert.ok(revived.doc.config.cut.applied);
});

test('a restore point survives being saved as a file and read back', () => {
  const store = builtTournament();
  const json = JSON.stringify(restorePoint(store), null, 2);
  const doc = readRestorePoint(json);
  assert.equal(doc.name, 'Backup Cup');
});

test('junk is rejected with a readable message', () => {
  assert.throws(() => readRestorePoint('not json at all'), /not valid JSON/);
  assert.throws(() => readRestorePoint('{"hello":"world"}'), /does not look like/);
  assert.throws(() => readRestorePoint('[]'), /does not look like/);
});

test('a restore point with broken rules is caught on load', () => {
  const store = builtTournament();
  const point = restorePoint(store);
  point.tournament.rules.uma = ['15', '5', '-5']; // one short
  assert.throws(() => readRestorePoint(JSON.stringify(point)));
});

/* ---------------------------------------------------------- csv import */

test('headerless roster', () => {
  const rows = parsePlayerCsv('Player 01,Club A\nPlayer 02,Club B');
  assert.equal(rows[0].name, 'Player 01');
  assert.equal(rows[1].club, 'Club B');
});

test('a header in any order', () => {
  const rows = parsePlayerCsv('Club,Player\nClub A,Player 01');
  assert.equal(rows[0].name, 'Player 01');
  assert.equal(rows[0].club, 'Club A');
});

test('alias columns', () => {
  assert.equal(parsePlayerCsv('name,email\nPlayer 01,a@example.com')[0].contact, 'a@example.com');
});

test('names only', () => {
  assert.deepEqual(parsePlayerCsv('Player 01\nPlayer 02\n').map((r) => r.name), ['Player 01', 'Player 02']);
});

test('quoted fields with commas', () => {
  const rows = parsePlayerCsv('name,club\n"Surname, Player 01","Club A, Region"');
  assert.equal(rows[0].name, 'Surname, Player 01');
  assert.equal(rows[0].club, 'Club A, Region');
});

test('blank input', () => {
  assert.deepEqual(parsePlayerCsv('   '), []);
});

test('an unknown role falls back to player', () => {
  assert.equal(parsePlayerCsv('name,role\nPlayer 01,wizard')[0].role, 'player');
});

/* --------------------------------------------- the CSV format is frozen */

/* These headers were verified byte-for-byte against the Python version that
 * this engine was ported from, before that version was retired. They are
 * pinned here so the format cannot drift: organisers have spreadsheets and
 * scripts pointing at these columns. Adding a column at the END is safe;
 * renaming, reordering or removing one is a breaking change. */
const EXPECTED_HEADERS = {
  'ara_sheet.csv':
    ['player_id', 'name', 'club', 'R1', 'Qualifying total', 'Qualifying rank',
      'Finals total', 'Finals rank'],
  'byes.csv':
    ['round', 'phase', 'player_id', 'player_name', 'score'],
  'penalties.csv':
    ['penalty_id', 'player_id', 'player_name', 'round', 'points', 'reason', 'created_at',
      'phase'],
  'players.csv':
    ['player_id', 'name', 'club', 'contact', 'external_id', 'role', 'status',
      'manual_tiebreak', 'notes', 'signed_in'],
  'results.csv':
    ['round', 'phase', 'table', 'seat_wind', 'player_id', 'player_name', 'raw_score',
      'placement', 'score_delta', 'uma', 'oka', 'hanchan_score', 'chombo',
      'penalty_points', 'penalty_note', 'riichi_left', 'table_total_check',
      'entered_by', 'verified_by'],
  'rounds.csv':
    ['round', 'phase', 'label', 'status', 'tables', 'tables_reported', 'seed',
      'created_at', 'closed_at'],
  'seating.csv':
    ['round', 'phase', 'label', 'table', 'seat_index', 'seat_wind', 'player_id',
      'player_name', 'club', 'lobby'],
  'standings.csv':
    ['rank', 'player_id', 'name', 'club', 'tournament_score', 'hanchan_played',
      'firsts', 'seconds', 'thirds', 'fourths', 'best_hanchan', 'average_placement',
      'byes', 'bye_total', 'carry_over', 'penalty_total', 'raw_delta', 'needs_tiebreak',
      'stage'],
  'tournament.csv': ['setting', 'value'],
};

test('the CSV columns have not drifted', () => {
  const store = builtTournament({ rounds: 1, cut: true });
  const files = buildAll(store);
  for (const [name, expected] of Object.entries(EXPECTED_HEADERS)) {
    assert.ok(files[name], `${name} is no longer produced`);
    assert.deepEqual(files[name][0], expected, `${name}: the columns changed`);
  }
  // The two split standings files share the standings layout.
  for (const name of ['standings_qualifying.csv', 'standings_final.csv']) {
    assert.deepEqual(files[name][0], EXPECTED_HEADERS['standings.csv'],
      `${name}: the columns changed`);
  }
});

test('every produced file is one we know about', () => {
  const files = buildAll(builtTournament({ rounds: 1, cut: true }));
  const known = new Set([...Object.keys(EXPECTED_HEADERS),
    'standings_qualifying.csv', 'standings_final.csv']);
  for (const name of Object.keys(files)) {
    assert.ok(known.has(name), `${name} is new -- pin its header in EXPECTED_HEADERS`);
  }
});

/* ------------------------------------------- the tutorial's demo event */

/* A target that records what it was asked to write, so we can assert that
 * nothing at all reaches the organiser's folder for a demo tournament. */
function recordingTarget() {
  const writes = [];
  return {
    writes,
    label: 'recording',
    async write(path, text) { writes.push(['write', path, String(text).length]); },
    async append(path, text) { writes.push(['append', path, String(text).length]); },
    async read() { return ''; },
    async ensurePermission() { return true; },
  };
}

test('a demo tournament is never written to the backup folder', async () => {
  const { BackupManager } = require('../src/backup.js');
  const target = recordingTarget();
  const manager = new BackupManager();
  manager.setTarget(target);

  const store = new TournamentStore();
  store.create('Tutorial — Demo Riichi Open', { config: { ...FAST, demo: true } });
  store.addPlayersBulk(['A,X', 'B,Y', 'C,X', 'D,Y'].join('\n'));
  const round = store.generateRound();
  const seats = store.getRound(round.id).tables[0].seats.filter((s) => s.playerId);
  store.saveTable(round.id, 1,
    seats.map((s, i) => ({ playerId: s.playerId, rawScore: [45000, 32000, 25000, 18000][i] })),
    { enteredBy: 'tutorial' });
  store.closeRound(round.id);

  // Drive the manager the way ui.js does on every change.
  for (const kind of ['tournament_created', 'player_added', 'round_generated',
    'table_saved', 'round_closed']) {
    await manager.handleChange(store, kind, {});
  }

  assert.deepEqual(target.writes, [],
    `the demo event wrote ${target.writes.length} file(s) to the backup folder`);
});

test('a real tournament still is written to the backup folder', async () => {
  const { BackupManager } = require('../src/backup.js');
  const target = recordingTarget();
  const manager = new BackupManager();
  manager.setTarget(target);

  const store = builtTournament({ players: 4, rounds: 1 });
  await manager.handleChange(store, 'round_closed', {});

  assert.ok(target.writes.length > 0,
    'a real tournament wrote nothing — the demo guard is too broad');
  // And it is the demo flag that makes the difference, nothing else.
  assert.equal(store.doc.config.demo, undefined);
});

test('a correction goes into the results log that is never rewritten', async () => {
  const { BackupManager } = require('../src/backup.js');
  const target = recordingTarget();
  const manager = new BackupManager();
  manager.setTarget(target);
  const store = builtTournament({ players: 4, rounds: 1 });
  await manager.handleChange(store, 'table_amended', {
    roundNumber: 1, table: 1, riichiLeft: 0, enteredBy: 'judge', scores: { 1: 45000 },
  });
  assert.ok(target.writes.some(([op, path]) => op === 'append' && /results_log\.csv$/.test(path)),
    'the correction never reached log/results_log.csv');
});

/* ----------------------------------- a backup over the browser's copy */

test('loading a backup asks first when the event is already here', () => {
  const { restoreConflict } = require('../src/backup.js');
  const here = { name: 'Spring Open', updatedAt: '2026-11-20T12:00:00Z' };
  const backup = { name: 'Spring Open', updatedAt: '2026-11-20T15:00:00Z' };
  const c = restoreConflict(here, backup);
  assert.equal(c.newer, false);
  assert.match(c.message, /already in this browser/);
});

test('it says so plainly when the browser\'s copy is the newer one', () => {
  // The wrong snapshot picked at lunchtime used to undo the morning silently.
  const { restoreConflict } = require('../src/backup.js');
  const here = { name: 'Spring Open', updatedAt: '2026-11-20T15:00:00Z' };
  const backup = { name: 'Spring Open', updatedAt: '2026-11-20T12:00:00Z' };
  const c = restoreConflict(here, backup);
  assert.equal(c.newer, true);
  assert.match(c.message, /NEWER/);
  assert.match(c.message, /2026-11-20 15:00:00 UTC/);
});

test('a backup of an event not in this browser loads without asking', () => {
  const { restoreConflict } = require('../src/backup.js');
  assert.equal(restoreConflict(null, { name: 'x', updatedAt: '2026-01-01T00:00:00Z' }), null);
});

/* ------------------------------------------- backups after a restart */

/* A folder handle as the browser hands one back after a restart: the grant
 * has lapsed, and asking again without a click throws. */
function lapsedHandle(name = 'Event backups', { grantOnRequest = true } = {}) {
  const calls = [];
  return {
    name,
    calls,
    async queryPermission() { calls.push('query'); return 'prompt'; },
    async requestPermission() {
      calls.push('request');
      return grantOnRequest ? 'granted' : 'denied';
    },
  };
}

test('checking a lapsed folder never asks for permission', async () => {
  // Asking needs a click. The page used to ask as it loaded, the browser
  // refused, and backups stopped without a word.
  const { FolderTarget } = require('../src/backup.js');
  const handle = lapsedHandle();
  assert.equal(await new FolderTarget(handle).hasPermission(), false);
  assert.deepEqual(handle.calls, ['query']);
});

test('the page only checks the folder as it loads', () => {
  const fs = require('node:fs');
  const ui = fs.readFileSync(require.resolve('../src/ui.js'), 'utf8');
  const start = ui.indexOf('async function init()');
  assert.ok(start > 0, 'init() not found');
  const body = ui.slice(start, ui.indexOf('\n}\n', start));
  assert.match(body, /hasPermission\(\)/);
  assert.doesNotMatch(body, /ensurePermission\(\)|requestPermission\(/,
    'init() asks for permission, which the browser refuses without a click');
});

test('a lapsed folder pauses backups, and says so', async () => {
  const { BackupManager, FolderTarget, backupNotice } = require('../src/backup.js');
  const manager = new BackupManager();
  manager.setAwaiting(new FolderTarget(lapsedHandle('Event backups')));
  const status = manager.status();
  assert.equal(status.awaitingFolder, 'Event backups');
  const notice = backupNotice(status);
  assert.equal(notice.kind, 'paused');
  assert.match(notice.message, /Event backups/);
  assert.equal(notice.action, 'Reconnect');
});

test('reconnecting resumes backups to the same folder', async () => {
  const { BackupManager, FolderTarget, backupNotice } = require('../src/backup.js');
  const manager = new BackupManager();
  const handle = lapsedHandle('Event backups');
  manager.setAwaiting(new FolderTarget(handle));
  assert.equal(await manager.reconnect(), true);
  assert.equal(manager.status().mode, 'folder');
  assert.equal(manager.status().folder, 'Event backups');
  assert.equal(manager.status().awaitingFolder, null);
  assert.equal(backupNotice(manager.status()), null);
  assert.deepEqual(handle.calls, ['query', 'request']);
});

test('a refused reconnect stays paused', async () => {
  const { BackupManager, FolderTarget, backupNotice } = require('../src/backup.js');
  const manager = new BackupManager();
  manager.setAwaiting(new FolderTarget(lapsedHandle('x', { grantOnRequest: false })));
  assert.equal(await manager.reconnect(), false);
  assert.equal(backupNotice(manager.status()).kind, 'paused');
});

test('a failed write is reported on every page, not just the Backups tab', () => {
  const { backupNotice } = require('../src/backup.js');
  const notice = backupNotice({ mode: 'folder', lastError: 'disk full', pendingSinceRound: 0 });
  assert.equal(notice.kind, 'failed');
  assert.equal(notice.level, 'error');
  assert.match(notice.message, /disk full/);
});

test('only closed rounds count towards an overdue backup', async () => {
  const { BackupManager } = require('../src/backup.js');
  const manager = new BackupManager();
  const store = builtTournament({ players: 4, rounds: 1 });
  for (const kind of ['tournament_created', 'round_generated', 'table_saved', 'round_closed']) {
    await manager.handleChange(store, kind, {});
  }
  assert.equal(manager.status().pendingSinceRound, 1);
});

test('an overdue manual backup is reported', () => {
  const { backupNotice } = require('../src/backup.js');
  assert.equal(backupNotice({ mode: 'download', pendingSinceRound: 2 }).kind, 'overdue');
  assert.equal(backupNotice({ mode: 'download', pendingSinceRound: 0 }), null);
});

test('nothing is reported for a test tournament, or when all is well', () => {
  const { backupNotice } = require('../src/backup.js');
  assert.equal(backupNotice({ awaitingFolder: 'x' }, { demo: true }), null);
  assert.equal(backupNotice({ mode: 'folder', lastError: null, pendingSinceRound: 0 }), null);
});

/* ------------------------------------------------- a non-riichi ruleset */

function mcrTournament() {
  const { RULESET_PRESETS } = require('../src/scoring.js');
  const store = new TournamentStore();
  store.create('MCR Open', { rules: RULESET_PRESETS.mcr.rules, config: FAST });
  store.addPlayersBulk(['Player 01,Club A', 'Player 02,Club B', 'Player 03,Club C', 'Player 04,Club D'].join('\n'));
  const round = store.generateRound();
  const seats = store.getRound(round.id).tables[0].seats.filter((s) => s.playerId);
  store.saveTable(round.id, 1,
    seats.map((s, i) => ({ playerId: s.playerId, rawScore: [120, 40, -30, -130][i] })),
    { enteredBy: 'umpire' });
  store.closeRound(round.id);
  return store;
}

test('an MCR event produces the same CSV set as any other', () => {
  const store = mcrTournament();
  const files = buildAll(store);
  // Same contract: the column layout does not change with the ruleset.
  assert.deepEqual(Object.keys(files).sort(), Object.keys(buildAll(builtTournament())).sort());

  const rows = files['results.csv'];
  const header = rows[0];
  const body = rows.slice(1);
  assert.equal(body.length, 4);

  const i = (name) => header.indexOf(name);
  const first = body.find((r) => String(r[i('placement')]) === '1');
  assert.equal(String(first[i('raw_score')]), '120', 'the session total is kept as entered');
  assert.equal(String(first[i('hanchan_score')]), '4', 'the winner takes 4 table points');
  // The placement bonus rides in the uma column, which is what that column has
  // always meant: what finishing in that place is worth.
  assert.equal(String(first[i('uma')]), '4');
  assert.equal(String(first[i('oka')]), '0', 'MCR has no oka');
});

test('an MCR event survives a restore point', () => {
  const store = mcrTournament();
  const restored = new TournamentStore();
  restored.load(readRestorePoint(restorePoint(store)));

  // The scoring model has to come back, or the event silently becomes riichi
  // and every result changes.
  assert.equal(restored.doc.rules.scoringModel, 'table_points');
  assert.equal(restored.doc.rules.pointDivisor, 1);
  assert.equal(restored.doc.rules.scoreStep, 1);
  assert.equal(restored.doc.rules.scorePrecision, 0);

  const before = store.standings('overall').map((s) => `${s.name}=${s.tournamentScore}`);
  const after = restored.standings('overall').map((s) => `${s.name}=${s.tournamentScore}`);
  assert.deepEqual(after, before, 'the standings must survive the round trip unchanged');
  assert.deepEqual(after.map((s) => s.split('=')[1]), ['4', '2', '1', '0']);
});
