/* The built file, driven from file:// the way an organiser opens it.
 *
 * This is the test that matters most: the node tests exercise the engines in
 * isolation, but only this one shows that a double-clicked HTML file actually
 * runs a tournament -- with IndexedDB, with no network, and with the data
 * surviving a reload.
 *
 * Skipped when Playwright is not installed, so the node suite still runs.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { build, OUTPUT_NAME } = require('../build.js');

/* Which browser engine to drive.
 *
 * There are three engines behind the browsers organisers actually use:
 *
 *   chromium  Chrome, Edge, Opera, Brave, and every other Chromium shell
 *   firefox   Firefox
 *   webkit    Safari
 *
 * RT_ENGINE picks one; CI runs the file once per engine. Chromium is the
 * default because it is the only one with the File System Access API, so it
 * is the only engine where the backup folder can be chosen at all.
 *
 * Note what this does NOT cover. Playwright's webkit is the same engine as
 * Safari but not Safari itself, and Opera and Brave have no Playwright
 * channel, so they are covered only at the engine level. Their own settings
 * -- Brave's shields in particular, which can refuse storage -- are not
 * exercised here. See docs/TECHNICAL.md.
 */
const ENGINE = process.env.RT_ENGINE || 'chromium';

let playwright = null;
try {
  playwright = require('playwright');
} catch { /* not installed */ }

const engine = playwright ? playwright[ENGINE] : null;
if (playwright && !engine) {
  throw new Error(`RT_ENGINE="${ENGINE}" is not a Playwright browser type`);
}

/* Reads the folder the organiser picks for backups. Chromium only, so the
 * tests that need it skip elsewhere rather than failing. */
const HAS_FS_ACCESS = ENGINE === 'chromium';

// Named so a failure says which engine it was.
const chromium = engine;

const SKIP = playwright ? false : 'playwright is not installed';

/* Built into a temporary directory rather than over the committed page.
 *
 * Mahjong-Tournament-System.html at the root of the repository is what people
 * download, and web/tests/built-file.test.js checks it is a current build. If
 * this file rebuilt it in place, that check would be meaningless: whichever
 * test ran first would quietly repair what the other was meant to catch. */
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'mts-browser-'));
const PAGE = () => 'file://' + path.join(OUT, OUTPUT_NAME);

const ROSTER = [
  ['Player 01', 'Club A'], ['Player 02', 'Club B'],
  ['Player 03', 'Club C'], ['Player 04', 'Club D'],
  ['Player 05', 'Club A'], ['Player 06', 'Club B'],
  ['Player 07', 'Club C'], ['Player 08', 'Club D'],
];

async function openApp(browser, { track = true } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  const network = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  if (track) {
    page.on('request', (r) => {
      if (/^https?:/i.test(r.url())) network.push(r.url());
    });
  }
  await page.goto(PAGE(), { waitUntil: 'load' });
  await page.waitForSelector('#tournamentList');
  return { context, page, errors, network };
}

async function createTournament(page, name = 'Browser Cup') {
  await page.fill('#newName', name);
  await page.click('#createBtn');
  // A new tournament lands on the rules page, so the organiser can pick a
  // ruleset before anything is entered. Take the defaults and move on.
  await page.waitForSelector('#view-setup.active');
  await page.click('nav.tabs button[data-view="players"]');
  await page.waitForSelector('#view-players.active');
  await page.fill('#bulkText', ROSTER.map(([n, c]) => `${n}, ${c}`).join('\n'));
  await page.click('#bulkBtn');
  await page.waitForFunction(
    () => document.querySelectorAll('#playersBody table.data tbody tr').length === 8,
    { timeout: 10000 });
}

async function drawRound(page) {
  await page.click('nav.tabs button[data-view="round"]');
  await page.waitForSelector('#genBtn');
  await page.click('#genBtn');
  await page.waitForSelector('.tcard', { timeout: 30000 });
}

async function enterTable(page, tableNumber, scores) {
  await page.click(`.tcard[data-table="${tableNumber}"]`);
  await page.waitForSelector('.entry-row input');
  const inputs = await page.$$('.entry-row input');
  for (let i = 0; i < inputs.length; i++) await inputs[i].fill(String(scores[i]));
  await page.waitForTimeout(260);
  await page.fill('#eBy', 'runner');
  await page.click('#eSave');
  await page.waitForSelector('#backdrop', { state: 'detached', timeout: 10000 });
}

test('the built file runs a whole tournament from file://', { skip: SKIP }, async (t) => {
  build({ out: OUT });
  assert.ok(fs.existsSync(path.join(OUT, OUTPUT_NAME)));

  const browser = await chromium.launch();
  const { context, page, errors, network } = await openApp(browser);

  try {
    await t.test('it loads with no network at all', async () => {
      assert.deepEqual(network, [], `the page fetched: ${network.join(', ')}`);
      assert.equal(await page.title(), 'Mahjong Tournament System');
    });

    await t.test('a tournament and roster can be created', async () => {
      await createTournament(page);
      const lede = await page.textContent('#playerLede');
      assert.match(lede, /8 ranked/);
      assert.match(lede, /2 tables/);
      assert.match(lede, /tables fill exactly/);
    });

    await t.test('seating is drawn', async () => {
      await drawRound(page);
      assert.equal((await page.$$('.tcard')).length, 2);
      assert.match(await page.textContent('#roundLede'), /0 of 2 tables reported/);
    });

    await t.test('the checksum catches a table that does not add up', async () => {
      await page.click('.tcard[data-table="1"]');
      await page.waitForSelector('.entry-row input');
      const inputs = await page.$$('.entry-row input');
      for (const [i, v] of [45000, 32000, 25000, 19000].entries()) {
        await inputs[i].fill(String(v));
      }
      await page.waitForTimeout(350);
      const checksum = await page.textContent('#eChecksum');
      assert.match(checksum, /Does not add up/);
      assert.match(checksum, /121,000/);
      const issue = await page.textContent('#ePreview');
      assert.match(issue, /must total 120,000/);
    });

    await t.test('it offers to fill in the last score', async () => {
      const inputs = await page.$$('.entry-row input');
      await inputs[3].fill('');
      await page.waitForTimeout(300);
      const hint = await page.textContent('#eHint');
      assert.match(hint, /Fill .* with 18,000/);
      await page.click('#eFill');
      await page.waitForTimeout(350);
      assert.match(await page.textContent('#eChecksum'), /Totals check out/);
    });

    await t.test('the preview shows placements and hanchan scores', async () => {
      const preview = await page.textContent('#ePreview');
      assert.match(preview, /\+30\.0/); // 45,000 -> +15 delta, +15 uma
      assert.match(preview, /-27\.0/);  // 18,000 -> -12 delta, -15 uma
    });

    await t.test('a table saves', async () => {
      await page.fill('#eBy', 'runner');
      await page.click('#eSave');
      await page.waitForSelector('#backdrop', { state: 'detached', timeout: 10000 });
      assert.match(await page.textContent('#roundLede'), /1 of 2 tables reported/);
    });

    await t.test('the round closes and standings appear', async () => {
      await enterTable(page, 2, [40000, 31000, 26000, 23000]);
      page.on('dialog', (d) => d.accept());
      await page.click('#closeBtn');
      await page.waitForSelector('#genBtn', { timeout: 15000 });

      await page.click('nav.tabs button[data-view="standings"]');
      await page.waitForSelector('#standingsBody table.data tbody tr');
      const rows = await page.$$eval('#standingsBody table.data tbody tr',
        (trs) => trs.map((tr) => Array.from(tr.querySelectorAll('td'))
          .slice(0, 4).map((td) => td.textContent.trim())));
      assert.equal(rows.length, 8);
      assert.equal(rows[0][0], '1');
      assert.equal(rows[0][3], '+30.0');
      // Zero-sum: no riichi sticks were left, so the scores must cancel.
      const total = rows.reduce((a, r) => a + Number(r[3]), 0);
      assert.ok(Math.abs(total) < 1e-9, `standings should sum to 0, got ${total}`);
    });

    await t.test('the cut and a final round work', async () => {
      await page.click('nav.tabs button[data-view="finals"]');
      await page.waitForSelector('#cutBtn');
      await page.fill('#cSize', '4');
      await page.fill('#cRounds', '1');
      await page.click('#cutBtn');
      await page.waitForSelector('#undoCut', { timeout: 10000 });
      const through = await page.$$eval('#finalsBody ol li', (lis) => lis.length);
      assert.equal(through, 4);

      await page.click('nav.tabs button[data-view="round"]');
      await page.waitForSelector('#genBtn');
      await page.selectOption('#rPhase', 'final');
      await page.click('#genBtn');
      await page.waitForSelector('.tcard', { timeout: 30000 });
      assert.equal((await page.$$('.tcard')).length, 1);
    });

    await t.test('print views render', async () => {
      const popup = page.waitForEvent('popup');
      await page.click('[data-print="scoresheets"]');
      const sheet = await popup;
      await sheet.waitForLoadState('domcontentloaded');
      const html = await sheet.content();
      assert.match(html, /Riichi sticks left/);
      assert.match(html, /120,000/);
      assert.match(html, /\+15 \/ \+5 \/ -5 \/ -15/);
      await sheet.close();
    });

    await t.test('the work survives a reload', async () => {
      await page.reload({ waitUntil: 'load' });
      await page.waitForSelector('[data-open]', { timeout: 10000 });
      const cards = await page.$$eval('[data-open]', (els) => els.length);
      assert.equal(cards, 1, 'the tournament should still be listed after a reload');
      await page.click('[data-open]');
      await page.waitForSelector('nav.tabs button[data-view="round"]:not([disabled])');
      await page.click('nav.tabs button[data-view="standings"]');
      await page.waitForSelector('#standingsBody table.data tbody tr');
      const first = await page.$eval('#standingsBody table.data tbody tr td:nth-child(4)',
        (td) => td.textContent.trim());
      assert.equal(first, '+30.0', 'the scores should come back unchanged');
    });

    await t.test('still no network requests, and no script errors', async () => {
      assert.deepEqual(network, [], `the page fetched: ${network.join(', ')}`);
      assert.deepEqual(errors, [], `script errors: ${errors.join(' | ')}`);
    });
  } finally {
    await context.close();
    await browser.close();
  }
});

test('it works at phone width', { skip: SKIP }, async () => {
  build({ out: OUT });
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto(PAGE(), { waitUntil: 'load' });
    await page.waitForSelector('#tournamentList');
    await createTournament(page, 'Phone Cup');
    await drawRound(page);

    const scrolls = await page.evaluate(() =>
      document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    assert.equal(scrolls, false, 'the page scrolls sideways on a phone');

    await page.click('.tcard[data-table="1"]');
    await page.waitForSelector('.entry-row input');
    const box = await page.locator('.entry-row input').first().boundingBox();
    assert.ok(box.height >= 32, `score inputs are too small to tap: ${box.height}px`);
    assert.deepEqual(errors, [], errors.join(' | '));
  } finally {
    await context.close();
    await browser.close();
  }
});

test('a tournament can be restored from a backup file', { skip: SKIP }, async () => {
  build({ out: OUT });
  const browser = await chromium.launch();
  // Event one: build a tournament and take its restore point.
  const first = await openApp(browser, { track: false });
  let json;
  try {
    await createTournament(first.page, 'Restore Cup');
    await drawRound(first.page);
    await enterTable(first.page, 1, [45000, 32000, 25000, 18000]);

    json = await first.page.evaluate(async () => {
      const persistence = new window.RT.persist.Persistence();
      const list = await persistence.listTournaments();
      const doc = await persistence.loadTournament(list[0].id);
      const store = new window.RT.store.TournamentStore();
      store.load(doc);
      return JSON.stringify(window.RT.backup.restorePoint(store));
    });
    assert.match(json, /riichi-tournament-restore/);
    assert.deepEqual(first.errors, [], first.errors.join(' | '));
  } finally {
    await first.context.close();
  }

  // A brand-new context is a brand-new profile: empty IndexedDB, as if this
  // were a different laptop.
  const second = await openApp(browser, { track: false });
  try {
    assert.equal((await second.page.$$('[data-open]')).length, 0,
      'a fresh profile should start with no tournaments');

    await second.page.setInputFiles('#restoreFile', {
      name: 'tournament.json',
      mimeType: 'application/json',
      buffer: Buffer.from(json, 'utf8'),
    });

    await second.page.waitForSelector('nav.tabs button[data-view="standings"]:not([disabled])',
      { timeout: 15000 });
    await second.page.click('nav.tabs button[data-view="standings"]');
    await second.page.waitForSelector('#standingsBody table.data tbody tr');
    const rows = await second.page.$$eval('#standingsBody table.data tbody tr',
      (trs) => trs.map((tr) => Array.from(tr.querySelectorAll('td'))
        .slice(0, 4).map((td) => td.textContent.trim())));
    assert.equal(rows.length, 8, 'the whole roster should come back');
    assert.equal(rows[0][3], '+30.0', 'the scores should come back unchanged');
    assert.deepEqual(second.errors, [], second.errors.join(' | '));
  } finally {
    await second.context.close();
    await browser.close();
  }
});

/* ---------------------------------------------- tutorial, help, bubbles */

test('the tutorial runs a whole demo event in the browser', { skip: SKIP }, async (t) => {
  build({ out: OUT });
  const browser = await chromium.launch();
  const { context, page, errors, network } = await openApp(browser);
  try {
    await page.click('#tourBtn');
    await page.waitForSelector('#tutorialBar.on');

    const total = Number((await page.textContent('.tut-count')).match(/of (\d+)/)[1]);
    assert.ok(total >= 10, `expected a full walkthrough, got ${total} steps`);

    const verdicts = [];
    const views = new Set();
    for (let i = 0; i < total; i += 1) {
      await page.waitForSelector('.tut-title');
      views.add(await page.$eval('section.view.active', (el) => el.id));
      const issue = await page.$('#tutorialPreview .issue');
      if (issue) verdicts.push((await issue.textContent()).replace(/\s+/g, ' ').trim());
      if (i < total - 1) {
        await page.click('#tutNext');
        await page.waitForFunction(
          (n) => document.querySelector('.tut-count')
            && document.querySelector('.tut-count').textContent.includes(`Step ${n + 2}`),
          i, { timeout: 10000 },
        );
      }
    }

    await t.test('it walked across several tabs', () => {
      assert.ok(views.size >= 5, `the tutorial only visited ${views.size} tab(s)`);
    });

    await t.test('it showed the real total check, rejecting then accepting', () => {
      assert.equal(verdicts.length, 2, 'expected two score previews');
      assert.match(verdicts[0], /Does not add up/i);
      assert.match(verdicts[0], /121,000 \/ 120,000/);
      assert.match(verdicts[1], /Totals check out/i);
      assert.match(verdicts[1], /120,000 \/ 120,000/);
    });

    await t.test('the last step offers Finish, not Next', async () => {
      assert.match((await page.textContent('#tutNext')).trim(), /Finish/);
    });

    // Prev must walk back, and the step counter with it.
    await page.click('#tutPrev');
    await page.waitForFunction((n) => document.querySelector('.tut-count')
      .textContent.includes(`Step ${n - 1}`), total, { timeout: 10000 });
    await t.test('Prev steps back', async () => {
      assert.match(await page.textContent('.tut-count'), new RegExp(`Step ${total - 1} of`));
    });

    // Finish, and the demo event is left in the list, named as a tutorial.
    await page.click('#tutNext');
    await page.waitForFunction((n) => document.querySelector('.tut-count')
      .textContent.includes(`Step ${n}`), total, { timeout: 10000 });
    await page.click('#tutNext');
    await page.waitForFunction(
      () => !document.querySelector('#tutorialBar').classList.contains('on'),
      null, { timeout: 10000 },
    );

    // Finishing reloads the event list asynchronously. Wait for an actual
    // entry: the empty state has text of its own ("No tournaments yet"), so
    // waiting for any text at all passes immediately and proves nothing.
    await page.waitForSelector('#view-home.active #tournamentList [data-open]',
      { timeout: 10000 });
    const listed = await page.$eval('#tournamentList', (el) => el.textContent);
    await t.test('the demo event is left behind, clearly named', () => {
      assert.match(listed, /Tutorial/, 'the demo event should be identifiable as one');
      assert.match(listed, /12 players/, 'the demo event should hold the demo roster');
    });

    assert.deepEqual(network, [], `the tutorial fetched: ${network.join(', ')}`);
    assert.deepEqual(errors, [], errors.join(' | '));
  } finally {
    await context.close();
    await browser.close();
  }
});

test('the help page and the "?" bubbles work', { skip: SKIP }, async (t) => {
  build({ out: OUT });
  const browser = await chromium.launch();
  const { context, page, errors, network } = await openApp(browser);
  try {
    await page.click('#helpBtn');
    await page.waitForSelector('#view-help.active .helptopic');

    const topics = await page.$$eval('.helpnav-item', (b) => b.map((x) => x.textContent.trim()));
    await t.test('every topic is listed and opens', async () => {
      assert.ok(topics.length >= 5, `only ${topics.length} help topics`);
      for (let i = 0; i < topics.length; i += 1) {
        await page.click(`.helpnav-item:nth-child(${i + 1})`);
        await page.waitForFunction(
          (title) => {
            const h = document.querySelector('.helptopic h2');
            return h && h.textContent.trim() === title;
          },
          topics[i], { timeout: 5000 },
        );
        const body = await page.textContent('.helptopic');
        assert.ok(body.trim().length > 150, `topic "${topics[i]}" rendered almost nothing`);
      }
    });

    // Back out of help, then try the bubbles.
    await page.click('#helpBtn');
    await page.waitForSelector('#view-home.active');

    const bubbles = await page.$$('.qmark');
    await t.test('every bubble on the page has text behind it', async () => {
      assert.ok(bubbles.length >= 3, `only ${bubbles.length} "?" bubbles found`);
      for (const bubble of bubbles) {
        const key = await bubble.getAttribute('data-help');
        await bubble.click();
        await page.waitForSelector('#helpPop.on', { timeout: 5000 });
        const text = (await page.textContent('#helpPop p')).trim();
        assert.ok(text.length > 30, `the bubble for "${key}" showed nothing useful`);
        await page.keyboard.press('Escape');
        await page.waitForFunction(
          () => !document.querySelector('#helpPop').classList.contains('on'),
          null, { timeout: 5000 },
        );
      }
    });

    await t.test('a bubble closes on an outside click too', async () => {
      await bubbles[0].click();
      await page.waitForSelector('#helpPop.on', { timeout: 5000 });
      await page.click('h1');
      await page.waitForFunction(
        () => !document.querySelector('#helpPop').classList.contains('on'),
        null, { timeout: 5000 },
      );
    });

    assert.deepEqual(network, [], `help fetched: ${network.join(', ')}`);
    assert.deepEqual(errors, [], errors.join(' | '));
  } finally {
    await context.close();
    await browser.close();
  }
});

/* ------------------------------------------------ rulesets in the browser */

test('a ruleset is chosen on the rules page, not when creating', { skip: SKIP }, async (t) => {
  build({ out: OUT });
  const browser = await chromium.launch();
  const { context, page, errors, network } = await openApp(browser);
  try {
    await t.test('the creation card no longer picks a ruleset', async () => {
      assert.equal(await page.$('#newPreset'), null,
        'the ruleset dropdown should have moved to the rules page');
    });

    await page.fill('#newName', 'Ruleset Flow');
    await page.click('#createBtn');
    await page.waitForSelector('#view-setup.active');

    await t.test('creating lands on the full rules page', async () => {
      assert.equal(await page.$eval('section.view.active', (el) => el.id), 'view-setup');
    });

    const offered = await page.$$eval('#sPreset option',
      (o) => o.map((x) => x.value).filter(Boolean));
    await t.test('every published ruleset is offered', () => {
      for (const id of ['wrc2025', 'ema_rcr', 'saikouisen', 'mcr']) {
        assert.ok(offered.includes(id), `${id} is not offered as a starting point`);
      }
    });

    await t.test('choosing one names the document it comes from', async () => {
      await page.selectOption('#sPreset', 'saikouisen');
      await page.waitForFunction(() => document.querySelector('#presetNote').textContent.trim());
      const note = await page.textContent('#presetNote');
      assert.match(note, /Saikouisen/);
      assert.match(note, /1\.12/, 'the note should cite the rulebook version');
    });

    await t.test('filling it in does not save until asked', async () => {
      await page.click('#applyPreset');
      await page.waitForFunction(() => document.querySelector('#sUma0').value === '30');
      assert.equal(await page.$eval('#sChombo', (e) => e.value), '20');
      // Leaving without saving must drop it.
      await page.click('nav.tabs button[data-view="players"]');
      await page.waitForSelector('#view-players.active');
      await page.click('nav.tabs button[data-view="setup"]');
      await page.waitForSelector('#view-setup.active');
      assert.equal(await page.$eval('#sUma0', (e) => e.value), '15',
        'an unsaved fill-in should not survive leaving the page');
    });

    assert.deepEqual(network, [], network.join(', '));
    assert.deepEqual(errors, [], errors.join(' | '));
  } finally {
    await context.close();
    await browser.close();
  }
});

test('an MCR event runs on table points', { skip: SKIP }, async (t) => {
  build({ out: OUT });
  const browser = await chromium.launch();
  const { context, page, errors, network } = await openApp(browser);
  try {
    await page.fill('#newName', 'MCR Open');
    await page.click('#createBtn');
    await page.waitForSelector('#view-setup.active');
    await page.selectOption('#sPreset', 'mcr');
    await page.click('#applyPreset');
    await page.waitForFunction(() => document.querySelector('#sModel').value === 'table_points');

    await t.test('the form swaps uma for table points', async () => {
      assert.ok(await page.$('#sTp0'), 'table point fields should appear');
      assert.equal(await page.$('#sUma0'), null, 'uma fields should not');
      assert.equal(await page.$eval('#sStart', (e) => e.value), '0');
      assert.equal(await page.$eval('#sDivisor', (e) => e.value), '1');
    });

    await page.click('#saveSetup');
    await page.waitForFunction(() => !document.querySelector('#toasts').textContent.includes('error'));
    await page.waitForTimeout(300);

    await page.click('nav.tabs button[data-view="players"]');
    await page.waitForSelector('#bulkText');
    await page.fill('#bulkText', 'Player 01, Club A\nBravo, Club B\nCharlie, Club C\nDelta, Club D');
    await page.click('#bulkBtn');
    await page.waitForFunction(
      () => document.querySelectorAll('#playersBody table.data tbody tr').length === 4,
      null, { timeout: 10000 },
    );

    await page.click('nav.tabs button[data-view="round"]');
    await page.waitForSelector('#genBtn');
    await page.click('#genBtn');
    await page.waitForSelector('.tcard', { timeout: 20000 });
    await page.click('.tcard[data-table="1"]');
    await page.waitForSelector('.entry-row input');

    await t.test('score entry moves in ones, not hundreds', async () => {
      const step = await page.$eval('.entry-row input', (e) => e.getAttribute('step'));
      assert.equal(step, '1', 'MCR points do not come in hundreds');
    });

    // A real session: zero-sum, including negatives.
    const inputs = await page.$$('.entry-row input');
    for (const [i, v] of [120, 40, -30, -130].entries()) await inputs[i].fill(String(v));
    await page.waitForTimeout(400);

    await t.test('a zero-sum session is accepted', async () => {
      const checksum = (await page.textContent('#eChecksum')).replace(/\s+/g, ' ').trim();
      assert.match(checksum, /Totals check out/i, `got: ${checksum}`);
    });

    await t.test('the preview shows whole table points, not decimals', async () => {
      const preview = (await page.textContent('#ePreview')).replace(/\s+/g, ' ').trim();
      assert.match(preview, /\+4\b/, `expected 4 table points for first: ${preview}`);
      assert.ok(!/\+4\.0/.test(preview),
        `MCR keeps no decimals, but the preview shows them: ${preview}`);
    });

    await page.click('#eSave');
    await page.waitForSelector('#backdrop', { state: 'detached', timeout: 10000 });
    page.on('dialog', (d) => d.accept());
    await page.click('#closeBtn');
    await page.waitForSelector('#genBtn', { timeout: 15000 });

    await page.click('nav.tabs button[data-view="standings"]');
    await page.waitForSelector('#standingsBody table.data tbody tr');
    const rows = await page.$$eval('#standingsBody table.data tbody tr',
      (trs) => trs.map((tr) => Array.from(tr.querySelectorAll('td'))
        .slice(0, 4).map((td) => td.textContent.trim())));

    await t.test('the standings rank on table points', () => {
      assert.equal(rows.length, 4);
      const points = rows.map((r) => r[3]);
      assert.deepEqual(points, ['+4', '+2', '+1', '0'],
        `expected 4/2/1/0 by rank, got ${points.join(', ')}`);
    });

    assert.deepEqual(network, [], network.join(', '));
    assert.deepEqual(errors, [], errors.join(' | '));
  } finally {
    await context.close();
    await browser.close();
  }
});

/* ------------------------------------------------------ settings panel */

test('the settings panel opens, switches tabs and sets the theme', { skip: SKIP }, async (t) => {
  build({ out: OUT });
  const browser = await chromium.launch();
  const { context, page, errors, network } = await openApp(browser);
  try {
    await t.test('the program is branded consistently', async () => {
      assert.equal(await page.title(), 'Mahjong Tournament System');
      assert.match(await page.textContent('.brand'), /Mahjong Tournament System/);
    });

    await page.click('#settingsBtn');
    await page.waitForSelector('#backdrop .settings');

    await t.test('it has an Appearance tab and an About tab', async () => {
      const tabs = await page.$$eval('.settabs button', (b) => b.map((x) => x.textContent.trim()));
      assert.deepEqual(tabs, ['Appearance', 'About']);
    });

    await t.test('the current theme is marked, not just cycled past', async () => {
      const opts = await page.$$eval('.themeOpt',
        (b) => b.map((x) => ({ label: x.textContent.trim(), on: x.classList.contains('on') })));
      assert.equal(opts.length, 3, 'expected system, light and dark');
      assert.equal(opts.filter((o) => o.on).length, 1, 'exactly one should be marked current');
    });

    await t.test('choosing a theme applies and remembers it', async () => {
      await page.click('.themeOpt[data-theme="dark"]');
      await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark',
        null, { timeout: 5000 });
      assert.equal(await page.evaluate(() => localStorage.getItem('rt_theme')), 'dark');
    });

    await page.click('.settabs button[data-tab="about"]');
    await page.waitForSelector('.setpane[data-pane="about"].on');

    await t.test('About names the version and links to the repository', async () => {
      const href = await page.$eval('.setpane[data-pane="about"] a', (a) => a.href);
      assert.match(href, /github\.com\/MilkJugg24\/Mahjong-Tournament-System/);
      const pane = await page.textContent('.setpane[data-pane="about"]');
      // The build injects the real version; unbuilt it would read "dev", which
      // would mean About is reporting a version nobody can have downloaded.
      assert.match(pane, /Version \d+\.\d+\.\d+/, `About shows: ${pane.slice(0, 80)}`);
    });

    await t.test('the repository link opens safely in a new tab', async () => {
      const rel = await page.$eval('.setpane[data-pane="about"] a', (a) => a.rel);
      assert.match(rel, /noopener/, 'an external link needs rel=noopener');
    });

    await t.test('Escape closes it', async () => {
      await page.keyboard.press('Escape');
      await page.waitForSelector('#backdrop', { state: 'detached', timeout: 5000 });
    });

    assert.deepEqual(network, [], network.join(', '));
    assert.deepEqual(errors, [], errors.join(' | '));
  } finally {
    await context.close();
    await browser.close();
  }
});

/* ------------------------------------------------------------- discord */

test('Discord posting is set up, used, and rehearsable on a test event',
  { skip: SKIP }, async (t) => {
    build({ out: OUT });
    const browser = await chromium.launch();
    const { context, page, errors } = await openApp(browser, { track: false });
    const posts = [];
    try {
      // Nothing real is contacted: the webhook route is intercepted.
      await page.route('**/api/webhooks/**', (r) => {
        const id = `m${posts.length + 1}`;
        posts.push({
          method: r.request().method(),
          url: r.request().url(),
          body: r.request().postData() || '',
          id,
        });
        r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ id }),
        });
      });

      await page.fill('#newName', 'Discord Event');
      await page.click('#createBtn');
      await page.waitForSelector('#view-setup.active');
      await page.click('nav.tabs button[data-view="backups"]');
      await page.waitForSelector('#dcUrl');

      await t.test('a URL that is not a webhook is refused before any request', async () => {
        await page.fill('#dcUrl', 'https://example.com/not-a-webhook');
        await page.click('#dcSave');
        await page.waitForFunction(
          () => /does not look like a Discord webhook/i.test(
            document.querySelector('#toasts').textContent),
          null, { timeout: 5000 },
        );
        assert.equal(posts.length, 0, 'a bad URL must not reach the network');
      });

      await page.fill('#dcUrl', 'https://discord.com/api/webhooks/123456789012345678/tok_en-ABC');
      await page.click('#dcSave');
      await page.waitForFunction(
        () => !document.querySelector('#dcPost').disabled, null, { timeout: 5000 });

      await t.test('posting sends one message and asks for its id back', async () => {
        await page.click('#dcPost');
        await page.waitForFunction(() => /posted/i.test(
          document.querySelector('#backupsBody').textContent), null, { timeout: 8000 });
        assert.ok(posts.length >= 1, 'nothing was posted');
        assert.equal(posts[0].method, 'POST');
      });

      const before = posts.length;

      /* Test mode used to be barred from posting, which made the one feature
       * an organiser most wants to rehearse the one they could not. It posts
       * now; what has to hold is that it is marked, and that it does not edit
       * over the real event's live posts. */
      await t.test('the tutorial demo posts, marked as a test', async () => {
        await page.click('#tourBtn');
        await page.waitForSelector('#tutorialBar.on');
        const total = Number((await page.textContent('.tut-count')).match(/of (\d+)/)[1]);
        for (let i = 0; i < total - 1; i += 1) {
          await page.click('#tutNext');
          await page.waitForTimeout(80);
        }
        // Longer than the change debounce, so the post has fired by now.
        await page.waitForTimeout(5000);
        const sent = posts.slice(before);
        assert.ok(sent.length >= 1, 'the demo event posted nothing');
        for (const req of sent) {
          assert.match(req.body, /Test tournament/,
            'a demo post reached the channel unmarked');
        }
      });

      await t.test('a rehearsal does not edit the real event\'s posts', () => {
        const realIds = posts.slice(0, before).map((r) => r.id);
        const edited = posts.slice(before)
          .map((r) => (r.url.match(/\/messages\/(\w+)/) || [])[1])
          .filter(Boolean);
        for (const id of edited) {
          assert.ok(!realIds.includes(id),
            `the demo edited message ${id}, which belongs to the real event`);
        }
      });

      assert.deepEqual(errors, [], errors.join(' | '));
    } finally {
      await context.close();
      await browser.close();
    }
  });

/* Test mode, from the organiser's side.
 *
 * Two things have to hold. The generators must save a usable field without
 * anyone typing a name, and the banner must be impossible to miss on every
 * page -- a tournament run by accident in test mode, and discovered on the
 * morning, is the failure this feature could cause.
 */
test('test mode generates a field and says so on every page', { skip: SKIP }, async (t) => {
  build({ out: OUT });
  const browser = await chromium.launch();
  const { context, page, errors } = await openApp(browser);

  try {
    await t.test('the toggle marks the tournament', async () => {
      await page.fill('#newName', 'Test Mode Cup');
      await page.check('#newTestMode');
      await page.click('#createBtn');
      await page.waitForSelector('#view-setup.active');
      await page.waitForSelector('#testBanner.on');
      const text = await page.textContent('#testBanner');
      assert.match(text, /test/i, `the banner does not say what it is: "${text}"`);
    });

    await t.test('the banner is on every page, not just the first', async () => {
      for (const view of ['players', 'round', 'standings', 'setup']) {
        await page.click(`nav.tabs button[data-view="${view}"]`);
        await page.waitForSelector(`#view-${view}.active`);
        const on = await page.isVisible('#testBanner.on');
        assert.ok(on, `no banner on the ${view} page`);
      }
    });

    await t.test('a roster can be generated instead of typed', async () => {
      await page.click('nav.tabs button[data-view="players"]');
      await page.waitForSelector('#view-players.active');
      await page.fill('#tdCount', '12');
      await page.fill('#tdClubs', '3');
      await page.fill('#tdSubs', '2');
      await page.click('#tdFill');
      // Generate fills the paste box rather than the roster, so the organiser
      // can see and edit what is about to be added. Then the usual button.
      await page.waitForFunction(
        () => document.querySelector('#bulkText').value.split('\n').length === 14,
        { timeout: 10000 });
      await page.click('#bulkBtn');
      await page.waitForFunction(
        () => document.querySelectorAll('#playersBody table.data tbody tr').length === 14,
        { timeout: 10000 });

      const names = await page.$$eval('#playersBody table.data tbody tr [data-f="name"]',
        (els) => els.map((e) => e.value.trim()));
      const clubs = await page.$$eval('#playersBody table.data tbody tr [data-f="club"]',
        (els) => els.map((e) => e.value.trim()));
      assert.equal(names.length, 14);
      for (const n of names) {
        assert.match(n, /^(Player|Sub)\d+$/, `"${n}" could be read as a real person`);
      }
      assert.deepEqual([...new Set(clubs)].sort(), ['Club1', 'Club2', 'Club3']);
    });

    await t.test('generated subs come in as sit-ins, not as ranked players', async () => {
      // parsePlayerCsv has no column for a role, so this is ui.js deciding it
      // from the name. It was wrong once: every Sub arrived ranked.
      const roles = await page.$$eval('#playersBody table.data tbody tr', (rows) => rows.map(
        (r) => [r.querySelector('[data-f="name"]').value.trim(),
          r.querySelector('[data-f="role"]').value]));
      const subs = roles.filter(([n]) => /^Sub/.test(n));
      assert.equal(subs.length, 2);
      for (const [n, role] of subs) assert.equal(role, 'sit_in', `${n} is ${role}`);
      for (const [n, role] of roles.filter(([x]) => /^Player/.test(x))) {
        assert.equal(role, 'player', `${n} is ${role}`);
      }
    });

    await t.test('scores can be filled in, and the standings come out right', async () => {
      await drawRound(page);
      await page.click('#tdScores');
      await page.waitForFunction(
        () => document.querySelectorAll('.tcard').length > 0
          && document.querySelectorAll('.tcard.pending').length === 0,
        { timeout: 20000 });

      await page.click('#closeBtn');
      await page.click('nav.tabs button[data-view="standings"]');
      await page.waitForSelector('#view-standings.active');
      await page.waitForFunction(
        () => document.querySelectorAll('#standingsBody table.data tbody tr').length === 12,
        { timeout: 10000 });
    });

    await t.test('the flag is stored, not just held in memory', async () => {
      // A reload lands on the events list -- there is no session restore -- so
      // what matters is that reopening the event brings the banner back.
      await page.reload({ waitUntil: 'load' });
      await page.waitForSelector('#tournamentList [data-open]');
      assert.equal(await page.isVisible('#testBanner.on'), false,
        'the banner showed with no event open');
      await page.click('#tournamentList [data-open]');
      await page.waitForSelector('#testBanner.on');
    });

    await t.test('a normal tournament has no banner', async () => {
      await page.click('nav.tabs button[data-view="home"]');
      await page.waitForSelector('#view-home.active');
      await page.fill('#newName', 'Real Cup');
      await page.click('#createBtn');
      await page.waitForSelector('#view-setup.active');
      await page.waitForFunction(
        () => !document.querySelector('#testBanner').classList.contains('on'),
        { timeout: 5000 });
      assert.equal(await page.isVisible('#tdScores'), false,
        'the score filler is offered outside test mode');
    });

    assert.deepEqual(errors, [], errors.join(' | '));
  } finally {
    await context.close();
    await browser.close();
  }
});

/* The tutorial callout: where it sits, and the page under it.
 *
 * The callout floats beside the control each step is about. Three things have
 * to hold, and all three were faults in the bottom-sheet design it replaced:
 * it must not cover its own target, it must stay on the target when the page
 * moves, and the page must not move or change except when the tutorial says
 * so.
 *
 * Measured at 1536x864, which is a 1920x1080 screen at 125% scaling -- the
 * case that showed up the old design.
 */
test('the tutorial callout keeps out of its own way', { skip: SKIP }, async (t) => {
  build({ out: OUT });
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1536, height: 864 },
    deviceScaleFactor: 1.25,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

  try {
    await page.goto(PAGE(), { waitUntil: 'load' });
    await page.waitForSelector('#tournamentList');
    await page.click('#tourBtn');
    await page.waitForSelector('#tutorialBar.on');

    await t.test('the page is handed over to the tutorial', async () => {
      const state = await page.evaluate(() => ({
        locked: document.documentElement.classList.contains('rt-locked'),
        main: document.querySelector('main').hasAttribute('inert'),
        tabs: document.querySelector('nav.tabs').hasAttribute('inert'),
        header: document.querySelector('header.top').hasAttribute('inert'),
      }));
      assert.deepEqual(state, {
        locked: true, main: true, tabs: true, header: true,
      });
    });

    await t.test('the reader cannot scroll the page out from under the highlight', async () => {
      // This is the reported bug: scrolling slid the page away while the
      // callout stayed put, so the text described something off screen.
      await page.mouse.move(700, 500);
      await page.mouse.wheel(0, 700);
      await page.waitForTimeout(250);
      assert.equal(await page.evaluate(() => window.scrollY), 0,
        'a wheel scroll moved the page');
    });

    await t.test('nothing but the callout answers a click', async () => {
      const before = await page.evaluate(
        () => document.querySelector('.view.active').id);
      await page.click('nav.tabs button[data-view="backups"]', { force: true, timeout: 2000 })
        .catch(() => { /* blocked is the point */ });
      assert.equal(await page.evaluate(() => document.querySelector('.view.active').id),
        before, 'a locked tab changed the view');
    });

    await t.test('every step clears its target, or corners itself out of the way', async () => {
      const total = Number((await page.textContent('.tut-count')).match(/of (\d+)/)[1]);
      const covered = [];
      const offscreen = [];
      let tallest = 0;

      for (let i = 0; i < total; i += 1) {
        await page.waitForTimeout(620); // the smooth scroll, then the re-place
        const m = await page.evaluate(() => {
          const bar = document.querySelector('#tutorialBar');
          const spot = document.querySelector('.rt-spot');
          const r = (el) => {
            const b = el.getBoundingClientRect();
            return {
              left: b.left, top: b.top, right: b.right, bottom: b.bottom, h: b.height,
            };
          };
          return {
            step: document.querySelector('.tut-count').textContent.trim(),
            side: bar.dataset.side,
            bar: r(bar),
            spot: spot ? r(spot) : null,
          };
        });

        tallest = Math.max(tallest, m.bar.h);
        const b = m.bar;
        if (b.left < 0 || b.top < 0 || b.right > 1536 || b.bottom > 864) {
          offscreen.push(m.step);
        }
        // A step that points at something has to leave it visible. The two
        // placements that knowingly overlap are 'inside' -- a target bigger
        // than the space around it -- and 'center', which has no target.
        if (m.spot && m.side !== 'inside' && m.side !== 'center') {
          const hit = !(b.right <= m.spot.left || b.left >= m.spot.right
            || b.bottom <= m.spot.top || b.top >= m.spot.bottom);
          if (hit) covered.push(`${m.step} (side=${m.side})`);
        }
        if (i < total - 1) await page.click('#tutNext');
      }

      assert.deepEqual(covered, [], `the callout covered: ${covered.join(', ')}`);
      assert.deepEqual(offscreen, [], `the callout left the window: ${offscreen.join(', ')}`);
      // The whole point of the rewrite. The sheet was 50vh plus 54vh of page
      // padding; anything near half the window is a regression to that.
      assert.ok(tallest <= 864 * 0.42,
        `the callout grew to ${Math.round(tallest)}px of 864 -- it must stay small`);
    });

    await t.test('finishing gives the page back', async () => {
      await page.click('#tutNext');
      await page.waitForTimeout(300);
      const after = await page.evaluate(() => ({
        on: document.querySelector('#tutorialBar').classList.contains('on'),
        locked: document.documentElement.classList.contains('rt-locked'),
        inert: document.querySelectorAll('[inert]').length,
        spots: document.querySelectorAll('.rt-spot').length,
        anim: document.querySelectorAll('.rt-press, .rt-fill').length,
      }));
      assert.deepEqual(after, {
        on: false, locked: false, inert: 0, spots: 0, anim: 0,
      });
      await page.mouse.wheel(0, 300);
      await page.waitForTimeout(200);
      assert.ok(await page.evaluate(() => window.scrollY) >= 0);
    });

    assert.deepEqual(errors, [], errors.join(' | '));
  } finally {
    await context.close();
    await browser.close();
  }
});

/* The step demonstrations.
 *
 * Each one is decoration over data the step has already written through the
 * store, so the test that matters is the reduced-motion one: a reader who has
 * asked for no animation must still see the finished state.
 */
test('a step shows its work: typing, filling and pressing', { skip: SKIP }, async (t) => {
  build({ out: OUT });
  const browser = await chromium.launch();

  const open = async (reduce) => {
    const context = await browser.newContext({
      viewport: { width: 1536, height: 864 },
      reducedMotion: reduce ? 'reduce' : 'no-preference',
    });
    const page = await context.newPage();
    await page.goto(PAGE(), { waitUntil: 'load' });
    await page.waitForSelector('#tournamentList');
    await page.click('#tourBtn');
    await page.waitForSelector('#tutorialBar.on');
    await page.click('#tutNext');
    await page.click('#tutNext'); // the roster step
    return { context, page };
  };

  try {
    await t.test('the roster is typed into the real box', async () => {
      const { context, page } = await open(false);
      try {
        await page.waitForTimeout(90);
        const early = (await page.inputValue('#bulkText')).length;
        await page.waitForTimeout(2200);
        const late = await page.inputValue('#bulkText');
        assert.ok(early > 0 && early < late.length,
          `it should still be typing at 90ms: ${early} of ${late.length}`);
        assert.match(late, /Player 01, Club A/);
        assert.match(late, /Player 12/, 'the whole roster should arrive');
      } finally { await context.close(); }
    });

    await t.test('the seating cards arrive one after another', async () => {
      const { context, page } = await open(false);
      try {
        await page.click('#tutNext'); // the draw
        await page.waitForTimeout(60);
        const fill = await page.evaluate(() => Array.from(
          document.querySelectorAll('.rt-fill'), (r) => r.style.getPropertyValue('--d')));
        assert.ok(fill.length >= 3, `expected a card per table, got ${fill.length}`);
        assert.deepEqual(fill.slice(0, 3), ['0s', '0.045s', '0.09s'],
          'they should be staggered, not all at once');
      } finally { await context.close(); }
    });

    await t.test('a button the step is about is shown being pressed', async () => {
      const { context, page } = await open(false);
      try {
        for (let i = 0; i < 5; i += 1) {
          await page.click('#tutNext');
          await page.waitForTimeout(120);
        }
        assert.ok(await page.evaluate(
          () => document.querySelector('#genBtn').classList.contains('rt-press')),
        'the close step should press the draw button');
      } finally { await context.close(); }
    });

    await t.test('asking for no animation still shows the finished state', async () => {
      const { context, page } = await open(true);
      try {
        await page.waitForTimeout(250);
        const text = await page.inputValue('#bulkText');
        assert.match(text, /Player 12/, 'the roster must be there, just not typed');
        assert.equal(await page.evaluate(
          () => document.querySelectorAll('.rt-fill, .rt-press').length), 0,
        'nothing should be animating');
      } finally { await context.close(); }
    });
  } finally {
    await browser.close();
  }
});
