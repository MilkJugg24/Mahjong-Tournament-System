/* The browser interface.
 *
 * Adapted from the server version's app.js. The structure is the same; what
 * changed is that there is no server: every call that used to be a fetch() is
 * now a direct call into the store, which makes most of the interface
 * synchronous. The asynchronous parts left are the ones that touch storage --
 * IndexedDB for the working copy, and the File System Access API for backups.
 */
(function () {
'use strict';

/* eslint-disable no-undef */
const { ScoreRules, SEAT_WINDS, SEAT_WIND_NAMES, RULESET_PRESETS } = window.RT.scoring;
const { TournamentStore, StoreError } = window.RT.store;
const {
  BackupManager, FolderTarget, buildAll, csvText, restorePoint, readRestorePoint,
  parsePlayerCsv, downloadFile, slug, stamp, backupNotice, restoreConflict,
} = window.RT.backup;
const { Persistence } = window.RT.persist;
const { printPage, openPrintWindow } = window.RT.printing;
const {
  clockReading, formatClock, clockNote, clockHtml, displayBody, displayShell, fitToScreen,
} = window.RT.display;

/* The room display window, if open, and what it is showing. */
const display = { win: null, mode: 'seating' };
const {
  DiscordPoster, pairingsMessage, standingsMessage, parseWebhook,
} = window.RT.discord;
const { testRoster, isSubName, fillOpenRound } = window.RT.testdata;
const { FIELD_HELP, TOPICS } = window.RT.help;
const tutorialKit = window.RT.tutorial;

const WINDS = SEAT_WINDS;

/* The rulesets live in scoring.js, with the documents they are quoted from. */
const PRESETS = RULESET_PRESETS;

const persistence = new Persistence();
const backups = new BackupManager({
  onStatus: () => {
    // A failed write has to show on whatever page the organiser is on.
    renderBackupBanner();
    if (state.view === 'backups') render();
  },
});

const state = {
  store: new TournamentStore(),
  tournaments: [],
  round: null,
  standings: [],
  scope: 'overall',
  view: 'home',
  storageOk: true,
  storageReason: '',
  helpTopic: TOPICS[0].id,
  // Rules filled into the Setup form but not yet saved.
  pendingRules: null,
  pendingLabel: '',
  tutorial: null,
  tutorialStep: null,
  // A closed round being corrected, as { event, roundId }; null for the usual page.
  amendRound: null,
};

// Every change: save the working copy, then write the record to disk.
state.store.onChange = (doc, kind, payload) => {
  persistence.saveTournament(doc).catch((err) => {
    state.storageOk = false;
    state.storageReason = String(err && err.message ? err.message : err);
    toast(`Could not save to this browser: ${state.storageReason}`, 'error', 9000);
  });
  backups.handleChange(state.store, kind, payload);
  discordOnChange(kind);
  refreshDisplay();
};

/* ------------------------------------------------------------- helpers */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function esc(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/* How many decimals the current tournament keeps. One, until there is a
 * tournament to ask -- MCR keeps none, so this cannot be a constant. */
function scorePlaces() {
  try {
    return state.store.doc ? state.store.rules.scorePrecision : 1;
  } catch {
    return 1;
  }
}

function fmtScore(value, places = null) {
  if (value === null || value === undefined || value === '') return '';
  const n = Number(value.toString ? value.toString() : value);
  if (!Number.isFinite(n)) return String(value);
  const p = places === null ? scorePlaces() : places;
  return (n > 0 ? '+' : '') + n.toFixed(p);
}

const fmtPoints = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString('en-US') : String(value ?? '');
};

const when = (iso) => String(iso || '').replace('T', ' ').replace(/Z$/, ' UTC');

function toast(message, kind = 'ok', ms = 4200) {
  const el = document.createElement('div');
  el.className = 'toast' + (kind === 'ok' ? '' : ' ' + kind);
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

/** Run something that may throw a StoreError and show the message. */
function guard(fn) {
  try {
    const out = fn();
    if (out && typeof out.catch === 'function') {
      return out.catch((err) => {
        toast(err instanceof StoreError ? err.message : String(err.message || err), 'error', 8000);
        return null;
      });
    }
    return out;
  } catch (err) {
    toast(err instanceof StoreError ? err.message : String(err.message || err), 'error', 8000);
    return null;
  }
}

/* ------------------------------------------------------------ dialogs
 *
 * In-app questions, in place of the browser's own confirm() and prompt().
 * Those looked like a different program, answered every question with a bare
 * "OK", and some browsers offer to silence a page that uses them often. These
 * name the action, mark one that destroys something, and take Enter and
 * Escape. They sit above the score sheet, so the sheet can ask too.
 *
 * ask(question) resolves true or false; with `input`, the text or null. A
 * question is a string, or { text, confirm, danger, input: { label, value } }.
 */
function ask(question) {
  const q = typeof question === 'string' ? { text: question } : question;
  return new Promise((resolve) => {
    const host = $('#ask');
    const field = q.input
      ? `<label class="field" style="margin-top:12px"><span>${esc(q.input.label)}</span>
        <input type="text" id="askInput" value="${esc(q.input.value || '')}" autocomplete="off"></label>`
      : '';
    host.innerHTML = `<div class="ask-backdrop" id="askBackdrop">
      <div class="ask" role="alertdialog" aria-modal="true" aria-labelledby="askText">
        <p id="askText">${esc(q.text)}</p>${field}
        <div class="btnrow ask-actions">
          <span class="spacer"></span>
          <button class="ghost" id="askCancel">Cancel</button>
          <button class="${q.danger ? 'danger' : 'primary'}" id="askOk">${esc(q.confirm || 'OK')}</button>
        </div>
      </div>
    </div>`;
    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        cancel();
      } else if (e.key === 'Enter' && document.activeElement !== $('#askCancel')) {
        e.preventDefault();
        e.stopImmediatePropagation();
        ok();
      }
    }
    // Capture, so Escape closes this question and not the score sheet under it.
    document.addEventListener('keydown', onKey, true);
    const done = (answer) => {
      document.removeEventListener('keydown', onKey, true);
      host.innerHTML = '';
      resolve(answer);
    };
    const ok = () => done(q.input ? $('#askInput').value : true);
    const cancel = () => done(q.input ? null : false);
    $('#askOk').addEventListener('click', ok);
    $('#askCancel').addEventListener('click', cancel);
    $('#askBackdrop').addEventListener('click', (e) => { if (e.target.id === 'askBackdrop') cancel(); });
    (q.input ? $('#askInput') : $('#askOk')).focus();
  });
}

const confirmThen = (question, fn) => ask(question).then((yes) => (yes ? fn() : null));

const hasTournament = () => Boolean(state.store.doc);

/* A test tournament, or the tutorial's demo. Either way: not a real event, so
 * nothing leaves the machine and every page says so. */
const isTestEvent = () => {
  const t = state.store.doc;
  return Boolean(t && t.config && t.config.demo);
};

/* ------------------------------------------------------------ rendering */

function setView(view) {
  // An unsaved ruleset fill-in belongs to the Setup form only.
  if (state.view === 'setup' && view !== 'setup') {
    state.pendingRules = null;
    state.pendingLabel = '';
  }
  state.view = view;
  $$('nav.tabs button').forEach((b) =>
    b.setAttribute('aria-selected', String(b.dataset.view === view)));
  $$('section.view').forEach((s) => s.classList.toggle('active', s.id === 'view-' + view));
  render();
  window.scrollTo({ top: 0 });
}

function render() {
  const has = hasTournament();
  $$('nav.tabs button').forEach((b) => {
    if (b.dataset.view !== 'home') b.disabled = !has;
  });
  $('#eventName').textContent = has
    ? state.store.doc.name + (state.store.doc.mode === 'online' ? ' · online' : '')
    : '';

  const banner = $('#testBanner');
  if (isTestEvent()) {
    banner.className = 'on';
    banner.innerHTML = `<b>Test tournament.</b> Made-up data for trying things out.
      Nothing is written to your backup folder. Discord posts do go out, marked
      as a test, so the feature can be rehearsed.`;
  } else {
    banner.className = '';
    banner.innerHTML = '';
  }

  renderBackupBanner();

  if (state.view === 'home') renderHome();
  if (state.view === 'setup') renderSetup();
  if (state.view === 'players') renderPlayers();
  if (state.view === 'round') renderRound();
  if (state.view === 'standings') renderStandings();
  if (state.view === 'finals') renderFinals();
  if (state.view === 'backups') renderBackups();
  if (state.view === 'help') renderHelp();
}

/** The backups notice, on every page: paused, failed or overdue. */
function renderBackupBanner() {
  const host = $('#backupBanner');
  if (!host) return;
  const notice = backupNotice(backups.status(), { demo: isTestEvent() });
  if (!notice) {
    host.className = '';
    host.innerHTML = '';
    return;
  }
  host.className = `on ${notice.level}`;
  host.innerHTML = `<span>${esc(notice.message)}</span>
    <button class="ghost" id="backupAct">${esc(notice.action)}</button>`;
  $('#backupAct').addEventListener('click', () => guard(async () => {
    if (notice.kind === 'paused') {
      // This click is what lets the browser ask; it refuses on page load.
      if (!(await backups.reconnect())) {
        toast('The browser did not give permission. Try again, or choose the folder '
          + 'afresh on the Backups tab.', 'warn', 9000);
        return null;
      }
      if (hasTournament()) {
        await backups.refresh(state.store);
        await backups.snapshot(state.store, 'reconnected');
      }
      toast(`Backing up to "${backups.status().folder}" again.`);
      render();
    } else if (notice.kind === 'overdue' && hasTournament()) {
      backups.downloadRestorePoint(state.store);
      toast('Restore point saved to your downloads.');
      render();
    } else {
      setView('backups');
    }
    return null;
  }));
}

/* ---------------------------------------------------------------- home */

function renderHome() {
  const host = $('#tournamentList');
  const warn = !state.storageOk
    ? `<div class="issue error">This browser will not let the page save anything
       (${esc(state.storageReason)}). A private window often causes this. Your work
       will be lost when you close the tab unless you keep saving backups.</div>`
    : '';

  const list = !state.tournaments.length
    ? '<div class="card empty"><h3>No tournaments yet</h3>'
      + '<p class="muted">Create one below, or load a backup file from a previous event.</p></div>'
    : '<div class="grid two">' + state.tournaments.map((t) => {
      const cut = t.cut || {};
      return '<div class="card">'
        + `<h2>${esc(t.name)}</h2>`
        + `<p class="small muted">${esc(t.mode === 'online' ? 'Online' : 'In person')} &middot; `
        + `${esc(t.players)} players &middot; ${esc(t.rounds)} rounds &middot; ${esc(t.status)}`
        + (cut.applied ? ` &middot; cut to top ${esc(cut.size)}` : '') + '</p>'
        + `<p class="small muted">Last change ${esc(when(t.updatedAt))}</p>`
        + '<div class="btnrow">'
        + `<button class="primary" data-open="${esc(t.id)}">Open</button>`
        + `<button class="danger" data-del="${esc(t.id)}">Delete</button>`
        + '</div></div>';
    }).join('') + '</div>';

  host.innerHTML = warn + list + `
  <div class="card">
    <h2>Load a backup</h2>
    <p class="small muted">Open a <span class="mono">tournament.json</span> restore point from a
      backup folder. This is how you move an event to another laptop, or recover one.</p>
    <div class="btnrow">
      <input type="file" id="restoreFile" accept=".json,application/json" style="max-width:22em">
    </div>
  </div>`;

  $$('[data-open]', host).forEach((b) =>
    b.addEventListener('click', () => openTournament(b.dataset.open)));
  $$('[data-del]', host).forEach((b) =>
    b.addEventListener('click', () => confirmThen(
      {
        text: 'Delete this tournament from this browser? Any backup files already written are kept.',
        confirm: 'Delete',
        danger: true,
      },
      async () => {
        await persistence.deleteTournament(b.dataset.del);
        if (state.store.doc && state.store.doc.id === b.dataset.del) state.store.doc = null;
        await loadTournaments();
        render();
        toast('Tournament deleted from this browser.');
      })));

  $('#restoreFile').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    await guard(async () => {
      const doc = readRestorePoint(await file.text());
      doc.id = doc.id || `t${Date.now()}`;
      const conflict = restoreConflict(await persistence.loadTournament(doc.id), doc);
      if (conflict && !(await ask({
        text: conflict.message, confirm: 'Replace it', danger: conflict.newer,
      }))) {
        e.target.value = '';
        toast('Nothing was loaded. The copy in this browser is unchanged.');
        return;
      }
      state.store.load(doc);
      await persistence.saveTournament(doc);
      await loadTournaments();
      toast(`Loaded "${doc.name}".`);
      setView('round');
    });
  });
}

/* --------------------------------------------------------------- setup */

function renderSetup() {
  const t = state.store.doc;
  if (!t) return;
  // Showing a ruleset the organiser has filled in but not yet saved, if any.
  const r = state.pendingRules || t.rules;
  const c = t.config;
  const uma = (r.uma || ['15', '5', '-5', '-15']).map(Number);
  const cut = c.cut || {};
  const sel = (a, b) => (a === b ? ' selected' : '');

  const model = r.scoringModel || 'riichi';
  const tablePoints = (r.placementPoints || ['4', '2', '1', '0']).map(Number);
  const presetOptions = Object.entries(PRESETS)
    .filter(([id]) => id !== 'custom')
    .map(([id, p]) => `<option value="${esc(id)}">${esc(p.label)}</option>`)
    .join('');

  $('#setupBody').innerHTML = `
  <div class="card startfrom">
    <h2>Start from a published ruleset</h2>
    <p class="small muted">This fills in everything below. Nothing is saved until you
      press <b>Save settings</b>, so you can look before you commit — and change any
      number afterwards.</p>
    <div class="btnrow">
      <label class="field" style="flex:1;min-width:240px"><span>Ruleset</span>
        <select id="sPreset">
          <option value="">Choose a ruleset…</option>
          ${presetOptions}
        </select></label>
      <button class="ghost" id="applyPreset">Fill in these settings</button>
    </div>
    <p class="small muted" id="presetNote"></p>
  </div>

  <div class="card">
    <h2>The event</h2>
    <div class="grid two">
      <label class="field"><span>Name</span>
        <input type="text" id="sName" value="${esc(t.name)}"></label>
      <label class="field"><span>Venue or platform</span>
        <input type="text" id="sVenue" value="${esc(c.venue || '')}"
          placeholder="${t.mode === 'online' ? 'Mahjong Soul' : 'Community hall'}"></label>
      <label class="field"><span>Played</span>
        <select id="sMode">
          <option value="in_person"${sel(t.mode, 'in_person')}>In person</option>
          <option value="online"${sel(t.mode, 'online')}>Online</option>
        </select></label>
      <label class="field"><span>Ruleset label <span class="hint">(shown on printouts)</span></span>
        <input type="text" id="sRuleset"
          value="${esc(state.pendingLabel || c.rulesetLabel || '')}"></label>
      <label class="field"><span>Hanchan before the cut</span>
        <input type="number" id="sRounds" min="1" max="40" value="${num(c.plannedRounds) || 6}"></label>
      <label class="field"><span>Minutes per hanchan <span class="hint">(ARA suggests 90)</span></span>
        <input type="number" id="sMinutes" min="0" max="300" value="${num(c.hanchanMinutes) || 90}"></label>
    </div>
  </div>

  <div class="card">
    <h2>Scoring</h2>
    <p class="small muted">${model === 'table_points'
    ? 'Hanchan score = the table points for your rank. The raw points decide the '
      + 'rank and then carry on only as the tiebreak.'
    : 'Hanchan score = (final points &minus; return) &divide; 1,000 + uma.'}</p>
    <div class="grid three">
      <label class="field"><span>How a result is scored
        <button type="button" class="qmark" data-help="scoring-model"
          aria-label="What is this?">?</button></span>
        <select id="sModel">
          <option value="riichi"${sel(model, 'riichi')}>Points and uma (riichi)</option>
          <option value="table_points"${sel(model, 'table_points')}>Table points by rank (MCR)</option>
        </select></label>
      <label class="field"><span>Players per table</span>
        <input type="number" id="sPpt" value="${num(r.playersPerTable) || 4}" readonly disabled
          title="Three-player rules are not implemented, so this is fixed.">
        <span class="hint">Fixed: three-player rules are not implemented.</span></label>
      <label class="field"><span>Starting points <button type="button" class="qmark" data-help="table-total" aria-label="What is this?">?</button></span>
        <input type="number" id="sStart" step="${model === 'table_points' ? 1 : 1000}"
          value="${num(r.startingPoints)}"></label>
      <label class="field"><span>Return / goal <span class="hint">(above start = oka)</span> <button type="button" class="qmark" data-help="goal-points" aria-label="What is this?">?</button></span>
        <input type="number" id="sGoal" step="${model === 'table_points' ? 1 : 1000}"
          value="${num(r.goalPoints)}"></label>
      ${model === 'table_points' ? `
      <label class="field"><span>Table points 1st
        <button type="button" class="qmark" data-help="table-points"
          aria-label="What is this?">?</button></span>
        <input type="number" id="sTp0" value="${tablePoints[0]}"></label>
      <label class="field"><span>Table points 2nd</span>
        <input type="number" id="sTp1" value="${tablePoints[1]}"></label>
      <label class="field"><span>Table points 3rd</span>
        <input type="number" id="sTp2" value="${tablePoints[2]}"></label>
      <label class="field"><span>Table points 4th</span>
        <input type="number" id="sTp3" value="${tablePoints[3]}"></label>` : `
      <label class="field"><span>Uma 1st
        <button type="button" class="qmark" data-help="uma" aria-label="What is this?">?</button></span>
        <input type="number" id="sUma0" value="${uma[0]}"></label>
      <label class="field"><span>Uma 2nd</span><input type="number" id="sUma1" value="${uma[1]}"></label>
      <label class="field"><span>Uma 3rd</span><input type="number" id="sUma2" value="${uma[2]}"></label>
      <label class="field"><span>Uma 4th</span><input type="number" id="sUma3" value="${uma[3]}"></label>`}
      <label class="field"><span>Ties at a table</span>
        <select id="sTie">
          <option value="split"${sel(r.tieMode, 'split')}>Split the uma (WRC)</option>
          <option value="seat_order"${sel(r.tieMode, 'seat_order')}>Break by seat wind (E&gt;S&gt;W&gt;N)</option>
        </select></label>
      <label class="field"><span>Chombo penalty (P)</span>
        <input type="number" id="sChombo" value="${num(r.chomboPenalty) || 30}"></label>
    </div>
    <details class="adv">
      <summary>More scoring options</summary>
      <div class="grid three" style="margin-top:10px">
        <label class="field"><span>Chombo is</span>
          <select id="sChomboMode">
            <option value="tournament_penalty"${sel(r.chomboMode, 'tournament_penalty')}>Taken off the tournament score (WRC)</option>
            <option value="table_payment"${sel(r.chomboMode, 'table_payment')}>Settled at the table</option>
          </select></label>
        <label class="field"><span>Decimals kept</span>
          <input type="number" id="sPrecision" min="0" max="4" value="${num(r.scorePrecision)}"></label>
        <label class="field"><span>Rounding</span>
          <select id="sRounding">
            <option value="truncate"${sel(r.scoreRounding, 'truncate')}>Cut off (WRC)</option>
            <option value="half_up"${sel(r.scoreRounding, 'half_up')}>Round half up</option>
          </select></label>
        <label class="field"><span>Players sitting out score</span>
          <select id="sByeMode">
            <option value="fixed"${sel(r.byeMode, 'fixed')}>A fixed amount</option>
            <option value="average"${sel(r.byeMode, 'average')}>Their own average so far</option>
          </select></label>
        <label class="field"><span>Fixed sit-out score (P)</span>
          <input type="number" id="sByeScore" step="0.1" value="${num(r.byeScore)}"></label>
        <label class="field"><span>Points divided by
          <button type="button" class="qmark" data-help="point-divisor"
            aria-label="What is this?">?</button></span>
          <input type="number" id="sDivisor" min="1" value="${num(r.pointDivisor) || 1000}"></label>
        <label class="field"><span>Scores move in steps of</span>
          <input type="number" id="sStep" min="1" value="${num(r.scoreStep) || 100}"></label>
      </div>
      <p class="small muted"><button type="button" class="qmark" data-help="tiebreaks" aria-label="What is this?">?</button> Tiebreakers run in WRC order: score, most firsts, fewest lasts,
        best single hanchan, then a manual tiebreak you set on the roster after a coin toss.</p>
    </details>
  </div>

  <div class="card">
    <h2>Cut to the finals</h2>
    <div class="grid three">
      <label class="field"><span>Cut to top</span>
        <input type="number" id="sCutSize" min="0" max="128" value="${num(cut.size)}"></label>
      <label class="field"><span>Final hanchan</span>
        <input type="number" id="sCutRounds" min="0" max="20" value="${num(cut.rounds)}"></label>
      <label class="field"><span>Points going in <button type="button" class="qmark" data-help="carry" aria-label="What is this?">?</button></span>
        <select id="sCutCarry">
          <option value="reset"${sel(cut.carry, 'reset')}>Reset to zero (ARA)</option>
          <option value="full"${sel(cut.carry, 'full')}>Carry the full score</option>
          <option value="half"${sel(cut.carry, 'half')}>Carry half</option>
        </select></label>
      <label class="field"><span>Seeding at the finals</span>
        <select id="sCutSeed">
          <option value="snake"${sel(cut.seeding, 'snake')}>Spread seeds across tables</option>
          <option value="rank_order"${sel(cut.seeding, 'rank_order')}>Top table gets ranks 1-4</option>
        </select></label>
    </div>
  </div>

  <div class="card">
    <h2>Seating</h2>
    <p class="small muted">The draw avoids repeat opponents, spreads seat winds, moves players
      between tables and keeps clubs apart.</p>
    <div class="grid three">
      <label class="field"><span>Avoid repeat opponents</span>
        <input type="number" id="sWRepeat" step="5" value="${num((c.seating.weights || {}).repeat)}"></label>
      <label class="field"><span>Balance seat winds</span>
        <input type="number" id="sWWind" value="${num((c.seating.weights || {}).wind)}"></label>
      <label class="field"><span>Move between tables</span>
        <input type="number" id="sWTable" value="${num((c.seating.weights || {}).table)}"></label>
      <label class="field"><span>Keep clubs apart</span>
        <input type="number" id="sWClub" step="5" value="${num((c.seating.weights || {}).club)}"></label>
      <label class="field"><span>Search effort <span class="hint">(seconds)</span></span>
        <input type="number" id="sBudget" step="0.5" min="0.2" max="30" value="${num(c.seating.timeBudget) || 3}"></label>
    </div>
  </div>

  <div class="btnrow">
    <button class="primary big" id="saveSetup">Save settings</button>
    <span class="small muted">Changing scoring re-reckons every round already entered.</span>
  </div>`;

  $('#saveSetup').addEventListener('click', saveSetup);

  // Switching the scoring model swaps uma for table points, so redraw the
  // form. Anything already typed is kept by reading it back first.
  $('#sModel').addEventListener('change', () => {
    state.pendingRules = { ...readSetupRules(), scoringModel: $('#sModel').value };
    renderSetup();
  });

  // "Start from a published ruleset" fills the form in, without saving.
  const apply = $('#applyPreset');
  const choose = $('#sPreset');
  const describe = () => {
    const preset = PRESETS[choose.value];
    $('#presetNote').textContent = preset
      ? `${preset.label} — ${preset.source}`
      : '';
  };
  choose.addEventListener('change', describe);
  apply.addEventListener('click', () => {
    const preset = PRESETS[choose.value];
    if (!preset) { toast('Choose a ruleset first.', 'warn'); return; }
    // Start from the engine's own defaults for that ruleset, so a field the
    // preset does not mention goes back to its default rather than keeping a
    // value from whatever was selected before.
    state.pendingRules = new ScoreRules(preset.rules).toJSON();
    state.pendingLabel = preset.label;
    renderSetup();
    toast(`Filled in ${preset.label}. Review it, then press Save settings.`, 'ok', 6000);
  });
}

/** The rules as the form currently reads, for redrawing without losing edits. */
function readSetupRules() {
  const ppt = num($('#sPpt').value) || 4;
  const out = {
    scoringModel: $('#sModel').value,
    playersPerTable: ppt,
    startingPoints: num($('#sStart').value),
    goalPoints: num($('#sGoal').value),
    pointDivisor: num($('#sDivisor').value) || 1000,
    scoreStep: num($('#sStep').value) || 1,
    tieMode: $('#sTie').value,
    chomboPenalty: $('#sChombo').value,
    chomboMode: $('#sChomboMode').value,
    scorePrecision: num($('#sPrecision').value),
    scoreRounding: $('#sRounding').value,
    byeMode: $('#sByeMode').value,
    byeScore: $('#sByeScore').value,
  };
  if ($('#sTp0')) {
    out.placementPoints = [$('#sTp0').value, $('#sTp1').value,
      $('#sTp2').value, $('#sTp3').value].slice(0, ppt);
  }
  if ($('#sUma0')) {
    out.uma = [$('#sUma0').value, $('#sUma1').value,
      $('#sUma2').value, $('#sUma3').value].slice(0, ppt);
  }
  return out;
}

function saveSetup() {
  const ppt = num($('#sPpt').value);
  const model = $('#sModel') ? $('#sModel').value : 'riichi';

  // Only one of these two is on the form at a time, so read whichever is
  // there and leave the other as it stands. store.update merges, so the
  // absent one is kept rather than wiped.
  const bonus = {};
  if (model === 'table_points') {
    bonus.placementPoints = [$('#sTp0').value, $('#sTp1').value,
      $('#sTp2').value, $('#sTp3').value].slice(0, ppt);
  } else {
    bonus.uma = [$('#sUma0').value, $('#sUma1').value,
      $('#sUma2').value, $('#sUma3').value].slice(0, ppt);
  }

  const payload = {
    name: $('#sName').value,
    mode: $('#sMode').value,
    rules: {
      scoringModel: model,
      playersPerTable: ppt,
      startingPoints: num($('#sStart').value),
      goalPoints: num($('#sGoal').value),
      pointDivisor: num($('#sDivisor').value) || 1000,
      scoreStep: num($('#sStep').value) || 1,
      ...bonus,
      tieMode: $('#sTie').value,
      chomboPenalty: $('#sChombo').value,
      chomboMode: $('#sChomboMode').value,
      scorePrecision: num($('#sPrecision').value),
      scoreRounding: $('#sRounding').value,
      byeMode: $('#sByeMode').value,
      byeScore: $('#sByeScore').value,
    },
    config: {
      venue: $('#sVenue').value,
      rulesetLabel: $('#sRuleset').value,
      plannedRounds: num($('#sRounds').value),
      hanchanMinutes: num($('#sMinutes').value),
      cut: {
        size: num($('#sCutSize').value),
        rounds: num($('#sCutRounds').value),
        carry: $('#sCutCarry').value,
        seeding: $('#sCutSeed').value,
      },
      seating: {
        weights: {
          repeat: num($('#sWRepeat').value),
          wind: num($('#sWWind').value),
          table: num($('#sWTable').value),
          club: num($('#sWClub').value),
        },
        timeBudget: num($('#sBudget').value),
      },
    },
  };
  guard(() => {
    state.store.update(payload);
    state.pendingRules = null;
    state.pendingLabel = '';
    loadTournaments().then(render);
    toast('Settings saved.');
  });
}

/* ------------------------------------------------------------- players */

function renderPlayers() {
  const t = state.store.doc;
  if (!t) return;
  const players = state.store.listPlayers();
  $('#playerLede').innerHTML = fieldSummary(state.store.fieldPlan());
  const playing = players.filter((p) => p.status === 'active').length;
  const here = players.filter((p) => p.status === 'active' && p.checkedIn).length;
  const absent = playing - here;

  const sel = (a, b) => (a === b ? ' selected' : '');
  const rows = players.map((p) => `
    <tr data-pid="${p.id}" data-name="${esc(p.name.toLowerCase())}"
      class="${here && p.status === 'active' && !p.checkedIn ? 'absent' : ''}">
      <td><input type="checkbox" data-here="${p.id}"${p.checkedIn ? ' checked' : ''}
        aria-label="${esc(p.name)} is here"></td>
      <td><input type="text" value="${esc(p.name)}" data-f="name" style="min-width:9em"></td>
      <td><input type="text" value="${esc(p.club)}" data-f="club" style="min-width:7em"></td>
      <td><input type="text" value="${esc(p.contact)}" data-f="contact" style="min-width:8em"></td>
      <td><select data-f="role">
        <option value="player"${sel(p.role, 'player')}>Ranked</option>
        <option value="sit_in"${sel(p.role, 'sit_in')}>Sit-in</option>
      </select></td>
      <td><select data-f="status">
        <option value="active"${sel(p.status, 'active')}>Playing</option>
        <option value="withdrawn"${sel(p.status, 'withdrawn')}>Withdrawn</option>
        <option value="disqualified"${sel(p.status, 'disqualified')}>Disqualified</option>
      </select></td>
      <td><input type="number" step="0.001" value="${esc(p.manualTiebreak)}"
        data-f="manualTiebreak" style="width:5.5em"></td>
      <td class="nowrap">
        <button class="ghost" data-save="${p.id}">Save</button>
        <button class="ghost danger" data-rm="${p.id}">&times;</button>
      </td>
    </tr>`).join('');

  $('#playersBody').innerHTML = `
  <div class="card">
    <h2>Add players <button type="button" class="qmark" data-help="bulk-players" aria-label="What is this?">?</button></h2>
    <p class="small muted">Paste one player per line. Add a club after a comma or tab:
      <span class="mono">Player 01, Club A</span>. A header row from a spreadsheet works too.</p>
    <textarea id="bulkText" placeholder="Player 01, Club A&#10;Player 02, Club B&#10;Player 03"></textarea>
    ${isTestEvent() ? `
    <div class="btnrow testtools" style="margin-top:10px">
      <span class="small muted">Test data:</span>
      <label class="inline">players
        <input type="number" id="tdCount" min="4" max="200" value="16" style="width:5em"></label>
      <label class="inline">clubs
        <input type="number" id="tdClubs" min="1" max="12" value="4" style="width:4em"></label>
      <label class="inline">sit-ins
        <input type="number" id="tdSubs" min="0" max="20" value="0" style="width:4em"></label>
      <button class="ghost" id="tdFill">Generate</button>
    </div>` : ''}
    <div class="btnrow" style="margin-top:10px">
      <button class="primary" id="bulkBtn">Add these players</button>
      <span class="small muted">Names already on the roster are skipped.</span>
    </div>
  </div>

  <div class="card">
    <h2>Roster <span class="muted small">(${players.length})</span></h2>
    ${players.length ? `<div class="row signin" style="margin-bottom:10px;gap:10px;flex-wrap:wrap">
      <label class="field" style="flex:1 1 280px;margin:0"><span>Find or sign in
        <button type="button" class="qmark" data-help="sign-in" aria-label="What is this?">?</button></span>
        <input type="search" id="rosterFind" placeholder="Type a name, Enter to sign them in"
          autocomplete="off"></label>
      <span class="small"><strong>${here} of ${playing}</strong> playing are signed in</span>
      ${here && absent ? `<button class="ghost" id="withdrawAbsent">Withdraw the ${absent} not signed in</button>` : ''}
      ${here ? '<button class="ghost" id="clearSignIn">Clear sign-in</button>' : ''}
    </div>
    <div class="scroll"><table class="data roster">
      <thead><tr><th title="Signed in">Here</th><th>Name</th><th>Club</th><th>Contact</th><th>Role <button type="button" class="qmark" data-help="player-role" aria-label="What is this?">?</button></th><th>Status <button type="button" class="qmark" data-help="player-status" aria-label="What is this?">?</button></th>
      <th class="num" title="Used only to settle a tie a coin toss decided">Tiebreak</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table></div>
      <p class="small muted" style="margin-top:10px">A <strong>sit-in</strong> fills a table but is
      not ranked, and is only seated when they complete a table that would otherwise be
      short &mdash; the ARA guide suggests keeping three on hand for uneven fields.
      Withdrawing keeps a player's results; deleting is only possible before they have played.</p>`
    : '<p class="muted">Nobody on the roster yet.</p>'}
  </div>`;

  const tdFill = $('#tdFill');
  if (tdFill) {
    tdFill.addEventListener('click', () => guard(() => {
      const lines = testRoster(num($('#tdCount').value) || 16, {
        clubs: num($('#tdClubs').value) || 4,
        subs: num($('#tdSubs').value) || 0,
      });
      // Into the paste box rather than straight into the roster, so it is
      // obvious what is about to be added and it can be edited first.
      $('#bulkText').value = lines.join('\n');
      toast(`${lines.length} test players ready. Press "Add these players".`);
    }));
  }

  $('#bulkBtn').addEventListener('click', () => guard(() => {
    const text = $('#bulkText').value;
    if (!text.trim()) return toast('Paste some names first.', 'warn');
    const parsed = parsePlayerCsv(text);
    const existing = new Set(state.store.listPlayers().map((p) => p.name.toLowerCase()));
    let added = 0;
    let skipped = 0;
    for (const record of parsed) {
      if (existing.has(record.name.toLowerCase())) { skipped++; continue; }
      state.store.addPlayer(record.name, {
        club: record.club || '', contact: record.contact || '',
        externalId: record.externalId || '',
        // In a test event, a generated "Sub1" is meant to be a sit-in: it
        // fills a seat without being ranked. parsePlayerCsv always returns a
        // role, defaulting to "player", so this checks for that default
        // rather than for a missing value. A role stated in the pasted text
        // still wins, and naming someone Sub1 in a real event changes nothing.
        role: (isTestEvent() && isSubName(record.name) && record.role === 'player')
          ? 'sit_in'
          : (record.role || 'player'),
        notes: record.notes || '',
      });
      existing.add(record.name.toLowerCase());
      added++;
    }
    $('#bulkText').value = '';
    render();
    toast(`Added ${added} player${added === 1 ? '' : 's'}`
      + (skipped ? `; skipped ${skipped} already on the roster.` : '.'));
    return null;
  }));

  // Sign-in: tick a box, or type a name and press Enter.
  $$('[data-here]', $('#playersBody')).forEach((box) => box.addEventListener('change', () =>
    guard(() => {
      state.store.setCheckedIn(num(box.dataset.here), box.checked);
      render();
    })));

  const find = $('#rosterFind');
  if (find) {
    const visible = () => $$('#playersBody tbody tr').filter((tr) => tr.style.display !== 'none');
    find.addEventListener('input', () => {
      const q = find.value.trim().toLowerCase();
      $$('#playersBody tbody tr').forEach((tr) => {
        tr.style.display = !q || tr.dataset.name.includes(q) ? '' : 'none';
      });
    });
    find.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const rows = visible();
      if (rows.length !== 1) {
        toast(rows.length ? `${rows.length} names match. Type a little more.`
          : 'Nobody on the roster matches that.', 'warn');
        return;
      }
      guard(() => {
        const player = state.store.setCheckedIn(num(rows[0].dataset.pid), true);
        render();
        toast(`${player.name} signed in.`);
        // Ready for the next person at the door.
        if ($('#rosterFind')) $('#rosterFind').focus();
      });
    });
  }

  const withdrawAbsent = $('#withdrawAbsent');
  if (withdrawAbsent) {
    withdrawAbsent.addEventListener('click', () => {
      const names = state.store.absentPlayers().map((p) => p.name);
      confirmThen({
        text: `Withdraw ${names.length} not signed in: ${names.join(', ')}?`
          + ' They can be set back to playing on this tab.',
        confirm: `Withdraw ${names.length}`,
      }, () => guard(() => {
        const gone = state.store.withdrawAbsent();
        render();
        toast(`${gone.length} withdrawn.`);
      }));
    });
  }

  const clearSignIn = $('#clearSignIn');
  if (clearSignIn) {
    clearSignIn.addEventListener('click', () => confirmThen(
      {
        text: 'Clear everyone\'s sign-in, to start again for another day?',
        confirm: 'Clear sign-in',
      }, () => guard(() => {
        state.store.clearCheckIn();
        render();
        toast('Sign-in cleared.');
      })));
  }

  // Role and status take effect as soon as they change. They used to wait for
  // the row's Save button, and a change left unsaved simply did nothing.
  $$('select[data-f]', $('#playersBody')).forEach((select) => select.addEventListener('change', () =>
    guard(() => {
      const pid = num(select.closest('tr').dataset.pid);
      const player = state.store.updatePlayer(pid, { [select.dataset.f]: select.value });
      render();
      toast(`${player.name}: ${select.options[select.selectedIndex].text.toLowerCase()}.`);
    })));

  $$('[data-save]', $('#playersBody')).forEach((b) => b.addEventListener('click', () => {
    const tr = b.closest('tr');
    const payload = {};
    $$('[data-f]', tr).forEach((i) => { payload[i.dataset.f] = i.value; });
    guard(() => {
      state.store.updatePlayer(num(b.dataset.save), payload);
      render();
      toast('Player updated.');
    });
  }));

  $$('[data-rm]', $('#playersBody')).forEach((b) => b.addEventListener('click', () =>
    confirmThen({
      text: 'Remove this player from the roster?', confirm: 'Remove', danger: true,
    }, () => guard(() => {
      state.store.deletePlayer(num(b.dataset.rm));
      render();
      toast('Player removed.');
    }))));
}

/** One line on how the field divides, and what would fill the last table. */
function fieldSummary(plan) {
  const s = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  let line = `${plan.ranked} ranked`
    + (plan.sitInsOnHand ? ` &middot; ${s(plan.sitInsOnHand, 'sit-in')} on hand` : '')
    + ` &middot; <strong>${s(plan.tables, 'table')}</strong>`;
  if (plan.sittingOut) {
    const more = plan.short - plan.sitInsOnHand;
    line += ` &middot; <strong>${plan.sittingOut} sitting out each round</strong>`
      + ` (add ${s(plan.short, 'more player')}, or ${s(more, 'more sit-in')},`
      + ' to fill the last table)';
  } else if (plan.sitInsUsed) {
    const spare = plan.sitInsOnHand - plan.sitInsUsed;
    line += ` &middot; ${s(plan.sitInsUsed, 'sit-in')} make${plan.sitInsUsed === 1 ? 's' : ''}`
      + ' up the last table'
      + (spare ? `; ${spare} not needed` : '');
  } else {
    line += ' &middot; tables fill exactly'
      + (plan.sitInsOnHand ? ', so the sit-ins are not needed' : '');
  }
  return line;
}

/* --------------------------------------------------------------- round */

/**
 * The tables of a closed round, for correcting one. Shown in place of the
 * round page until Back is pressed; returns false if there is nothing to show.
 */
function renderAmend() {
  // Round ids repeat between events, so the correction remembers its event.
  const target = state.amendRound;
  if (!target || target.event !== state.store.doc.id) {
    state.amendRound = null;
    return false;
  }
  let rnd;
  try {
    rnd = state.store.getRound(target.roundId);
  } catch {
    state.amendRound = null;
    return false;
  }
  if (rnd.status !== 'complete') {
    state.amendRound = null;
    return false;
  }
  $('#roundTitle').textContent = `Correcting ${rnd.label}`;
  $('#roundLede').innerHTML = 'This round is closed. Tap a table to correct it: the round '
    + 'stays closed, and nothing about later rounds changes.';
  $('#roundBody').innerHTML = `<div class="card">
    <div class="row" style="margin-bottom:12px">
      <h2 style="margin:0">Tables</h2><span class="spacer"></span>
      <button class="ghost" id="amendDone">Back to the round</button>
    </div>
    <div class="tables" id="amendGrid">${rnd.tables.map(tableCard).join('')}</div>
  </div>`;
  $('#amendDone').addEventListener('click', () => {
    state.amendRound = null;
    render();
  });
  $$('#amendGrid button.tcard').forEach((card) => card.addEventListener('click', () =>
    openEntry(num(card.dataset.table), { round: rnd, amend: true })));
  return true;
}

function renderRound() {
  const t = state.store.doc;
  if (!t) return;
  if (state.amendRound !== null && renderAmend()) return;
  const rounds = state.store.listRounds();
  const open = rounds.find((r) => r.status !== 'complete');
  const planned = num(t.config.plannedRounds) || 0;
  const done = rounds.filter((r) => r.status === 'complete').length;

  if (!open) {
    const cut = t.config.cut || {};
    const finalsDone = rounds.filter((r) => r.phase === 'final' && r.status === 'complete').length;
    const nextIsFinal = cut.applied && finalsDone < num(cut.rounds);
    $('#roundTitle').textContent = 'Run the round';
    $('#roundLede').innerHTML =
      `${done} hanchan complete` + (planned ? ` of ${planned} planned` : '') + '.';
    $('#roundBody').innerHTML = `
    <div class="card">
      <h2>${nextIsFinal ? 'Seat the next final hanchan' : 'Seat the next hanchan'}</h2>
      <p class="small muted">${nextIsFinal
        ? 'Only the players who made the cut are seated.'
        : 'Everyone playing is seated. The draw avoids repeat opponents and evens out seat winds.'}</p>
      <div class="grid three">
        <label class="field"><span>Phase</span>
          <select id="rPhase">
            <option value="qualifying"${!nextIsFinal ? ' selected' : ''}>Qualifying</option>
            <option value="final"${nextIsFinal ? ' selected' : ''}${!cut.applied ? ' disabled' : ''}>Final</option>
            <option value="free_play">Free play (not scored)</option>
          </select></label>
        <label class="field"><span>Draw</span>
          <select id="rMethod">
            <option value="optimise">Optimised (recommended)</option>
            <option value="wheel">ARA wheel (instant, large fields)</option>
          </select></label>
        <label class="field"><span>Seed <span class="hint">(blank = automatic)</span> <button type="button" class="qmark" data-help="seed" aria-label="What is this?">?</button></span>
          <input type="number" id="rSeed" placeholder="auto"></label>
      </div>
      <div class="btnrow"><button class="primary big" id="genBtn">Draw the seating</button></div>
    </div>
    ${displayCard()}
    ${renderRoundHistory(rounds)}`;

    $('#genBtn').addEventListener('click', () => {
      const btn = $('#genBtn');
      btn.disabled = true;
      btn.textContent = 'Drawing…';
      // Let the button repaint before the search blocks the thread.
      setTimeout(() => {
        guard(() => {
          const seed = $('#rSeed').value;
          const rnd = state.store.generateRound({
            phase: $('#rPhase').value,
            method: $('#rMethod').value,
            seed: seed === '' ? null : num(seed),
          });
          state.round = rnd;
          render();
          const m = (rnd.seating || {}).metrics || {};
          toast(`${rnd.label} seated: ${rnd.tablesTotal} tables`
            + (m.repeatPairs ? `, ${m.repeatPairs} repeat pairing(s)` : ', no repeat pairings')
            + (rnd.byes.length ? `, ${rnd.byes.length} sitting out` : '') + '.'
            + (rnd.substitutes && rnd.substitutes.length
              ? ` ${rnd.substitutes.map((p) => p.name).join(', ')} stand${rnd.substitutes.length === 1 ? 's' : ''}`
                + ' in for a withdrawn finalist.'
              : ''), 'ok', rnd.substitutes && rnd.substitutes.length ? 9000 : 4200);
        });
        btn.disabled = false;
        btn.textContent = 'Draw the seating';
      }, 20);
    });
    attachRoundHistory();
    attachDisplayControls();
    return;
  }

  const rnd = state.store.getRound(open.id);
  state.round = rnd;
  const reported = rnd.tablesReported;
  const total = rnd.tablesTotal;
  const metrics = (rnd.seating || {}).metrics || {};

  $('#roundTitle').textContent = rnd.label;
  $('#roundLede').innerHTML = `${reported} of ${total} tables reported`
    + (rnd.phase === 'final' ? ' &middot; finals' : '')
    + (rnd.freePlayTables
      ? ` &middot; ${rnd.freePlayTables} free-play table${rnd.freePlayTables === 1 ? '' : 's'},`
        + ' not scored'
      : '')
    + (rnd.phase === 'free_play' ? ' &middot; not scored' : '');

  const byes = rnd.byes.length
    ? `<div class="card"><h3>Sitting out this hanchan</h3><p>${rnd.byes
      .map((b) => `${esc(b.name)} <span class="muted small">(${fmtScore(b.score)}P)</span>`)
      .join(', ')}</p></div>`
    : '';

  $('#roundBody').innerHTML = `
  <div class="grid four" style="margin-bottom:14px">
    <div class="stat"><div class="k">Reported</div><div class="v">${reported} / ${total}</div>
      <div class="n">${total - reported} table${total - reported === 1 ? '' : 's'} to go</div></div>
    <div class="stat"><div class="k">Repeat pairings</div><div class="v">${num(metrics.repeatPairs)}</div>
      <div class="n">players meeting again</div></div>
    <div class="stat"><div class="k">Seat wind spread</div><div class="v">${num(metrics.worstWindImbalance)}</div>
      <div class="n">worst gap for any player</div></div>
    ${clockStat(rnd)}
  </div>

  <div class="card">
    <div class="row" style="margin-bottom:12px">
      <h2 style="margin:0">Tables</h2>
      <span class="spacer"></span>
      <button class="ghost" data-print="seating">Print seating</button>
      <button class="ghost" data-print="scoresheets">Print report sheets</button>
      ${reported === 0 ? '<button class="ghost" id="reseatBtn">Redraw seating</button>' : ''}
    </div>
    <p class="small muted" style="margin-top:0">Tap a table to enter its scores.</p>
    <div class="tables" id="tableGrid">${rnd.tables.map(tableCard).join('')}</div>
  </div>

  ${byes}

  ${rnd.substitutes && rnd.substitutes.length ? `<div class="card"><h3>Standing in for a finalist</h3>
    <p>${rnd.substitutes.map((p) => `${esc(p.name)}${p.sitIn ? ' (sit-in)' : ''}`).join(', ')}
      ${rnd.substitutes.length === 1 ? 'takes the seat' : 'take the seats'} of a finalist who has
      withdrawn, and ${rnd.substitutes.length === 1 ? 'plays' : 'play'} unranked in the final.
      <span class="muted small">To put someone else there, use Change seats below.</span></p></div>` : ''}

  ${rnd.freePlayOut && rnd.freePlayOut.length ? `<div class="card"><h3>Not seated for free play</h3>
    <p>${rnd.freePlayOut.map((p) => esc(p.name)).join(', ')}
      <span class="muted small">&mdash; too few left over to make up another table.</span></p></div>` : ''}

  <div class="card">
    <div class="row">
      <button class="primary big" id="closeBtn">
        ${reported < total
          ? `Close round (${total - reported} table${total - reported === 1 ? '' : 's'} missing)`
          : 'Close this round'}</button>
      <span class="small muted">Closing locks the scores and lets you draw the next hanchan.</span>
    </div>
    ${isTestEvent() ? `
    <div class="btnrow testtools" style="margin-top:10px">
      <span class="small muted">Test data:</span>
      <button class="ghost" id="tdScores">Fill every table with scores</button>
    </div>` : ''}
  </div>

  ${moveCard(rnd)}

  ${displayCard()}

  ${renderRoundHistory(rounds)}`;

  $$('#tableGrid button.tcard').forEach((card) =>
    card.addEventListener('click', () => openEntry(num(card.dataset.table))));
  $$('[data-print]').forEach((b) => b.addEventListener('click', () =>
    guard(() => openPrintWindow(
      printPage(state.store, b.dataset.print, { roundId: rnd.id }), state.store.doc.name))));

  const tdScores = $('#tdScores');
  if (tdScores) {
    tdScores.addEventListener('click', () => guard(() => {
      const filled = fillOpenRound(state.store);
      state.round = state.store.getRound(rnd.id);
      render();
      toast(filled
        ? `Filled ${filled} table${filled === 1 ? '' : 's'} with test scores.`
        : 'Every table already has a score.', filled ? 'ok' : 'warn');
    }));
  }

  attachClockControls(rnd);
  attachDisplayControls();

  const mv = $('#mvBtn');
  if (mv) {
    // Start the two lists on different players.
    if ($('#mvB').options.length > 1) $('#mvB').selectedIndex = 1;
    mv.addEventListener('click', () => guard(() => {
      state.round = state.store.swapSeats(rnd.id, num($('#mvA').value), num($('#mvB').value));
      render();
      toast('Seats changed. Reprint the seating and report sheets if they are already out.');
    }));
  }

  const reseat = $('#reseatBtn');
  if (reseat) {
    reseat.addEventListener('click', () => confirmThen(
      { text: "Draw this round's seating again?", confirm: 'Redraw' }, () => guard(() => {
        state.round = state.store.reseatRound(rnd.id);
        render();
        toast('Seating redrawn.');
      })));
  }

  $('#closeBtn').addEventListener('click', () => {
    const missing = total - reported;
    confirmThen(
      missing
        ? {
          text: `${missing} table${missing === 1 ? ' has' : 's have'} no result. Close the round anyway?`,
          confirm: 'Close anyway',
          danger: true,
        }
        : { text: 'Close this round? Its scores are locked once it closes.', confirm: 'Close round' },
      () => guard(() => {
        state.store.closeRound(rnd.id, { force: missing > 0 });
        state.round = null;
        loadStandings();
        render();
        toast('Round closed.');
      }));
  });

  attachRoundHistory();
}

/* ------------------------------------------------- the clock and display
 *
 * "Minutes per hanchan" was stored and read by nothing. The round page now
 * runs a clock from it, and a second window shows that clock and the seating
 * or standings to the room, for a projector. display.js does the arithmetic
 * and the markup; this is the wiring. */

const clockMinutes = () => num(state.store.doc.config.hanchanMinutes) || 90;
const readClock = (clock) =>
  clockReading(clock, Date.now(), { defaultMinutes: clockMinutes() });

/* The line under the clock: what is happening, or how long a hanchan is. */
const clockLine = (reading) => clockNote(reading)
  || `${Math.round(reading.durationMs / 60000)}-minute hanchan`;

/* The clock as the fourth tile of the round's stat row, beside what it times. */
function clockStat(rnd) {
  const reading = readClock(rnd.clock);
  const label = reading.running ? 'Pause' : (reading.started ? 'Resume' : 'Start');
  const tone = reading.over ? 'over' : (reading.warn ? 'warn' : '');
  return `<div class="stat clockstat">
    <div class="k">Clock <button type="button" class="qmark" data-help="round-clock"
      aria-label="What is this?">?</button></div>
    <div class="clockrow">
      <span class="roundclock ${tone}" id="rcClock">${formatClock(reading.remainingMs)}</span>
      <button class="${reading.running ? 'ghost' : 'primary'}" id="rcToggle">${label}</button>
      ${reading.started ? '<button class="ghost" id="rcReset">Reset</button>' : ''}
    </div>
    <div class="n" id="rcNote">${esc(clockLine(reading))}</div>
  </div>`;
}

/* One row: what the room display shows, and the button to open it. */
function displayCard() {
  const isOpen = display.win && !display.win.closed;
  const modes = [['seating', 'Seating'], ['standings', 'Standings'], ['clock', 'Clock only']];
  return `<div class="card">
    <div class="row" style="gap:8px">
      <h2 style="margin:0 6px 0 0">Room display <button type="button" class="qmark"
        data-help="room-display" aria-label="What is this?">?</button></h2>
      ${modes.map(([m, text]) => `<button class="${display.mode === m ? 'primary' : 'ghost'}"
        data-dmode="${m}">${text}</button>`).join('')}
      <span class="spacer"></span>
      <button class="ghost" id="dispOpen">${isOpen ? 'Bring the display forward' : 'Open the room display'}</button>
    </div>
  </div>`;
}

function attachClockControls(rnd) {
  const toggle = $('#rcToggle');
  if (toggle) {
    toggle.addEventListener('click', () => guard(() => {
      const running = readClock(rnd.clock).running;
      state.round = running
        ? state.store.pauseClock(rnd.id)
        : state.store.startClock(rnd.id);
      render();
    }));
  }
  const reset = $('#rcReset');
  if (reset) {
    reset.addEventListener('click', () => confirmThen(
      { text: `Reset the clock to ${clockMinutes()} minutes?`, confirm: 'Reset' }, () => guard(() => {
        state.round = state.store.resetClock(rnd.id);
        render();
      })));
  }
}

function attachDisplayControls() {
  const open = $('#dispOpen');
  if (open) open.addEventListener('click', () => guard(() => { openDisplay(); render(); }));
  $$('[data-dmode]').forEach((b) => b.addEventListener('click', () => {
    display.mode = b.dataset.dmode;
    refreshDisplay();
    render();
  }));
}

/**
 * Open the room display in a new tab, or bring it forward if it is open.
 * A tab rather than a sized pop-up window: browsers let a page open one with
 * no fuss, and dragging a tab out onto the projector screen is something
 * everyone already knows how to do.
 */
function openDisplay() {
  if (display.win && !display.win.closed) {
    display.win.focus();
    return;
  }
  // Named, so a display left open from before a reload is reused, not doubled.
  const win = window.open('', 'rt-room-display');
  if (!win) {
    throw new Error('The browser blocked the room display from opening. Allow pop-ups for '
      + 'this page, then try again.');
  }
  win.document.open();
  win.document.write(displayShell(state.store.doc ? state.store.doc.name : 'Room display'));
  win.document.close();
  // The text is sized to the screen, so it is sized again when the screen changes:
  // dragged to the projector, made full screen.
  win.addEventListener('resize', () => fitToScreen(win));
  display.win = win;
  refreshDisplay();
}

/** Redraw the room display from the current state. Cheap enough for every change. */
function refreshDisplay() {
  if (!display.win) return;
  if (display.win.closed) {
    display.win = null;
    return;
  }
  const t = state.store.doc;
  const body = display.win.document.body;
  if (!t || !body) return;
  const open = state.store.openRound();
  const round = open ? state.store.getRound(open.id) : null;
  // Sit-ins with no seat this round, listed under the tables as free to sub.
  const present = new Set(round
    ? round.tables.flatMap((tb) => tb.seats.map((s) => s.playerId))
      .concat(round.byes.map((b) => b.playerId))
    : []);
  const sitInsOut = round
    ? state.store.playingPlayers().filter((p) => p.role === 'sit_in' && !present.has(p.id))
    : [];
  body.innerHTML = displayBody({
    tournament: t,
    round,
    standings: state.store.standings('overall'),
    reading: open ? readClock(open.clock) : null,
    mode: display.mode,
    precision: state.store.rules.scorePrecision,
    sitInsOut,
  });
  fitToScreen(display.win);
}

/** Once a second: move both clocks on, without redrawing anything else. */
function tickClocks() {
  if (!state.store.doc) return;
  const open = state.store.openRound();
  if (!open) return;
  const reading = readClock(open.clock);
  const el = $('#rcClock');
  if (el) {
    el.textContent = formatClock(reading.remainingMs);
    el.className = `roundclock ${reading.over ? 'over' : (reading.warn ? 'warn' : '')}`;
    const note = $('#rcNote');
    if (note) note.textContent = clockLine(reading);
  }
  if (display.win && !display.win.closed) {
    const clock = display.win.document.getElementById('clock');
    if (clock) clock.innerHTML = clockHtml(reading);
  }
}

/**
 * Changing seats after the draw: a swap, a seat for someone sitting out, or a
 * player from outside the round -- a late arrival, or a sit-in for a no-show.
 */
function moveCard(rnd) {
  const label = (t, s) => `Table ${t.tableNumber}${t.freePlay ? ' (free play)' : ''} `
    + `${WINDS[s.seatIndex] || '?'} · ${s.name}`;
  const inRound = [];
  const present = new Set();
  for (const t of rnd.tables) {
    for (const s of t.seats) {
      if (s.playerId === null || s.playerId === undefined) continue;
      present.add(s.playerId);
      // A player whose table has a score stays put.
      if (!t.seats.some((x) => x.rawScore !== null && x.rawScore !== undefined)) {
        inRound.push([s.playerId, label(t, s)]);
      }
    }
  }
  for (const b of rnd.byes) {
    present.add(b.playerId);
    inRound.push([b.playerId, `Sitting out · ${b.name}`]);
  }
  const outside = state.store.playingPlayers()
    .filter((p) => !present.has(p.id))
    .map((p) => [p.id, `${p.name}${p.role === 'sit_in' ? ' (sit-in)' : ''}`]);
  if (inRound.length < 2 && !outside.length) return '';
  const opts = (list) => list
    .map(([id, text]) => `<option value="${id}">${esc(text)}</option>`).join('');
  // Folded away: it is needed now and then, and it used to sit, full size, between
  // the tables and the button that closes the round.
  return `<details class="card fold">
    <summary>Change seats <span class="hint">a swap, a late arrival, a no-show</span></summary>
    <p class="small muted">Swap two players, give a seat to someone sitting out, or bring in
      someone who is not in this round &mdash; a late arrival, or a sit-in for a no-show.
      Nobody else at the table moves. <button type="button" class="qmark" data-help="change-seats"
      aria-label="What is this?">?</button></p>
    <div class="grid two">
      <label class="field"><span>Move</span><select id="mvA">${opts(inRound)}</select></label>
      <label class="field"><span>With</span><select id="mvB">
        <optgroup label="In this round">${opts(inRound)}</optgroup>
        ${outside.length ? `<optgroup label="Not in this round">${opts(outside)}</optgroup>` : ''}
      </select></label>
    </div>
    <div class="btnrow"><button id="mvBtn">Change seats</button></div>
  </details>`;
}

function tableCard(table) {
  if (table.freePlay) {
    // Seated and printed like any table, but there is nothing to enter.
    return `<div class="tcard free" data-table="${table.tableNumber}">
      <div class="thead"><span class="tnum">Table ${table.tableNumber}</span>
        <span class="chip">free play</span></div>
      <ul>${table.seats.map((s) => `<li><span class="w">${esc(WINDS[s.seatIndex] || '?')}</span>`
        + `<span class="nm">${esc(s.name || '')}</span></li>`).join('')}</ul>
    </div>`;
  }
  const chip = table.status === 'verified'
    ? '<span class="chip ok">verified</span>'
    : table.status === 'entered'
      ? '<span class="chip warn">entered</span>'
      : '<span class="chip">to play</span>';
  const byPlayer = new Map((table.outcome ? table.outcome.seats : []).map((s) => [s.playerId, s]));

  const seats = table.seats.map((s) => {
    const o = byPlayer.get(s.playerId);
    return '<li>'
      + `<span class="w">${esc(WINDS[s.seatIndex] || '?')}</span>`
      + `<span class="nm">${esc(s.name || '—')}</span>`
      + (s.rawScore !== null ? `<span class="sc">${fmtPoints(s.rawScore)}</span>` : '')
      + (o ? `<span class="hs">${fmtScore(o.hanchanScore)}</span>` : '')
      + '</li>';
  }).join('');

  const issues = table.outcome && table.outcome.issues.length
    ? `<p class="small" style="margin:6px 0 0;color:var(--${table.outcome.ok ? 'warn' : 'danger'})">`
      + `${table.overridden ? '<strong>Recorded as signed.</strong> ' : ''}`
      + `${esc(table.outcome.issues[0].message)}</p>`
    : '';
  const amended = table.amended
    ? '<p class="small muted" style="margin:6px 0 0">Corrected after the round closed.</p>'
    : '';

  return `<button class="tcard ${table.status}" data-table="${table.tableNumber}">
    <div class="thead"><span class="tnum">Table ${table.tableNumber}</span>${chip}</div>
    <ul>${seats}</ul>
    ${table.lobby ? `<p class="small muted" style="margin:6px 0 0">Lobby ${esc(table.lobby)}</p>` : ''}
    ${issues}
    ${amended}
  </button>`;
}

function renderRoundHistory(rounds) {
  if (!rounds.length) return '';
  const rows = [...rounds].reverse().map((r) => {
    const detail = state.store.getRound(r.id);
    return `<tr>
      <td class="num">${r.number}</td><td>${esc(r.label)}</td>
      <td>${esc(r.phase.replace('_', ' '))}</td>
      <td>${r.status === 'complete'
        ? '<span class="chip ok">complete</span>'
        : '<span class="chip warn">open</span>'}</td>
      <td class="num">${detail.tablesReported}/${detail.tablesTotal}</td>
      <td class="nowrap">
        ${r.status === 'complete' ? `<button class="ghost" data-amend="${r.id}">Correct</button>
          <button class="ghost" data-reopen="${r.id}">Reopen</button>` : ''}
        <button class="ghost danger" data-delround="${r.id}">&times;</button>
      </td></tr>`;
  }).join('');
  return `<div class="card"><h2>Rounds so far</h2>
    <div class="scroll"><table class="data"><thead><tr>
    <th class="num">#</th><th>Label</th><th>Phase</th><th>Status</th>
    <th class="num">Reported</th><th></th>
    </tr></thead><tbody>${rows}</tbody></table></div></div>`;
}

function attachRoundHistory() {
  $$('[data-amend]').forEach((b) => b.addEventListener('click', () => {
    state.amendRound = { event: state.store.doc.id, roundId: num(b.dataset.amend) };
    render();
    window.scrollTo({ top: 0 });
  }));
  $$('[data-reopen]').forEach((b) => b.addEventListener('click', () => guard(() => {
    state.store.reopenRound(num(b.dataset.reopen));
    state.round = null;
    render();
    toast('Round reopened.');
  })));
  $$('[data-delround]').forEach((b) => b.addEventListener('click', () =>
    confirmThen({
      text: 'Delete this round and its results?', confirm: 'Delete round', danger: true,
    }, () => guard(() => {
      state.store.deleteRound(num(b.dataset.delround));
      state.round = null;
      loadStandings();
      render();
      toast('Round deleted.');
    }))));
}

/* --------------------------------------------------- score entry sheet */

let entryTimer = null;

/* `amend`: correcting a table in a round that has closed. The same sheet,
 * with a reason to give, and no verify or clear -- the round stays closed. */
function openEntry(tableNumber, { round = state.round, amend = false } = {}) {
  const rnd = round;
  const table = rnd.tables.find((t) => t.tableNumber === tableNumber);
  if (!table) return;
  const rules = state.store.rules;
  const tableTotal = rules.tableTotal;
  const online = state.store.doc.mode === 'online';

  const seated = table.seats.filter((s) => s.playerId);
  const rows = seated.map((s) => `
    <div class="entry-row">
      <div class="wind" title="${esc(SEAT_WIND_NAMES[WINDS[s.seatIndex]] || '')}">${esc(WINDS[s.seatIndex])}</div>
      <div class="who">
        <div class="nm">${esc(s.name)}</div>
        <div class="meta">${esc(s.club || SEAT_WIND_NAMES[WINDS[s.seatIndex]] || '')}</div>
      </div>
      <input type="number" inputmode="numeric" step="${num(rules.scoreStep) || 100}"
             data-pid="${s.playerId}"
             value="${s.rawScore === null ? '' : s.rawScore}" placeholder="points">
    </div>`).join('');

  const penaltyRows = seated.map((s) => `<tr>
      <td>${esc(s.name)}</td>
      <td><input type="number" min="0" max="9" style="width:4em" data-cb="${s.playerId}" value="${num(s.chombo)}"></td>
      <td><input type="number" step="0.1" style="width:5.5em" data-pp="${s.playerId}" value="${esc(s.penaltyPoints)}"></td>
      <td><input type="text" data-pn="${s.playerId}" value="${esc(s.penaltyNote)}" placeholder="reason"></td>
    </tr>`).join('');

  $('#dialog').innerHTML = `
  <div class="sheet-backdrop" id="backdrop">
    <div class="sheet" role="dialog" aria-modal="true" aria-label="Enter scores for table ${tableNumber}">
      <header>
        <div>
          <h2>Table ${tableNumber}</h2>
          <p class="small muted" style="margin:0">${esc(rnd.label)}${amend ? ' (closed) &middot; correcting' : ''} &middot; points must total ${fmtPoints(tableTotal)}</p>
        </div>
        <button class="ghost" id="closeSheet" aria-label="Close">&times;</button>
      </header>
      ${rows}
      <div class="grid two" style="margin-top:12px">
        <label class="field"><span>Riichi sticks left on the table <button type="button" class="qmark" data-help="riichi-left" aria-label="What is this?">?</button></span>
          <input type="number" id="eRiichi" min="0" max="20" value="${num(table.riichiLeft)}"></label>
        <label class="field"><span>Entered by</span>
          <input type="text" id="eBy" value="${esc(table.enteredBy)}" placeholder="your name"></label>
        ${online && !amend ? `<label class="field"><span>Lobby / room code</span>
          <input type="text" id="eLobby" value="${esc(table.lobby)}" placeholder="e.g. 12345"></label>` : ''}
        ${amend ? `<label class="field" style="grid-column:1/-1"><span>Why is it being corrected?</span>
          <input type="text" id="eReason" placeholder="e.g. South's score was typed as 32,000; the sheet says 23,000"></label>` : ''}
      </div>
      <div class="checksum" id="eChecksum"><span>Table total</span><span class="v">&mdash;</span></div>
      <p class="small muted" id="eHint" style="margin:6px 0 0"></p>
      <div id="ePreview"></div>
      <details class="adv">
        <summary>Chombo and penalties</summary>
        <div class="scroll"><table class="data" style="margin-top:8px">
          <thead><tr><th>Player</th><th>Chombo <button type="button" class="qmark" data-help="chombo" aria-label="What is this?">?</button></th><th class="num">Penalty P <button type="button" class="qmark" data-help="penalty" aria-label="What is this?">?</button></th><th>Note</th></tr></thead>
          <tbody>${penaltyRows}</tbody></table></div>
        <p class="small muted">A chombo takes ${esc(state.store.doc.rules.chomboPenalty)}P off the
          tournament score and does not change the table total.</p>
      </details>
      <div class="btnrow sheet-actions">
        <button class="primary big" id="eSave">${amend ? 'Save correction' : 'Save scores'}</button>
        ${amend ? '' : `<button id="eVerify"${table.status === 'pending' ? ' disabled' : ''}>Mark verified</button>`}
        <span class="spacer"></span>
        ${!amend && table.status !== 'pending' ? '<button class="danger" id="eClear">Clear</button>' : ''}
      </div>
    </div>
  </div>`;

  const inputs = $$('#dialog .entry-row input');
  const closeSheet = () => {
    $('#dialog').innerHTML = '';
    if (entryTimer) clearTimeout(entryTimer);
  };

  $('#closeSheet').addEventListener('click', closeSheet);
  $('#backdrop').addEventListener('click', (e) => { if (e.target.id === 'backdrop') closeSheet(); });
  document.addEventListener('keydown', function onKey(e) {
    if (!$('#backdrop')) { document.removeEventListener('keydown', onKey); return; }
    if (e.key === 'Escape') { closeSheet(); document.removeEventListener('keydown', onKey); }
  });

  const collect = () => inputs.filter((i) => i.value !== '').map((i) => ({
    playerId: num(i.dataset.pid),
    rawScore: num(i.value),
    chombo: num($(`[data-cb="${i.dataset.pid}"]`).value),
    penaltyPoints: $(`[data-pp="${i.dataset.pid}"]`).value || '0',
    penaltyNote: $(`[data-pn="${i.dataset.pid}"]`).value || '',
  }));

  function refreshChecksum() {
    const filled = inputs.filter((i) => i.value !== '');
    const sum = filled.reduce((a, i) => a + num(i.value), 0) + 1000 * num($('#eRiichi').value);
    const box = $('#eChecksum');
    const diff = sum - tableTotal;
    const allIn = filled.length === inputs.length;
    box.className = 'checksum' + (allIn ? (diff === 0 ? ' good' : ' bad') : '');
    box.innerHTML =
      `<span>${allIn
        ? (diff === 0 ? 'Totals check out' : 'Does not add up')
        : `${filled.length} of ${inputs.length} entered`}</span>`
      + `<span class="v">${fmtPoints(sum)} / ${fmtPoints(tableTotal)}`
      + `${allIn && diff !== 0 ? ` (${diff > 0 ? '+' : ''}${fmtPoints(diff)})` : ''}</span>`;

    const blanks = inputs.filter((i) => i.value === '');
    $('#eHint').innerHTML = blanks.length === 1
      ? `<button class="ghost" id="eFill">Fill ${esc(
        blanks[0].closest('.entry-row').querySelector('.nm').textContent)} with `
        + `${fmtPoints(tableTotal - sum)}</button>`
      : '';
    const fill = $('#eFill');
    if (fill) {
      fill.addEventListener('click', () => {
        blanks[0].value = String(tableTotal - sum);
        refreshChecksum();
        schedulePreview();
      });
    }
  }

  function schedulePreview() {
    if (entryTimer) clearTimeout(entryTimer);
    entryTimer = setTimeout(() => {
      const entries = collect();
      if (entries.length !== inputs.length) { $('#ePreview').innerHTML = ''; return; }
      try {
        const out = state.store.previewTable(rnd.id, tableNumber, entries,
          { riichiLeft: num($('#eRiichi').value) });
        const issues = out.issues
          .map((i) => `<div class="issue ${esc(i.severity)}">${esc(i.message)}</div>`).join('');
        const hasOka = out.seats.some((s) => Number(s.oka));
        const body = out.seats.map((s) => `<tr>
          <td class="mono">${s.placement}${s.sharedPlacement ? '=' : ''}</td>
          <td>${esc(s.name)}</td>
          <td class="num">${fmtScore(s.scoreDelta)}</td>
          <td class="num">${fmtScore(s.uma)}</td>
          ${hasOka ? `<td class="num">${fmtScore(s.oka)}</td>` : ''}
          <td class="num"><strong>${fmtScore(s.hanchanScore)}</strong></td>
        </tr>`).join('');
        $('#ePreview').innerHTML = issues
          + `<div class="preview"><table><thead><tr><th>#</th><th>Player</th>
            <th class="num">Delta</th><th class="num">Uma</th>${hasOka ? '<th class="num">Oka</th>' : ''}
            <th class="num">Hanchan</th></tr></thead><tbody>${body}</tbody></table></div>`;
        // The deliberate way past the check, for a sheet that is signed as it is.
        if (!out.ok) {
          $('#ePreview').insertAdjacentHTML('beforeend', `<div class="btnrow" style="margin-top:8px">
            <button class="danger" id="eOverride">Record as signed</button>
            <span class="small muted">Only if the signed sheet really says this. The table is
              marked, and the log keeps it.</span></div>`);
          $('#eOverride').addEventListener('click', () => confirmThen(
            {
              text: `Record table ${tableNumber} as signed, although it does not add up?`,
              confirm: 'Record as signed',
              danger: true,
            },
            () => save(true)));
        }
      } catch (err) {
        $('#ePreview').innerHTML = `<div class="issue error">${esc(err.message)}</div>`;
      }
    }, 120);
  }

  /* allowIssues: record the table as the signed sheet says although it does
   * not add up -- only ever from the deliberate "Record as signed" button. */
  const save = (allowIssues = false) => guard(() => {
    const entries = collect();
    if (entries.length !== inputs.length) {
      return toast('Every player at the table needs a score.', 'warn');
    }
    if (amend) {
      state.store.amendTable(rnd.id, tableNumber, entries, {
        riichiLeft: num($('#eRiichi').value),
        enteredBy: $('#eBy').value,
        reason: $('#eReason').value,
        allowIssues,
      });
      loadStandings();
      closeSheet();
      render();
      toast(`Table ${tableNumber} of ${rnd.label} corrected. The log keeps the scores as they were.`);
      return null;
    }
    if (online && $('#eLobby')) {
      state.store.setTableLobby(rnd.id, tableNumber, $('#eLobby').value);
    }
    state.round = state.store.saveTable(rnd.id, tableNumber, entries, {
      riichiLeft: num($('#eRiichi').value),
      enteredBy: $('#eBy').value,
      allowIssues,
    });
    loadStandings();
    closeSheet();
    render();
    toast(allowIssues
      ? `Table ${tableNumber} recorded as signed. It is marked on the table and in the log.`
      : `Table ${tableNumber} saved.`);
    return null;
  });

  inputs.forEach((input, index) => {
    input.addEventListener('input', () => { refreshChecksum(); schedulePreview(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const next = inputs[index + 1];
        if (next) next.focus(); else $('#eSave').focus();
      }
    });
  });
  $('#eRiichi').addEventListener('input', () => { refreshChecksum(); schedulePreview(); });

  refreshChecksum();
  schedulePreview();
  const firstBlank = inputs.find((i) => i.value === '');
  if (firstBlank) firstBlank.focus();

  $('#eSave').addEventListener('click', () => save());

  const verify = $('#eVerify');
  if (verify) {
    verify.addEventListener('click', async () => {
      const who = await ask({
        text: `Mark table ${tableNumber} as checked against the signed sheet.`,
        confirm: 'Mark verified',
        input: { label: 'Verified by (referee or staff name)', value: $('#eBy').value || '' },
      });
      if (who === null) return;
      guard(() => {
        state.round = state.store.verifyTable(rnd.id, tableNumber, who);
        closeSheet();
        render();
        toast(`Table ${tableNumber} verified.`);
      });
    });
  }

  const clear = $('#eClear');
  if (clear) {
    clear.addEventListener('click', () => confirmThen(
      { text: `Clear the result for table ${tableNumber}?`, confirm: 'Clear', danger: true },
      () => guard(() => {
        state.round = state.store.clearTable(rnd.id, tableNumber);
        loadStandings();
        closeSheet();
        render();
        toast('Table cleared.');
      })));
  }
}

/* ----------------------------------------------------------- standings */

function renderStandings() {
  $$('.scopeBtn').forEach((b) => b.classList.toggle('primary', b.dataset.scope === state.scope));
  const rows = state.standings;
  if (!rows.length) {
    $('#standingsBody').innerHTML = '<div class="card empty"><h3>Nothing to show yet</h3>'
      + '<p class="muted">Standings appear once a table has been scored.</p></div>';
    return;
  }
  const players = new Map(state.store.listPlayers().map((p) => [p.id, p]));
  const anyTie = rows.some((r) => r.needsCoinToss);
  const anyCarry = rows.some((r) => !r.carryOver.isZero);
  const anyBye = rows.some((r) => r.byes);
  const prec = state.store.rules.scorePrecision;

  const columns = 12 + (anyBye ? 1 : 0) + (anyCarry ? 1 : 0);
  const body = rows.map((r, i) => {
    const p = players.get(r.playerId) || {};
    const cutLine = r.stage === 'qualifying' && i > 0 && rows[i - 1].stage === 'final'
      ? `<tr><td colspan="${columns}" class="small muted" style="padding-top:14px">`
        + 'Did not make the cut &mdash; placed by qualifying score</td></tr>'
      : '';
    return `${cutLine}<tr>
    <td class="num ${r.rank === 1 ? 'rank1' : ''}">${r.rank}${r.needsCoinToss ? '*' : ''}</td>
    <td>${esc(r.name)}${p.status && p.status !== 'active'
      ? ` <span class="chip bad">${esc(p.status)}</span>` : ''}</td>
    <td class="muted">${esc(p.club || '')}</td>
    <td class="num ${r.rank === 1 ? 'rank1' : ''}"><strong>${fmtScore(r.tournamentScore, prec)}</strong></td>
    <td class="num">${r.hanchanPlayed}</td>
    <td class="num">${r.firsts}</td><td class="num">${r.seconds}</td>
    <td class="num">${r.thirds}</td><td class="num">${r.fourths}</td>
    <td class="num">${r.bestHanchan ? fmtScore(r.bestHanchan.toFixed(prec)) : ''}</td>
    <td class="num">${r.averagePlacement ? esc(r.averagePlacement.truncate(2).toFixed(2)) : ''}</td>
    ${anyBye ? `<td class="num">${r.byes || ''}</td>` : ''}
    ${anyCarry ? `<td class="num">${!r.carryOver.isZero ? fmtScore(r.carryOver.toFixed(prec)) : ''}</td>` : ''}
    <td class="num">${!r.penaltyTotal.isZero ? `&minus;${esc(r.penaltyTotal.toFixed(prec))}` : ''}</td>
  </tr>`;
  }).join('');

  $('#standingsBody').innerHTML = `
  <div class="card">
    <div class="scroll"><table class="data">
      <thead><tr>
        <th class="num">#</th><th>Player</th><th>Club</th><th class="num">Score</th>
        <th class="num" title="Hanchan played">HC</th>
        <th class="num">1st</th><th class="num">2nd</th><th class="num">3rd</th><th class="num">4th</th>
        <th class="num">Best</th><th class="num" title="Average placement">Avg</th>
        ${anyBye ? '<th class="num">Byes</th>' : ''}
        ${anyCarry ? '<th class="num">Carried</th>' : ''}
        <th class="num">Pen.</th>
      </tr></thead><tbody>${body}</tbody>
    </table></div>
    ${anyTie ? '<p class="small" style="color:var(--warn);margin-top:10px">* Still level after every '
      + 'tiebreaker. WRC settles this with a coin toss &mdash; record the result as a manual '
      + 'tiebreak on the Players tab.</p>' : ''}
    ${rows.some((r) => r.stage) ? `<p class="small muted">After the cut, Overall is how the
      event finished: the finalists in their finals order, then everyone else by their
      qualifying score.${rows.some((r) => r.stage === 'final' && !r.hanchanPlayed)
    ? ' No final hanchan has been scored yet, so the finalists stand in seeding order.' : ''}</p>` : ''}
    <p class="small muted" style="margin-bottom:0">Ranked by score, then most firsts, fewest lasts,
      best single hanchan, then any manual tiebreak.</p>
  </div>`;
}

/* -------------------------------------------------------------- finals */

function renderFinals() {
  const t = state.store.doc;
  if (!t) return;
  const cut = t.config.cut || {};
  const rounds = state.store.listRounds();
  const qualifying = rounds.filter((r) => r.phase === 'qualifying');
  const openRound = rounds.find((r) => r.status !== 'complete');
  const finals = rounds.filter((r) => r.phase === 'final');
  const players = new Map(state.store.listPlayers().map((p) => [p.id, p]));
  const penalties = state.store.listPenalties();
  const sel = (a, b) => (a === b ? ' selected' : '');

  const qualifiedHtml = cut.applied ? `<div class="card">
      <h2>Through to the finals</h2>
      <ol>${(cut.qualified || []).map((id) => `<li>${esc((players.get(id) || {}).name || id)}`
        + (cut.carry !== 'reset' && cut.carryScores
          ? ` <span class="muted small">carrying ${fmtScore(
            Number(cut.carryScores[id]) * (cut.carry === 'half' ? 0.5 : 1))}P</span>` : '')
        + '</li>').join('')}</ol>
      ${(cut.passedOver || []).length ? `<p class="small muted">Passed over, having withdrawn:
        ${esc(cut.passedOver.map((id) => (players.get(id) || {}).name || id).join(', '))}.</p>` : ''}
      <p class="small muted">${cut.carry === 'reset'
        ? 'Points reset to zero for the finals, as in the ARA format.'
        : cut.carry === 'half' ? 'Half of each qualifying score is carried in.'
          : 'Full qualifying scores are carried in.'}
        ${finals.length} of ${num(cut.rounds)} final hanchan seated.</p>
      <div class="btnrow">
        <button class="danger" id="undoCut"${finals.length ? ' disabled' : ''}>Undo the cut</button>
        ${finals.length ? '<span class="small muted">Delete the final rounds first to undo.</span>' : ''}
      </div>
    </div>` : '';

  $('#finalsBody').innerHTML = `
  <div class="card">
    <h2>Make the cut</h2>
    <p class="small muted">
      ${qualifying.filter((r) => r.status === 'complete').length} qualifying hanchan complete.
      ${openRound ? `<strong>Round ${openRound.number} is still open</strong> &mdash; close it first.` : ''}
    </p>
    <div class="grid three">
      <label class="field"><span>Cut to top</span>
        <input type="number" id="cSize" min="1" max="128" value="${num(cut.size) || 4}"></label>
      <label class="field"><span>Final hanchan</span>
        <input type="number" id="cRounds" min="1" max="20" value="${num(cut.rounds) || 2}"></label>
      <label class="field"><span>Points going in</span>
        <select id="cCarry">
          <option value="reset"${sel(cut.carry, 'reset')}>Reset to zero (ARA)</option>
          <option value="full"${sel(cut.carry, 'full')}>Carry the full score</option>
          <option value="half"${sel(cut.carry, 'half')}>Carry half</option>
        </select></label>
      <label class="field check" style="grid-column:1/-1">
        <span><input type="checkbox" id="cFree"${cut.freePlayForRest !== false ? ' checked' : ''}>
          Seat everyone else at free-play tables during each final</span>
        <span class="hint">They are seated and printed with the final, but not scored.
          This can be changed after the cut too.</span>
      </label>
    </div>
    <div class="btnrow">
      <button class="primary big" id="cutBtn"${cut.applied || openRound ? ' disabled' : ''}>
        ${cut.applied ? 'Cut already made' : 'Make the cut'}</button>
    </div>
  </div>
  ${qualifiedHtml}
  <div class="card">
    <h2>Penalties</h2>
    <p class="small muted">Point penalties come off the tournament score and do not change any
      table total.</p>
    <div class="grid three">
      <label class="field"><span>Player</span>
        <select id="pPlayer">${state.store.listPlayers()
          .map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></label>
      <label class="field"><span>Points off (P)</span>
        <input type="number" id="pPoints" value="${esc(t.rules.chomboPenalty)}"></label>
      <label class="field"><span>Reason</span>
        <input type="text" id="pReason" placeholder="late for hanchan 3"></label>
      <label class="field"><span>Counts towards</span>
        <select id="pPhase">
          <option value="qualifying"${cut.applied ? '' : ' selected'}>Qualifying</option>
          <option value="final"${cut.applied ? ' selected' : ' disabled'}>Finals</option>
        </select></label>
    </div>
    <div class="btnrow"><button id="pAdd">Add penalty</button></div>
    ${penalties.length ? `<div class="scroll" style="margin-top:12px"><table class="data">
      <thead><tr><th>Player</th><th class="num">Points</th><th>Reason</th><th>Counts towards</th><th>When</th><th></th></tr></thead>
      <tbody>${penalties.map((p) => `<tr><td>${esc(p.playerName)}</td>
        <td class="num">&minus;${esc(p.points)}</td><td>${esc(p.reason)}</td>
        <td>${p.phase === 'final' ? 'Finals' : 'Qualifying'}</td>
        <td class="small muted">${esc(when(p.createdAt))}</td>
        <td><button class="ghost danger" data-pdel="${p.id}">&times;</button></td></tr>`).join('')}
      </tbody></table></div>` : ''}
  </div>`;

  $('#cutBtn').addEventListener('click', () => guard(() => {
    const size = num($('#cSize').value);
    state.store.applyCut({
      size,
      rounds: num($('#cRounds').value),
      carry: $('#cCarry').value,
      freePlayForRest: $('#cFree').checked,
    });
    loadTournaments().then(render);
    render();
    const skipped = (state.store.doc.config.cut.passedOver || []).length;
    toast(`Cut made: top ${size} go through.`
      + (skipped ? ` ${skipped} withdrawn player${skipped === 1 ? ' was' : 's were'} passed over.` : ''));
  }));

  // Before the cut the box is read when the cut is made; after it, a change
  // applies from the next final drawn.
  $('#cFree').addEventListener('change', () => {
    if (!cut.applied) return;
    guard(() => {
      const on = $('#cFree').checked;
      state.store.update({ config: { cut: { freePlayForRest: on } } });
      toast(on
        ? 'The next final will seat everyone else at free-play tables.'
        : 'The next final will seat the finalists only.');
    });
  });

  const undo = $('#undoCut');
  if (undo) {
    undo.addEventListener('click', () => confirmThen({
      text: 'Undo the cut? Everyone goes back to the qualifying standings.',
      confirm: 'Undo the cut',
      danger: true,
    }, () => guard(() => {
      state.store.undoCut();
      render();
      toast('Cut undone.');
    })));
  }

  $('#pAdd').addEventListener('click', () => guard(() => {
    state.store.addPenalty(num($('#pPlayer').value), $('#pPoints').value,
      { reason: $('#pReason').value, phase: $('#pPhase').value });
    loadStandings();
    render();
    toast('Penalty recorded.');
  }));

  $$('[data-pdel]').forEach((b) => b.addEventListener('click', () => {
    const row = b.closest('tr');
    const who = row ? row.cells[0].textContent : 'this player';
    confirmThen({
      text: `Remove the penalty against ${who}? It comes straight back off their score.`,
      confirm: 'Remove penalty',
      danger: true,
    },
      () => guard(() => {
        state.store.deletePenalty(num(b.dataset.pdel));
        loadStandings();
        render();
        toast('Penalty removed.');
      }));
  }));
}

/* ------------------------------------------------------------- backups */

function renderBackups() {
  const t = state.store.doc;
  if (!t) return;
  const s = backups.status();
  const files = Object.keys(buildAll(state.store)).sort();

  const pausedCard = s.awaitingFolder ? `<div class="card">
        <h2>Backups are paused</h2>
        <div class="issue warning">The browser has forgotten its permission to write to
          <strong>${esc(s.awaitingFolder)}</strong>, which it does after a restart. Nothing
          is being written there until you reconnect it. Your work is still saved in this
          browser.</div>
        <div class="btnrow">
          <button class="primary big" id="reconnectBtn">Reconnect "${esc(s.awaitingFolder)}"</button>
          <button class="ghost" id="pickFolder">Choose a different folder</button>
        </div>
      </div>` : '';
  const folderCard = pausedCard || (s.mode === 'folder'
    ? `<div class="card">
        <h2>Backup folder</h2>
        <p class="small" style="color:var(--ok)">Writing to <strong>${esc(s.folder)}</strong>
          after every change.</p>
        <p class="small muted">If that folder is inside OneDrive, Google Drive or Dropbox, every
          round is copied off this laptop automatically.</p>
        <ul class="filelist">
          <li><span class="mono">live/</span><span class="muted small">the full CSV set, rewritten after every change</span></li>
          <li><span class="mono">log/</span><span class="muted small">append-only: every change, and every score ever entered</span></li>
          <li><span class="mono">snapshots/</span><span class="muted small">a dated copy each time a round closes</span></li>
          <li><span class="mono">restore/tournament.json</span><span class="muted small">everything needed to rebuild this event</span></li>
        </ul>
        ${s.lastWrite ? `<p class="small muted">Last written ${esc(when(s.lastWrite))}.</p>` : ''}
        ${s.lastError ? `<div class="issue error">The last backup failed: ${esc(s.lastError)}</div>` : ''}
        <div class="btnrow">
          <button id="snapBtn">Take a snapshot now</button>
          <button class="ghost" id="changeFolder">Change folder</button>
        </div>
      </div>`
    : s.supported
      ? `<div class="card">
        <h2>Choose a backup folder</h2>
        <div class="issue warning">Nothing is being written to disk yet. Everything lives in this
          browser, which means it would not survive this laptop failing.</div>
        <p class="small muted">Pick a folder and every change is written there as CSV, with a dated
          snapshot each time a round closes. <strong>Choose a folder inside OneDrive or Google
          Drive</strong> and your event is backed up off this machine automatically &mdash; no
          account and no setup, the sync client does it.</p>
        <div class="btnrow"><button class="primary big" id="pickFolder">Choose a folder</button><button type="button" class="qmark" data-help="backup-folder" aria-label="What is this?">?</button></div>
      </div>`
      : `<div class="card">
        <h2>Backups</h2>
        <div class="issue warning">This browser cannot write to a folder directly. Chrome or Edge
          can, and will then back up every round automatically. Here, save a restore point by hand
          after each round.</div>
        ${s.pendingSinceRound
          ? `<div class="issue error">${s.pendingSinceRound} round${s.pendingSinceRound === 1 ? ' has' : 's have'} closed since the last
             saved backup.</div>` : ''}
        <div class="btnrow">
          <button class="primary big" id="dlRestore">Save a restore point</button>
          <button id="dlAll">Download all CSVs</button>
        </div>
      </div>`);

  const dcfg = discordState.config || {};
  const isDemo = Boolean(t.config && t.config.demo);
  const discordCard = `
  <div class="card">
    <h2>Post to Discord
      <button type="button" class="qmark" data-help="discord"
        aria-label="What is this?">?</button></h2>
    <p class="small muted">Keeps one pairings post and one standings post in a
      channel, editing them as the day goes on rather than adding a new message
      each time.</p>
    ${isDemo ? `<div class="issue warning">This is a test tournament. Posts
      <b>do</b> go to the channel, coloured and labelled as a test — point the
      webhook at a channel where made-up players are welcome.</div>` : ''}
    <div class="grid two">
      <label class="field" style="grid-column:1/-1"><span>Webhook URL</span>
        <input type="password" id="dcUrl" autocomplete="off" spellcheck="false"
          placeholder="https://discord.com/api/webhooks/…"
          value="${esc(dcfg.url || '')}"></label>
    </div>
    <p class="small muted">In Discord: <b>Channel Settings → Integrations →
      Webhooks → New Webhook</b>, then Copy Webhook URL. It can post to that one
      channel and nothing else: it cannot read messages or see your members.</p>
    <div class="issue warning">Your players' names leave this computer when you
      post. The webhook URL is a password for that channel, so it is kept out of
      your backup folder and out of restore points.</div>
    <div class="btnrow">
      <button class="primary" id="dcSave">Save</button>
      <button class="ghost" id="dcPost"${discordReady() ? '' : ' disabled'}>Post now</button>
      <button class="ghost" id="dcClear"${discordReady() ? '' : ' disabled'}>Forget it</button>
      <span class="small muted">${esc(discordState.last || discordBlockedReason()
    || 'Saved. Posts update after each draw and each round closes.')}</span>
    </div>
  </div>`;

  $('#backupsBody').innerHTML = folderCard + discordCard + `
  <div class="card">
    <h2>Download a single file</h2>
    <div class="btnrow">
      <button class="ghost" id="dlRestore2">tournament.json (restore point)</button>
      ${files.map((f) => `<button class="ghost" data-csv="${esc(f)}">${esc(f)}</button>`).join('')}
    </div>
  </div>

  <div class="card">
    <h2>Print</h2>
    <div class="btnrow">
      <button class="ghost" data-print2="seating">Seating</button>
      <button class="ghost" data-print2="scoresheets">Table report sheets</button>
      <button class="ghost" data-print2="standings">Standings</button>
      <button class="ghost" data-print2="signin">Sign-in sheet</button>
      <button class="ghost" data-print2="tablecards">Table numbers</button>
    </div>
  </div>`;

  const pick = $('#pickFolder') || $('#changeFolder');
  if (pick) {
    pick.addEventListener('click', () => guard(async () => {
      const target = await FolderTarget.pick();
      await persistence.saveFolderHandle(target.handle);
      backups.setTarget(target);
      await backups.refresh(state.store);
      render();
      toast(`Backing up to "${target.name}".`);
    }));
  }
  const reconnect = $('#reconnectBtn');
  if (reconnect) {
    reconnect.addEventListener('click', () => guard(async () => {
      if (!(await backups.reconnect())) {
        toast('The browser did not give permission. Try again, or choose a folder.', 'warn', 9000);
        return null;
      }
      await backups.refresh(state.store);
      await backups.snapshot(state.store, 'reconnected');
      render();
      toast(`Backing up to "${backups.status().folder}" again.`);
      return null;
    }));
  }
  const snap = $('#snapBtn');
  if (snap) {
    snap.addEventListener('click', () => guard(async () => {
      const dir = await backups.snapshot(state.store, 'manual');
      render();
      toast(`Snapshot written: ${dir.split('/').pop()}`);
    }));
  }
  for (const id of ['dlRestore', 'dlRestore2']) {
    const btn = $('#' + id);
    if (btn) {
      btn.addEventListener('click', () => {
        backups.downloadRestorePoint(state.store);
        render();
        toast('Restore point saved to your downloads.');
      });
    }
  }
  $('#dcSave').addEventListener('click', () => guard(async () => {
    const url = $('#dcUrl').value.trim();
    if (!url) { toast('Paste the webhook URL first.', 'warn'); return null; }
    // Refuse a bad URL here rather than at the first failed post.
    const { url: clean } = parseWebhook(url);
    // A different webhook means different messages, so forget the old ids.
    const keep = (discordState.config || {}).url === clean ? discordState.config : {};
    await saveDiscordConfig({ ...keep, url: clean });
    discordState.last = 'Saved.';
    toast('Discord webhook saved.');
    render();
    return null;
  }));

  $('#dcPost').addEventListener('click', () => guard(async () => {
    await postToDiscord('both');
    return null;
  }));

  $('#dcClear').addEventListener('click', () => confirmThen(
    { text: 'Forget the webhook? Posts already in Discord stay there.', confirm: 'Forget it', danger: true },
    () => guard(async () => {
      await saveDiscordConfig(null);
      discordState.last = '';
      toast('Webhook forgotten.');
      render();
      return null;
    }),
  ));

  const dlAll = $('#dlAll');
  if (dlAll) dlAll.addEventListener('click', () => backups.downloadAllCsv(state.store));

  $$('[data-csv]').forEach((b) => b.addEventListener('click', () =>
    guard(() => backups.downloadCsv(state.store, b.dataset.csv))));
  $$('[data-print2]').forEach((b) => b.addEventListener('click', () =>
    guard(() => openPrintWindow(printPage(state.store, b.dataset.print2), t.name))));
}

/* ------------------------------------------------------------ data load */

async function loadTournaments() {
  try {
    state.tournaments = await persistence.listTournaments();
  } catch {
    state.tournaments = [];
  }
}

/* ---------------------------------------------------------------- help */

function renderHelp() {
  const nav = TOPICS.map((t) => `<button class="helpnav-item${
    t.id === state.helpTopic ? ' on' : ''}" data-topic="${esc(t.id)}">${esc(t.title)}</button>`)
    .join('');
  const topic = TOPICS.find((t) => t.id === state.helpTopic) || TOPICS[0];

  $('#helpBody').innerHTML = `
    <div class="helpwrap">
      <nav class="helpnav" aria-label="Help topics">${nav}</nav>
      <article class="helptopic card">
        <h2>${esc(topic.title)}</h2>
        ${topic.body}
      </article>
    </div>`;

  $$('#helpBody .helpnav-item').forEach((b) => b.addEventListener('click', () => {
    state.helpTopic = b.dataset.topic;
    renderHelp();
  }));
}

/* The "?" bubbles. One delegated listener, so markup rendered later still
 * works, and the wording lives in help.js rather than inline in the markup. */
function closeHelpPop() {
  const pop = $('#helpPop');
  pop.innerHTML = '';
  pop.classList.remove('on');
  delete pop.dataset.key;
}

function openHelpPop(button) {
  const key = button.dataset.help;
  const text = FIELD_HELP[key];
  const pop = $('#helpPop');
  if (!text) {
    // Better a visible gap than silence. A test also checks that every "?" in
    // the markup resolves, so this should be unreachable.
    toast(`No help written for "${key}" yet.`, 'warn');
    return;
  }
  if (pop.classList.contains('on') && pop.dataset.key === key) { closeHelpPop(); return; }

  pop.innerHTML = `<p>${esc(text)}</p>
    <button type="button" class="helppop-close">Got it</button>`;
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'Field help');
  pop.dataset.key = key;
  pop.classList.add('on');

  // Sit it under the bubble, nudged back inside the window if it would spill.
  // The popover is the positioned element itself rather than a wrapper around
  // one, so it has a real box -- a zero-height wrapper counts as invisible to
  // anything measuring it, tests included.
  const r = button.getBoundingClientRect();
  const width = Math.min(320, window.innerWidth - 24);
  pop.style.width = `${width}px`;
  const left = Math.max(12, Math.min(r.left + window.scrollX - 8,
    window.innerWidth - width - 12));
  pop.style.left = `${left}px`;
  pop.style.top = `${r.bottom + window.scrollY + 8}px`;

  const closer = $('.helppop-close', pop);
  closer.addEventListener('click', closeHelpPop);
  closer.focus();
}

function initFieldHelp() {
  document.addEventListener('click', (e) => {
    const bubble = e.target.closest ? e.target.closest('.qmark') : null;
    if (bubble) {
      e.preventDefault();
      e.stopPropagation();
      openHelpPop(bubble);
      return;
    }
    if (!e.target.closest || !e.target.closest('#helpPop')) closeHelpPop();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('#helpPop').classList.contains('on')) closeHelpPop();
  });
}

/* ------------------------------------------------------------- tutorial */

/* Light up the control a tutorial step is talking about.
 *
 * The ring is drawn with box-shadow: a coloured outline, then a very large
 * spread of translucent black, which dims everything else without needing an
 * overlay element to position or a hole to cut in it. The tutorial bar sits
 * above that dimming, so its own text stays readable.
 *
 * A target that is not on the page is skipped rather than throwing. Several
 * are drawn only once a round exists, and a step that cannot point at
 * anything should still read fine.
 */
function clearSpotlight() {
  $$('.rt-spot').forEach((el) => el.classList.remove('rt-spot'));
}

/* Bring the target into view, ready for the callout to be placed beside it.
 *
 * A target that fits is centred, which leaves the most room on every side for
 * the box and is why the step text so rarely has to overlap anything.
 *
 * A target taller than the window cannot be centred usefully -- that buries
 * its first rows off the top -- so it is aligned to the top instead, with
 * scroll-margin in the stylesheet keeping it clear of the header. Its top is
 * then where the reader is looking, and placeCallout() puts the box at the
 * far corner.
 */
function scrollToTarget(el) {
  const tall = el.getBoundingClientRect().height > window.innerHeight * 0.6;
  try {
    el.scrollIntoView({
      block: tall ? 'start' : 'center', inline: 'nearest', behavior: 'smooth',
    });
  } catch {
    el.scrollIntoView();
  }
}

function spotlight(selector) {
  clearSpotlight();
  if (!selector) return null;
  const el = $(selector);
  if (!el) return null;
  // Consecutive steps sometimes point at the same element: both score steps
  // light table 1, and two steps light the standings. Removing and re-adding
  // a class within one tick does not restart its animation, so the ring would
  // simply sit there instead of closing in again. Reading offsetWidth forces
  // the reflow that makes it retrigger.
  void el.offsetWidth;
  el.classList.add('rt-spot');
  scrollToTarget(el);
  return el;
}

/* ------------------------------------------------------------------------
 * Where the callout goes, and keeping the page still under it.
 *
 * The callout is pinned to the control the current step is about. That means
 * three things have to be handled, and each was a fault in the bottom-sheet
 * design it replaced:
 *
 *   - it must not cover its own target, so it is placed on whichever side of
 *     the target has room for it;
 *   - it must stay put, so it is re-placed on scroll and resize rather than
 *     measured once;
 *   - nothing else on the page may move or change under it, so the page is
 *     locked while the tutorial runs.
 * --------------------------------------------------------------------- */

const CALLOUT_GAP = 14; // clear space between the target and the box
const CALLOUT_EDGE = 10; // smallest gap to the window edge

/* The parts of the page the tutorial takes over. The callout is not among
 * them, so its own buttons keep working. */
const LOCK_PARTS = ['header.top', 'nav.tabs', '#testBanner', 'main'];

const clampTo = (v, lo, hi) => Math.max(lo, Math.min(v, hi));

const reducedMotion = () => {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch { return false; }
};

/* Put the box beside the target and point the arrow back at it.
 *
 * Sides are tried in reading order -- below, right, above, left -- and the
 * first with room for the whole box wins. A target too big to clear on any
 * side (a full standings table, say) falls back to the roomiest side and is
 * clamped into the window, which overlaps an edge of it; that is the best
 * available when the target is larger than the space around it.
 */
function placeCallout(bar, target) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = bar.offsetWidth;
  const h = bar.offsetHeight;

  if (!target || !target.isConnected) {
    bar.dataset.side = 'center';
    bar.style.left = `${Math.round((vw - w) / 2)}px`;
    bar.style.top = `${Math.round((vh - h) / 2)}px`;
    return;
  }

  const r = target.getBoundingClientRect();
  const midX = r.left + (r.width / 2) - (w / 2);
  const midY = r.top + (r.height / 2) - (h / 2);
  const sides = [
    {
      side: 'bottom', room: vh - r.bottom - CALLOUT_GAP, need: h, left: midX, top: r.bottom + CALLOUT_GAP,
    },
    {
      side: 'right', room: vw - r.right - CALLOUT_GAP, need: w, left: r.right + CALLOUT_GAP, top: midY,
    },
    {
      side: 'top', room: r.top - CALLOUT_GAP, need: h, left: midX, top: r.top - CALLOUT_GAP - h,
    },
    {
      side: 'left', room: r.left - CALLOUT_GAP, need: w, left: r.left - CALLOUT_GAP - w, top: midY,
    },
  ];
  const pick = sides.find((s) => s.room >= s.need);

  if (!pick) {
    // Nothing fits, because the target is larger than the space around it: a
    // whole standings table, say. Overlapping it somewhere is unavoidable, so
    // overlap the part that matters least. scrollToTarget() has put such a
    // target's top near the top of the window, which is where the rows being
    // described are, so the box goes to the bottom-right corner and covers
    // the tail of the panel instead.
    //
    // No arrow either: an arrow pointing at something that fills the screen
    // tells the reader nothing, and a long one across the page reads as a
    // mistake.
    bar.dataset.side = 'inside';
    bar.style.left = `${Math.round(vw - w - CALLOUT_EDGE - 6)}px`;
    bar.style.top = `${Math.round(vh - h - CALLOUT_EDGE - 6)}px`;
    return;
  }

  const left = clampTo(pick.left, CALLOUT_EDGE, Math.max(CALLOUT_EDGE, vw - w - CALLOUT_EDGE));
  const top = clampTo(pick.top, CALLOUT_EDGE, Math.max(CALLOUT_EDGE, vh - h - CALLOUT_EDGE));
  bar.dataset.side = pick.side;
  bar.style.left = `${Math.round(left)}px`;
  bar.style.top = `${Math.round(top)}px`;

  // The arrow sits on the edge facing the target, lined up with its middle,
  // but kept away from the rounded corners.
  const across = pick.side === 'bottom' || pick.side === 'top';
  const centre = across ? r.left + (r.width / 2) - left : r.top + (r.height / 2) - top;
  const span = across ? w : h;
  bar.style.setProperty('--arrow', `${Math.round(clampTo(centre, 18, Math.max(18, span - 18)))}px`);
}

/* Re-place the box whenever the page moves beneath it.
 *
 * The reader cannot scroll while the tutorial runs, but the tutorial itself
 * scrolls smoothly, which emits a stream of scroll events; one rAF-throttled
 * placement per frame keeps the box glued to the target for the whole glide.
 */
let stopTracking = null;

function trackCallout(bar, target) {
  if (stopTracking) stopTracking();
  let frame = 0;
  const place = () => { frame = 0; placeCallout(bar, target); };
  const onMove = () => { if (!frame) frame = requestAnimationFrame(place); };
  window.addEventListener('scroll', onMove, { passive: true });
  window.addEventListener('resize', onMove);
  stopTracking = () => {
    window.removeEventListener('scroll', onMove);
    window.removeEventListener('resize', onMove);
    if (frame) cancelAnimationFrame(frame);
    stopTracking = null;
  };
}

/** Hand the page over to the tutorial, or give it back. */
function lockPageForTutorial(on) {
  document.documentElement.classList.toggle('rt-locked', on);
  LOCK_PARTS.forEach((sel) => {
    const el = $(sel);
    if (!el) return;
    // Set both: the property is what browsers act on, the attribute is what
    // the stylesheet's pointer-events fallback matches.
    el.inert = on;
    if (on) el.setAttribute('inert', '');
    else el.removeAttribute('inert');
  });
}

/* ------------------------------------------------------------------------
 * The step's own demonstration.
 *
 * A step reads better when the thing it describes visibly happens. Three
 * primitives, each pointed at the real controls rather than a mock-up:
 *
 *   type   a roster typed into the real textarea, a few characters a frame
 *   press  a button shown being pressed
 *   fill   rows of a table arriving one after another
 *
 * Every one of these is decoration over data the step has already written
 * through the store, so anyone who has asked their system not to animate sees
 * the same finished state immediately and misses nothing.
 * --------------------------------------------------------------------- */

let showTimers = [];

function stopShow() {
  showTimers.forEach(clearTimeout);
  showTimers = [];
  $$('.rt-press').forEach((el) => el.classList.remove('rt-press'));
  $$('.rt-fill').forEach((el) => {
    el.classList.remove('rt-fill');
    el.style.removeProperty('--d');
  });
}

function playShow(show) {
  stopShow();
  if (!show) return;

  // Anyone who has asked their system not to animate gets the end state at
  // once rather than nothing: the typed roster still has to appear, because
  // the step's words describe it sitting in the box.
  if (reducedMotion()) {
    if (show.type) {
      const el = $(show.type.target);
      if (el && 'value' in el) el.value = String(show.type.text || '');
    }
    return;
  }

  if (show.press) {
    const el = $(show.press);
    if (el) {
      void el.offsetWidth;
      el.classList.add('rt-press');
      showTimers.push(setTimeout(() => el.classList.remove('rt-press'), 1100));
    }
  }

  if (show.fill) {
    const rows = $$(show.fill).slice(0, 24);
    rows.forEach((el, i) => {
      el.style.setProperty('--d', `${(i * 45) / 1000}s`);
      void el.offsetWidth;
      el.classList.add('rt-fill');
    });
    if (rows.length) showTimers.push(setTimeout(stopShow, (rows.length * 45) + 500));
  }

  if (show.type) {
    const el = $(show.type.target);
    const text = String(show.type.text || '');
    if (el && 'value' in el && text) {
      el.value = '';
      // A fixed number of frames, so a long roster is no slower to watch
      // than a short one. 36ms a frame is about 28 a second.
      const chunk = Math.max(1, Math.ceil(text.length / 40));
      let at = 0;
      const tick = () => {
        at = Math.min(text.length, at + chunk);
        el.value = text.slice(0, at);
        el.scrollTop = el.scrollHeight;
        if (at < text.length) showTimers.push(setTimeout(tick, 36));
      };
      tick();
    }
  }
}

function renderTutorialBar() {
  const bar = $('#tutorialBar');
  const info = state.tutorialStep;
  if (!info || !info.step) {
    bar.innerHTML = '';
    bar.classList.remove('on');
    bar.removeAttribute('data-side');
    clearSpotlight();
    stopShow();
    if (stopTracking) stopTracking();
    lockPageForTutorial(false);
    return;
  }

  const {
    step, index, total, isFirst, isLast,
  } = info;
  bar.classList.add('on');
  bar.innerHTML = `
    <div class="tut-inner" role="region" aria-label="Tutorial">
      <div class="tut-head">
        <span class="tut-count">Step ${index + 1} of ${total}</span>
        <h2 class="tut-title">${esc(step.title)}</h2>
        <button type="button" class="tut-x" id="tutQuit"
          aria-label="Close the tutorial">&times;</button>
      </div>
      <div class="tut-body">${step.body}</div>
      <div class="tut-foot">
        <progress class="tut-bar" max="${total}" value="${index + 1}"></progress>
        <span class="spacer"></span>
        <button type="button" class="ghost" id="tutPrev"${isFirst ? ' disabled' : ''}>
          &larr; Prev</button>
        <button type="button" class="primary" id="tutNext">${
  isLast ? 'Finish' : 'Next &rarr;'}</button>
      </div>
    </div>`;

  // The engine hands over a real previewTable result; show it as the app would.
  const slot = $('#tutorialPreview', bar);
  if (slot && info.preview) {
    const p = info.preview;
    const diff = p.enteredTotal - p.tableTotal;
    const head = p.ok
      ? `<div class="issue ok">Totals check out &mdash; ${fmtPoints(p.enteredTotal)} / ${
        fmtPoints(p.tableTotal)}</div>`
      : `<div class="issue error">Does not add up &mdash; ${fmtPoints(p.enteredTotal)} / ${
        fmtPoints(p.tableTotal)} (${diff > 0 ? '+' : ''}${fmtPoints(diff)})</div>`;
    const rows = p.seats.map((o) => `<tr>
        <td>${o.placement}${o.sharedPlacement ? '=' : ''}</td>
        <td>${esc(o.name)}</td>
        <td class="num">${o.scoreDelta}</td>
        <td class="num">${o.uma}</td>
        <td class="num"><b>${o.hanchanScore}</b></td>
      </tr>`).join('');
    slot.innerHTML = `${head}${p.ok ? `
      <table class="data compact"><thead><tr>
        <th>#</th><th>Player</th><th class="num">Delta</th>
        <th class="num">Uma</th><th class="num">Hanchan</th>
      </tr></thead><tbody>${rows}</tbody></table>` : ''}`;
  }

  lockPageForTutorial(true);
  const lit = spotlight(info.step.target);

  // Placed from the box's real size, which is only known now its content is
  // in, then kept on the target for the whole of the smooth scroll.
  placeCallout(bar, lit);
  trackCallout(bar, lit);
  playShow(info.step.show);

  $('#tutPrev').addEventListener('click', () => state.tutorial.prev());
  $('#tutNext').addEventListener('click', () => {
    if (isLast) state.tutorial.stop();
    else state.tutorial.next();
  });
  $('#tutQuit').addEventListener('click', () => state.tutorial.stop());
}

function startTutorial() {
  if (state.tutorial && state.tutorial.isActive()) {
    renderTutorialBar();
    return null;
  }
  state.tutorial = tutorialKit.createRunner({
    store: state.store,
    onStep: (info) => {
      state.tutorialStep = info;
      if (info.step) {
        if (info.step.view === 'standings') loadStandings();
        setView(info.step.view);
      }
      renderTutorialBar();
    },
    onStop: async () => {
      state.tutorialStep = null;
      clearSpotlight();
      renderTutorialBar();
      await loadTournaments();
      setView('home');
      toast('Tutorial closed. The demo event is in your list — delete it whenever.',
        'ok', 6000);
    },
    onError: (err) => {
      toast(`The tutorial could not continue: ${err && err.message ? err.message : err}`,
        'error', 8000);
    },
  });
  state.tutorial.start();
  return null;
}

function loadStandings() {
  try {
    state.standings = state.store.standings(state.scope);
  } catch {
    state.standings = [];
  }
}

async function openTournament(id) {
  const doc = await persistence.loadTournament(id);
  if (!doc) { toast('That tournament is no longer in this browser.', 'error'); return; }
  state.store.load(doc);
  state.round = null;
  state.amendRound = null;
  loadStandings();
  setView(state.store.listPlayers().length ? 'round' : 'players');
}

/* ---------------------------------------------------------------- init */

function applyTheme(next) {
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('rt_theme', next); } catch { /* private window */ }
}

function initTheme() {
  document.documentElement.dataset.theme = localStorage.getItem('rt_theme') || '';
}

/* -------------------------------------------------------------- discord */

/* Posting the live pairings and standings into a Discord channel.
 *
 * Two messages are kept and edited in place, so the channel holds one current
 * pairings post and one current standings post rather than a scroll of
 * history. Message ids live in browser settings beside the webhook URL.
 *
 * Nothing here is allowed to break a tournament. Every failure is a toast and
 * a status line; the round still closes, the scores still save, the folder
 * still gets its CSVs.
 */
const discordState = { config: null, busy: false, timer: null, last: '' };

function discordReady() {
  return Boolean(discordState.config && discordState.config.url);
}

/**
 * Why posting is off, or '' when it is on.
 *
 * A reason rather than a boolean, because the commonest way to meet this is
 * to set the webhook up on a test tournament — which is the sensible thing to
 * try first, and used to fail by doing nothing at all.
 */
function discordBlockedReason() {
  const t = state.store.doc;
  if (!t) return 'Open a tournament before posting.';
  if (!discordReady()) return 'Paste the webhook URL and press Save first.';
  return '';
}

/* A test tournament posts like any other: learning the feature on made-up
 * players is exactly what test mode is for. The post is coloured and labelled
 * as a test so it cannot be mistaken for a real draw. */
function discordAllowed() {
  return discordBlockedReason() === '';
}

async function saveDiscordConfig(config) {
  discordState.config = config;
  await persistence.saveDiscord(config);
}

async function postToDiscord(which, { quiet = false } = {}) {
  // Say why rather than doing nothing: a dead button is a bug report.
  const blocked = discordBlockedReason();
  if (blocked) {
    if (!quiet) {
      discordState.last = blocked;
      toast(blocked, 'warn', 9000);
      if (state.view === 'backups') render();
    }
    return;
  }
  const cfg = discordState.config;
  const t = state.store.doc;
  let poster;
  try {
    poster = new DiscordPoster(cfg.url);
  } catch (err) {
    if (!quiet) toast(err.message, 'error', 8000);
    return;
  }

  const jobs = which === 'both' ? ['pairings', 'standings'] : [which];
  for (const job of jobs) {
    try {
      let payload = null;
      if (job === 'pairings') {
        const open = state.store.openRound();
        const round = open ? state.store.getRound(open.id) : null;
        if (!round) continue;
        payload = pairingsMessage(t, round);
      } else {
        // Always the event's own order. It used to post whichever view was
        // last clicked on the Standings tab, so glancing at Qualifying after
        // the cut sent the qualifying table to the channel instead.
        const rows = state.store.standings('overall');
        payload = standingsMessage(t, rows, {
          scope: 'overall',
          precision: state.store.rules.scorePrecision,
        });
      }
      // Test posts keep their own message ids. The ids live with the webhook,
      // not with the tournament, so without this a rehearsal would edit over
      // the live pairings post of a real event running on the same machine.
      const key = isTestEvent() ? `demo_${job}MessageId` : `${job}MessageId`;
      const id = await poster.send(payload, cfg[key] || null);
      if (id && id !== cfg[key]) await saveDiscordConfig({ ...cfg, [key]: id });
      discordState.last = `${job} posted ${when(new Date().toISOString().replace(/\.\d+Z$/, 'Z'))}`;
    } catch (err) {
      discordState.last = `could not post ${job}: ${err.message}`;
      if (!quiet) toast(err.message, 'error', 9000);
    }
  }
  if (state.view === 'backups') render();
}

/* Discord rate limits a webhook, and a round of score entry fires many
 * changes in a few seconds. Collapse them into one post. */
function discordOnChange(kind) {
  if (!discordAllowed()) return;
  const wants = {
    round_generated: 'pairings',
    round_closed: 'both',
    table_saved: 'standings',
    table_amended: 'standings',
    cut_applied: 'both',
    round_reseated: 'pairings',
    seats_swapped: 'pairings',
    seat_substituted: 'pairings',
  }[kind];
  if (!wants) return;
  if (discordState.timer) clearTimeout(discordState.timer);
  discordState.timer = setTimeout(() => {
    discordState.timer = null;
    postToDiscord(wants, { quiet: true });
  }, 4000);
}

/* ------------------------------------------------------------- settings */

const REPO = 'https://github.com/MilkJugg24/Mahjong-Tournament-System';

/* The settings panel. Two tabs: how it looks, and what it is.
 *
 * Theme used to be a button in the header that cycled through three states
 * with only a toast to say which one you had landed on. Here the three are
 * laid out and the current one is marked, so it can be chosen rather than
 * cycled past. */
function openSettings(tab = 'appearance') {
  const theme = document.documentElement.dataset.theme || '';
  const version = (typeof window !== 'undefined' && window.RT_VERSION) || 'dev';
  const on = (a, b) => (a === b ? ' on' : '');

  $('#dialog').innerHTML = `
  <div id="backdrop">
    <div class="sheet settings" role="dialog" aria-modal="true" aria-label="Settings">
      <header>
        <h2>Settings</h2>
        <button class="ghost" id="closeSettings" aria-label="Close">&times;</button>
      </header>
      <nav class="settabs" role="tablist">
        <button role="tab" data-tab="appearance"${on(tab, 'appearance')}>Appearance</button>
        <button role="tab" data-tab="about"${on(tab, 'about')}>About</button>
      </nav>

      <section class="setpane${on(tab, 'appearance')}" data-pane="appearance">
        <p class="small muted">How the program looks on this computer. Remembered
          in this browser; it changes nothing about your tournament.</p>
        <div class="btnrow">
          <button class="themeOpt${on(theme, '')}" data-theme="">Follow the system</button>
          <button class="themeOpt${on(theme, 'light')}" data-theme="light">Light</button>
          <button class="themeOpt${on(theme, 'dark')}" data-theme="dark">Dark</button>
        </div>
      </section>

      <section class="setpane${on(tab, 'about')}" data-pane="about">
        <h3>Mahjong Tournament System</h3>
        <p class="small muted">Version ${esc(version)}</p>
        <p>Offline tournament software for mahjong. Scoring follows WRC 2025 by
          default, with EMA RCR, Saikouisen and MCR available on the rules page.</p>
        <p><a href="${REPO}" target="_blank" rel="noopener noreferrer">${esc(REPO)}</a></p>
        <p class="small muted">The source, the guides and every scoring figure with
          the document it came from are all there. MIT licensed.</p>
        <p class="small muted">Rules and worked examples from the World Riichi
          Championship 2025 rules. Format and paperwork from the American Riichi
          Association's Tournament-in-a-Box guide.</p>
      </section>
    </div>
  </div>`;

  const close = () => { $('#dialog').innerHTML = ''; };
  $('#closeSettings').addEventListener('click', close);
  $('#backdrop').addEventListener('click', (e) => { if (e.target.id === 'backdrop') close(); });
  document.addEventListener('keydown', function onKey(e) {
    if (!$('#backdrop')) { document.removeEventListener('keydown', onKey); return; }
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
  });

  $$('#dialog .settabs button').forEach((b) => b.addEventListener('click', () => {
    openSettings(b.dataset.tab);
  }));

  $$('#dialog .themeOpt').forEach((b) => b.addEventListener('click', () => {
    applyTheme(b.dataset.theme);
    openSettings('appearance');
  }));
}

async function init() {
  initTheme();

  const check = await persistence.check();
  state.storageOk = check.ok;
  state.storageReason = check.reason || '';
  if (check.ok) await persistence.requestPersistence();

  // Reuse the backup folder chosen in a previous session. Only ask whether the
  // grant still holds: asking for it again needs a click, and a request made
  // here is refused -- which used to stop backups without a word. If it has
  // lapsed, the folder waits and every page offers to reconnect it.
  try {
    const handle = await persistence.loadFolderHandle();
    if (handle) {
      const target = new FolderTarget(handle);
      if (await target.hasPermission()) backups.setTarget(target);
      else backups.setAwaiting(target);
    }
  } catch { /* the folder is gone */ }

  try {
    discordState.config = await persistence.loadDiscord();
  } catch { /* no settings store yet */ }

  $$('nav.tabs button').forEach((b) => b.addEventListener('click', () => {
    if (b.disabled) return;
    if (b.dataset.view === 'standings') loadStandings();
    setView(b.dataset.view);
  }));

  initFieldHelp();

  // The round clock, here and on the room display, moves once a second.
  setInterval(tickClocks, 1000);

  $('#helpBtn').addEventListener('click', () => {
    if (state.view === 'help') { setView(hasTournament() ? 'round' : 'home'); return; }
    setView('help');
  });
  $('#tourBtn').addEventListener('click', () => guard(() => startTutorial()));
  $('#settingsBtn').addEventListener('click', () => openSettings());

  $('#switchBtn').addEventListener('click', async () => {
    state.store.doc = null;
    state.round = null;
    await loadTournaments();
    setView('home');
  });

  $$('.scopeBtn').forEach((b) => b.addEventListener('click', () => {
    state.scope = b.dataset.scope;
    loadStandings();
    render();
  }));
  $('#printStandings').addEventListener('click', () => guard(() =>
    openPrintWindow(printPage(state.store, 'standings', { scope: state.scope }),
      state.store.doc.name)));

  $('#createBtn').addEventListener('click', () => guard(async () => {
    const name = $('#newName').value.trim();
    if (!name) return toast('Give the tournament a name.', 'warn');
    // Created on the WRC 2025 defaults, then straight to the rules page where
    // any published ruleset can be filled in and every number changed. One
    // dropdown on this card could only ever offer a shortlist; the rules page
    // offers the lot, and shows what it is about to change.
    const preset = PRESETS.wrc2025;
    state.store.create(name, {
      mode: $('#newMode').value,
      rules: preset.rules,
      config: {
        rulesetLabel: preset.label,
        demo: $('#newTestMode').checked,
        plannedRounds: num($('#newRounds').value) || 6,
        cut: {
          size: num($('#newCut').value),
          rounds: num($('#newFinalRounds').value),
          carry: 'reset',
        },
      },
    });
    $('#newName').value = '';
    await loadTournaments();
    toast('Tournament created. Check the rules, then add your players.', 'ok', 6000);
    setView('setup');
    return null;
  }));

  await loadTournaments();
  setView('home');
}

document.addEventListener('DOMContentLoaded', init);
}());
