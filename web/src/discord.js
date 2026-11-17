/* Posting pairings and standings to a Discord channel.
 *
 * A webhook, not a bot. A bot needs a registered application, a token and a
 * process holding a gateway connection open, which is a server, which is the
 * one thing this program does not have. A webhook is a URL an admin creates in
 * Channel Settings -> Integrations. It can post to exactly that channel and do
 * nothing else: it cannot read messages, see members, or touch the rest of the
 * server. Least privilege by construction rather than by configuration.
 *
 * Posting an update edits the message already there rather than adding
 * another, so the channel holds one live pairings post and one live standings
 * post instead of a scroll of history.
 *
 * Measured, not assumed: a file:// page has an origin of `null`, and Discord
 * accepts the request anyway. A POST to an invalid webhook from a file:// page
 * returns Discord's own 404 rather than a CORS failure, so the browser let it
 * leave. That is what makes this possible without a server.
 *
 * ---------------------------------------------------------------------------
 * START HERE. The formatting is pure and the network part is thin:
 *
 *   parseWebhook()      checks the URL is a Discord webhook, and splits it
 *   pairingsMessage()   the seating of a round, as a Discord payload
 *   standingsMessage()  the standings, as a Discord payload
 *   DiscordPoster       sends one, editing the previous post if there is one
 *
 * Everything above DiscordPoster is testable without a network.
 * ---------------------------------------------------------------------------
 */
(function () {
'use strict';

/* Discord's documented ceilings. Going over gets the whole message rejected,
 * so the formatters trim to fit and say that they did. */
const LIMITS = {
  embedTitle: 256,
  embedDescription: 4096,
  fields: 25,
  fieldName: 256,
  fieldValue: 1024,
  total: 6000,
};

const COLOUR = 0x1f6f43;

/** A webhook URL, split into the parts the API needs. Throws if it is not one. */
function parseWebhook(url) {
  const text = String(url || '').trim();
  if (!text) throw new Error('Paste the webhook URL from Discord.');
  const m = text.match(
    /^https:\/\/(?:\w+\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/(\d+)\/([\w-]+)\/?$/);
  if (!m) {
    throw new Error(
      'That does not look like a Discord webhook URL. In Discord: Channel '
      + 'Settings, Integrations, Webhooks, then Copy Webhook URL.');
  }
  return { id: m[1], token: m[2], url: `https://discord.com/api/webhooks/${m[1]}/${m[2]}` };
}

/** Keep a string inside a limit, marking it when something was dropped. */
function fit(text, limit) {
  const s = String(text);
  return s.length <= limit ? s : `${s.slice(0, limit - 1)}…`;
}

const stamp = () => new Date().toISOString().replace('T', ' ').replace(/\..*/, ' UTC');

/**
 * The seating of one round.
 *
 * One field per table, which caps a message at 25 tables (100 seats). Beyond
 * that the rest is named rather than silently dropped.
 */
function pairingsMessage(tournament, round, { note = '' } = {}) {
  const tables = round.tables || [];
  const shown = tables.slice(0, LIMITS.fields - 1);
  const dropped = tables.length - shown.length;

  const fields = shown.map((t) => ({
    name: fit(`Table ${t.tableNumber}${t.lobby ? ` · ${t.lobby}` : ''}`, LIMITS.fieldName),
    value: fit(
      t.seats
        .filter((s) => s.playerId !== null && s.playerId !== undefined)
        .map((s) => `\`${s.seatWind}\` ${s.name}${s.club ? ` *(${s.club})*` : ''}`)
        .join('\n') || '*empty*',
      LIMITS.fieldValue),
    inline: true,
  }));

  if (round.byes && round.byes.length) {
    fields.push({
      name: 'Sitting out',
      value: fit(round.byes.map((b) => b.name).join(', '), LIMITS.fieldValue),
      inline: false,
    });
  }
  if (dropped > 0) {
    fields.push({
      name: 'More tables',
      value: `${dropped} further table(s) not shown; Discord allows ${LIMITS.fields} blocks.`,
      inline: false,
    });
  }

  return {
    embeds: [{
      title: fit(`${tournament.name} — ${round.label || `Round ${round.number}`}`,
        LIMITS.embedTitle),
      description: note ? fit(note, LIMITS.embedDescription) : undefined,
      color: COLOUR,
      fields,
      footer: { text: `Seating · updated ${stamp()}` },
    }],
  };
}

/**
 * The standings.
 *
 * One code block, so the columns line up in Discord's proportional font.
 * Long fields get trimmed to the number that fits rather than overflowing.
 */
function standingsMessage(tournament, rows, { scope = 'overall', precision = 1 } = {}) {
  const label = { overall: 'Overall', qualifying: 'Qualifying', final: 'Finals' }[scope] || scope;
  const width = Math.min(24, Math.max(8, ...rows.map((r) => String(r.name).length)));

  const line = (r) => {
    const name = fit(r.name, width).padEnd(width);
    const score = Number(r.tournamentScore).toFixed(precision).padStart(8);
    const flag = r.needsCoinToss ? ' =' : '';
    return `${String(r.rank).padStart(3)}  ${name}  ${score}${flag}`;
  };

  // Build up to the character ceiling rather than guessing a row count.
  const head = '```\n';
  const tail = '\n```';
  const out = [];
  let used = head.length + tail.length;
  for (const r of rows) {
    const next = line(r);
    if (used + next.length + 1 > LIMITS.embedDescription - 120) break;
    out.push(next);
    used += next.length + 1;
  }
  const dropped = rows.length - out.length;

  const body = out.length
    ? head + out.join('\n') + tail
    : '*No results yet.*';

  return {
    embeds: [{
      title: fit(`${tournament.name} — ${label} standings`, LIMITS.embedTitle),
      description: fit(
        body + (dropped > 0 ? `\n${dropped} more not shown.` : ''),
        LIMITS.embedDescription),
      color: COLOUR,
      footer: {
        text: `${rows.length} player(s)${rows.some((r) => r.needsCoinToss)
          ? ' · = marks a tie to settle' : ''} · updated ${stamp()}`,
      },
    }],
  };
}

/* ------------------------------------------------------------- the wire */

/**
 * Sends a payload, editing the message it sent last time.
 *
 * Message ids are handed in and out rather than stored here, because they
 * belong with the webhook URL in browser settings, and deliberately NOT in
 * the tournament document: that goes into restore points and CSVs, which an
 * organiser syncs to OneDrive or Drive. A webhook URL is a credential, and
 * anyone holding it can post to the channel.
 */
class DiscordPoster {
  constructor(url, { fetchImpl = null } = {}) {
    const parsed = parseWebhook(url);
    this.url = parsed.url;
    this.id = parsed.id;
    this.fetch = fetchImpl
      || (typeof fetch === 'function' ? (...a) => fetch(...a) : null);
    if (!this.fetch) throw new Error('This browser cannot make requests.');
  }

  /** Post a new message, or edit `messageId` if one was given. Returns the id. */
  async send(payload, messageId = null) {
    const editing = Boolean(messageId);
    const target = editing
      ? `${this.url}/messages/${messageId}`
      : `${this.url}?wait=true`;

    const res = await this.fetch(target, {
      method: editing ? 'PATCH' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    // The message was deleted in Discord: post a fresh one rather than failing
    // for good.
    if (editing && res.status === 404) return this.send(payload, null);

    if (res.status === 429) {
      let wait = 5;
      try { wait = (await res.clone().json()).retry_after ?? 5; } catch { /* no body */ }
      throw new Error(`Discord is rate limiting; try again in ${Math.ceil(wait)}s.`);
    }
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const body = await res.clone().json();
        if (body && body.message) detail = `${body.message} (HTTP ${res.status})`;
      } catch { /* not json */ }
      throw new Error(`Discord refused the post: ${detail}`);
    }

    try {
      const body = await res.json();
      return body && body.id ? String(body.id) : messageId;
    } catch {
      return messageId;
    }
  }
}

const API = {
  LIMITS, parseWebhook, pairingsMessage, standingsMessage, DiscordPoster, fit,
};

if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof window !== 'undefined') {
  window.RT = window.RT || {};
  window.RT.discord = API;
}
}());
