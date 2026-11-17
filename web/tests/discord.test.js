/* Posting to Discord.
 *
 * The formatting is pure, so all of it is checked here without a network. The
 * limits matter more than they look: Discord rejects an over-long message
 * whole, so a field one character too long loses the entire post rather than
 * truncating it.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  LIMITS, parseWebhook, pairingsMessage, standingsMessage, DiscordPoster,
} = require('../src/discord.js');

const GOOD = 'https://discord.com/api/webhooks/123456789012345678/abcDEF-123_token';

/* ------------------------------------------------------------- the URL */

test('a real webhook URL is accepted and split', () => {
  const w = parseWebhook(GOOD);
  assert.equal(w.id, '123456789012345678');
  assert.equal(w.token, 'abcDEF-123_token');
  assert.equal(w.url, GOOD);
});

test('the shapes Discord actually hands out are accepted', () => {
  for (const url of [
    GOOD,
    `${GOOD}/`,
    GOOD.replace('discord.com', 'discordapp.com'),
    GOOD.replace('/api/', '/api/v10/'),
    GOOD.replace('https://discord', 'https://canary.discord'),
  ]) {
    assert.doesNotThrow(() => parseWebhook(url), `rejected ${url}`);
  }
});

test('anything that is not a webhook URL is refused, with advice', () => {
  for (const bad of [
    '', '   ', 'not a url',
    'https://discord.com/channels/123/456',
    'http://discord.com/api/webhooks/123/abc',        // not https
    'https://evil.example.com/api/webhooks/123/abc',  // not discord
    'https://discord.com/api/webhooks/123',           // no token
  ]) {
    assert.throws(() => parseWebhook(bad), /webhook|Paste/i, `accepted ${JSON.stringify(bad)}`);
  }
});

/* --------------------------------------------------------- the payloads */

const tournament = { name: 'Test Open' };

function round(tables = 3, seatsPerTable = 4) {
  return {
    number: 1,
    label: 'Hanchan 1',
    byes: [],
    tables: Array.from({ length: tables }, (_, t) => ({
      tableNumber: t + 1,
      lobby: '',
      seats: Array.from({ length: seatsPerTable }, (_, i) => ({
        seatIndex: i,
        seatWind: ['E', 'S', 'W', 'N'][i],
        playerId: t * 4 + i + 1,
        name: `Player ${String(t * 4 + i + 1).padStart(2, '0')}`,
        club: 'Club A',
      })),
    })),
  };
}

test('pairings list every table and seat wind', () => {
  const msg = pairingsMessage(tournament, round(3));
  const embed = msg.embeds[0];
  assert.match(embed.title, /Test Open/);
  assert.match(embed.title, /Hanchan 1/);
  assert.equal(embed.fields.length, 3);
  assert.match(embed.fields[0].name, /Table 1/);
  for (const wind of ['E', 'S', 'W', 'N']) {
    assert.match(embed.fields[0].value, new RegExp(`\`${wind}\``));
  }
});

test('players sitting out are named, not quietly left off', () => {
  const r = round(2);
  r.byes = [{ playerId: 99, name: 'Player 99' }];
  const embed = pairingsMessage(tournament, r).embeds[0];
  const byes = embed.fields.find((f) => /sitting out/i.test(f.name));
  assert.ok(byes, 'no sitting-out field');
  assert.match(byes.value, /Player 99/);
});

test('a field never exceeds what Discord accepts', () => {
  // 30 tables is past the 25-field ceiling, and long names past 1024 chars.
  const r = round(30);
  for (const t of r.tables) {
    for (const s of t.seats) s.name = 'X'.repeat(300);
  }
  const embed = pairingsMessage(tournament, r).embeds[0];
  assert.ok(embed.fields.length <= LIMITS.fields,
    `${embed.fields.length} fields, limit ${LIMITS.fields}`);
  for (const f of embed.fields) {
    assert.ok(f.name.length <= LIMITS.fieldName, 'field name too long');
    assert.ok(f.value.length <= LIMITS.fieldValue, 'field value too long');
  }
});

test('tables that do not fit are counted, not silently dropped', () => {
  const embed = pairingsMessage(tournament, round(30)).embeds[0];
  const more = embed.fields.find((f) => /more tables/i.test(f.name));
  assert.ok(more, 'nothing said about the tables left off');
  assert.match(more.value, /\d+ further table/);
});

/* -------------------------------------------------------- the standings */

const standings = (n) => Array.from({ length: n }, (_, i) => ({
  playerId: i + 1,
  rank: i + 1,
  name: `Player ${String(i + 1).padStart(2, '0')}`,
  tournamentScore: (100 - i * 3.5).toFixed(1),
  needsCoinToss: false,
}));

test('standings come out as an aligned code block', () => {
  const embed = standingsMessage(tournament, standings(8)).embeds[0];
  assert.match(embed.title, /Overall standings/);
  assert.match(embed.description, /^```/);
  assert.match(embed.description, /```$/m);
  assert.match(embed.description, /Player 01/);
  assert.match(embed.footer.text, /8 player/);
});

test('a big field is trimmed to fit and says how many are missing', () => {
  const embed = standingsMessage(tournament, standings(400)).embeds[0];
  assert.ok(embed.description.length <= LIMITS.embedDescription,
    `description is ${embed.description.length}, limit ${LIMITS.embedDescription}`);
  assert.match(embed.description, /\d+ more not shown/);
});

test('a tie needing a coin toss is marked and explained', () => {
  const rows = standings(4);
  rows[1].needsCoinToss = true;
  const embed = standingsMessage(tournament, rows).embeds[0];
  assert.match(embed.description, /=/);
  assert.match(embed.footer.text, /tie to settle/);
});

test('the scope is named, so finals are not mistaken for overall', () => {
  for (const [scope, word] of [['qualifying', /Qualifying/], ['final', /Finals/]]) {
    const embed = standingsMessage(tournament, standings(3), { scope }).embeds[0];
    assert.match(embed.title, word);
  }
});

test('an empty standings table says so rather than posting an empty block', () => {
  const embed = standingsMessage(tournament, []).embeds[0];
  assert.match(embed.description, /No results yet/i);
});

test('MCR precision is honoured, so table points are not shown as 4.0', () => {
  const rows = [{ playerId: 1, rank: 1, name: 'Player 01', tournamentScore: '4', needsCoinToss: false }];
  const embed = standingsMessage(tournament, rows, { precision: 0 }).embeds[0];
  assert.match(embed.description, /\s4\b/);
  assert.ok(!/4\.0/.test(embed.description), embed.description);
});

/* ------------------------------------------------------------ the wire */

function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, method: opts.method, body: JSON.parse(opts.body) });
    const r = responses.shift() || { ok: true, status: 200, body: { id: '1' } };
    return {
      ok: r.ok ?? (r.status < 400),
      status: r.status ?? 200,
      clone() { return this; },
      async json() { return r.body ?? {}; },
    };
  };
  fn.calls = calls;
  return fn;
}

test('the first post creates a message and returns its id', async () => {
  const f = fakeFetch([{ status: 200, body: { id: '987' } }]);
  const poster = new DiscordPoster(GOOD, { fetchImpl: f });
  const id = await poster.send({ content: 'hi' });
  assert.equal(id, '987');
  assert.equal(f.calls[0].method, 'POST');
  assert.match(f.calls[0].url, /\?wait=true$/, 'POST must ask for the message back');
});

test('a later post edits that message instead of adding another', async () => {
  const f = fakeFetch([{ status: 200, body: { id: '987' } }]);
  const poster = new DiscordPoster(GOOD, { fetchImpl: f });
  const id = await poster.send({ content: 'update' }, '987');
  assert.equal(f.calls[0].method, 'PATCH');
  assert.match(f.calls[0].url, /\/messages\/987$/);
  assert.equal(id, '987');
});

test('a message deleted in Discord is replaced, not reported as broken', async () => {
  const f = fakeFetch([
    { status: 404, ok: false, body: { message: 'Unknown Message' } },
    { status: 200, body: { id: 'new1' } },
  ]);
  const poster = new DiscordPoster(GOOD, { fetchImpl: f });
  const id = await poster.send({ content: 'x' }, 'gone');
  assert.equal(f.calls[0].method, 'PATCH');
  assert.equal(f.calls[1].method, 'POST', 'should fall back to posting afresh');
  assert.equal(id, 'new1');
});

test('rate limiting says how long to wait', async () => {
  const f = fakeFetch([{ status: 429, ok: false, body: { retry_after: 3.2 } }]);
  const poster = new DiscordPoster(GOOD, { fetchImpl: f });
  await assert.rejects(() => poster.send({ content: 'x' }), /rate limiting.*4s/);
});

test("Discord's own complaint is passed through", async () => {
  const f = fakeFetch([{ status: 400, ok: false, body: { message: 'Invalid Form Body' } }]);
  const poster = new DiscordPoster(GOOD, { fetchImpl: f });
  await assert.rejects(() => poster.send({ content: 'x' }), /Invalid Form Body/);
});

test('a bad URL is refused before any request is made', () => {
  assert.throws(() => new DiscordPoster('https://example.com/hook', { fetchImpl: fakeFetch([]) }),
    /webhook/i);
});
