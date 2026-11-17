# Technical notes

How the system is built, and why.

- Looking for a particular piece of code? **[CODE_MAP.md](CODE_MAP.md)** is a
  map by question — "where is uma split on a tie?" and so on.
- Running an event: the [organiser's guide](ORGANIZER_GUIDE.md).
- Scoring settings and the rule behind each: [RULES.md](RULES.md).

---

## Shape of the thing

One self-contained HTML file, about 300 KB, authored as separate sources and
inlined at build time.

```
web/
├── src/
│   ├── rational.js   exact arithmetic on BigInt
│   ├── scoring.js    hanchan scores, uma, oka, placements, standings
│   ├── seating.js    the pairing optimiser, byes, the ARA wheel, cut seeding
│   ├── store.js      tournament operations; everything mutating goes through here
│   ├── backup.js     CSV generation, the backup folder, restore points
│   ├── persist.js    the IndexedDB working copy
│   ├── printing.js   printable pages
│   ├── help.js       help topics and the text behind every "?" bubble
│   ├── tutorial.js   the guided walkthrough: demo data, steps, the engine
│   ├── ui.js         the interface
│   └── index.html, style.css
├── tests/            node:test, plus a browser run against the built file
├── build.js          inlines everything into one HTML file
└── release.js        builds what people download
```

No runtime dependencies and no build dependencies. Playwright is needed only for
the browser test, and only in CI.

```bash
node web/build.js              # -> web/dist/riichi-tournament.html
node web/run-tests.js          # the lot, including the browser run
node web/run-tests.js --not browser   # 183, no Playwright needed
node web/release.js            # -> dist/
```

Use `run-tests.js` rather than `node --test "web/tests/*.test.js"`: Node 20 does
not expand that glob itself, and neither does the Windows shell, so the runner
finds the files and passes them explicitly.

Node 20 or newer.

---

## Why one file

A double-clicked page runs on `file://`. Measured in Chromium 153 on a real
`file://` page, rather than assumed:

| Capability on `file://` | Result |
|---|---|
| `isSecureContext` | **true** |
| `localStorage`, `IndexedDB` | **both work**, survive reload |
| `showSaveFilePicker` / `showDirectoryPicker` | **available and callable** (`AbortError`, not `SecurityError`) |
| `<script src="...">` | works |
| `<script type="module">`, `fetch()` | **blocked** (CORS) |
| Storage namespace | **every `file://` page shares one** — the origin is literally `file://` |
| Does data live in the folder? | **No — it lives in the browser profile** |

Three consequences drive the design:

1. **Modules and `fetch` are blocked**, so everything is inlined into one page.
   That is also why it works offline: there is nothing left to load.
2. **Classic scripts share one lexical scope.** Eight files each declaring
   top-level names collided and killed the page. Every source file wraps itself
   in an IIFE and publishes through `window.RT`.
3. **Data belongs to the browser profile, not the folder.** Copying the HTML
   elsewhere does not carry the tournament. So IndexedDB is only the working
   copy, and the files written to the backup folder are the record. The
   interface says so, plainly, rather than leaving it to be discovered.

The build fails if anything external survives into the page, and if any
declaration containing a `$` does not come through byte for byte — see the
bundler note below.

Because the result is one long file, the build also makes it navigable: the
comment at the top is a contents list giving the line each source file starts
on, and each one sits behind a banner you can search for (`RT:FILE scoring.js`).
The two files that decide a player's score are marked as such. A test checks
that every line number in that index really is that file's banner, since an
index that is off by a few is worse than none.

---

## Exact arithmetic

WRC scoring needs exact rational arithmetic. JavaScript has no `Decimal` or
`Fraction`, but it has `BigInt`, and a rational held as a pair of BigInts is the
same object as Python's `Fraction`. `rational.js` is about 200 lines and has no
dependency.

Truncation falls out for free: BigInt division truncates toward zero, which is
precisely the rulebook's *"keep only one decimal without rounding"*.

Both worked examples from the WRC Optional Rules are pinned as tests:

- a +20/+10/−10/−20 uma with three tied at the top gives **+6.6** each, and the
  table is off by **0.2**;
- with the 20P oka, **+13.3** each, off by **0.1**.

---

## Two scoring models

Most of what this program supports is riichi, where a result is
`(points - goal) / 1,000 + uma` and the table is zero-sum. MCR is not: a session
is scored as a flat **4 / 2 / 1 / 0** by rank, and the raw points carry on only
as the tiebreak.

Rather than special-case MCR, `ScoreRules` carries a `scoringModel`:

| | `riichi` | `table_points` |
|---|---|---|
| hanchan score | delta + uma (+ oka) | the rank bonus alone |
| raw points | part of the score | the tiebreak only |
| table must total | start × seats | 0 — MCR hands are zero-sum |
| points divided by | 1,000 | 1 |
| scores move in | 100s | 1s |
| uma sums to zero | checked | not applicable (4+2+1+0 = 7) |

The tie machinery is shared: both models pool what the tied places are worth and
divide it, so there was no second implementation to keep in step. The two places
they genuinely diverge are `scoreTable()`, which does not add the delta in under
`table_points`, and the zero-sum coherency check, which is riichi-only and would
otherwise fail every MCR table.

Three things fell out of adding MCR that were latent bugs rather than new work:

- the "not a multiple of 100" warning was hard-coded, and would have flagged
  every MCR table. It is now `scoreStep`, a rule.
- the score entry box had `step="100"` baked into the markup.
- `fmtScore` formatted everything to one decimal whatever the tournament's
  `scorePrecision` said. Invisible while every ruleset used one decimal; wrong
  as soon as one kept none.

## Seating

The ARA's pairing tool scores a candidate seating by counting how often each pair
has already met — a second meeting costs 1, a third 4, a fourth 9 — then shuffles
the field at random many times and keeps the best. Its notes say *"winds and
relative seating are not handled by the software"*.

This keeps that cost model and searches properly: simulated annealing, then a
sweep that takes every improving swap until none is left. Annealing alone can
leave a repeat pairing that a single swap would fix.

It also balances seat winds, spreads table assignments (WRC Rules 2025 §5 asks
for it), keeps clubs apart, and rotates byes.

| Field | Rounds | Repeat pairs | Worst seat-wind gap | Draw |
|------:|-------:|-------------:|--------------------:|-----:|
| 20 | 4 | 0–1 | 2 | ~0.1 s |
| 40 | 6 | 0 | 1 | ~0.1 s |
| 63 | 6 | 0 | 1 | ~0.1 s |
| 72 | 8 | 0 | 2 | ~0.1 s |
| 100 | 6 | 0 | 1 | ~0.2 s |

Rounds are drawn one at a time, as a real event does, so an early round can leave
a later one with no repeat-free option — that is the 0–1 in the first row.

Where repeats are genuinely unavoidable it finds the minimum: 16 players over 6
rounds deals 144 meetings into 120 pairs, and it lands on exactly 24 pairs
meeting twice, none meeting three times. That is asserted as a test.

`Math.random` cannot be seeded, so the PRNG (mulberry32) lives in the module and
the same seed gives the same seating.

---

## Storage and backups

**Working copy** — IndexedDB, written after every change. Survives closing the
lid, reloading, crashing. Tournaments are keyed by id, never by folder, because
all `file://` pages share one storage namespace.

**The record** — a folder the organiser picks once, through the File System
Access API. The directory handle is itself stored in IndexedDB, so the grant
survives sessions.

```
<folder>/<event>/
├── live/        the full CSV set, rewritten after every change
├── log/         append-only: audit.csv and results_log.csv
├── snapshots/   a dated copy each time a round closes
└── restore/     tournament.json
```

Chromium only; Safari and Firefox fall back to downloads, and the manager tracks
how long it has been since the last one so the interface can say so.

Putting that folder inside a synced cloud folder gives offsite backup with no
OAuth, no API and no network code — the desktop sync client does the work. That
is a deliberate choice over integrating with any provider.

### The CSV format is a contract

Organisers have spreadsheets and scripts pointing at these columns. The headers
were verified byte-for-byte against the Python version before it was retired,
and are pinned in `web/tests/backup.test.js`. Adding a column at the **end** is
safe; renaming, reordering or removing one is a breaking change.

`results.csv` carries `table_total_check` on every row so the arithmetic can be
audited outside the program. `ara_sheet.csv` matches the ARA spreadsheet layout.

---

## Tests

220 in all: 183 without the browser run, and the browser suite on top.

| File | Covers |
|---|---|
| `scoring.test.js` | the formula, tie splitting, oka, validation, standings, both WRC worked examples |
| `seating.test.js` | pairing quality, the provable minimum, wind balance, byes, locked seats, determinism |
| `store.test.js` | tournament operations and every guard an organiser relies on |
| `backup.test.js` | CSV generation, the frozen column headers, restore points, roster import |
| `printing.test.js` | the five printable views, escaping |
| `help.test.js` | help content, and that every `?` in the markup resolves to wording |
| `docs.test.js` | that the docs' pointers into the code are still true, and the built page's index is accurate |
| `tutorial.test.js` | the whole walkthrough driven headlessly, and Prev/Next round-tripping |
| `browser.test.js` | the built file, driven from `file://` |

The browser run is the one that matters most: it opens the built page the way an
organiser does and drives a whole tournament — roster, seating, a table that does
not add up being refused, the offer to fill in the fourth score, the cut, a final
round, the print views — while asserting **zero network requests**. It also
checks the data survives a reload, and that an event restores into a fresh
browser profile from a backup file.

CI runs the unit tests on Node 20 and 24 on Linux plus Node 22 on Windows, and the
browser run, on every pull request.

There is no macOS leg. It is POSIX, so it ran the same code paths as Linux and
never failed on its own, and it could not be relied on to start: GitHub cancels
such a job with "not acquired by Runner of type hosted even after multiple
attempts", noting that its arm64 pool — what `macos-latest` now resolves to — is
capacity-constrained. Safari is covered as WebKit in the browser run instead,
which is the part a Mac organiser actually depends on.

---

## The tutorial and the help

`tutorial.js` drives the **real** store: the real draw, the real scoring, the
real validation. Nothing in the walkthrough is mocked up, so what it shows is
what the app does. The two score steps call `previewTable` with a table that is
1,000 over and then with the corrected one, and display whatever the engine says.

Two things follow from that:

- **The engine touches no DOM.** It is handed a context by `ui.js` and calls back
  into it. So the entire walkthrough runs in `node:test` with no browser, which
  is what `tutorial.test.js` does -- it plays the demo event through to the final
  and asserts the standings are zero-sum.
- **Prev works by snapshot.** Each completed step records the tournament as it
  then stood, and going back restores it. Replaying forwards reproduces the same
  tournament, which a test checks by comparing the documents with ids and
  timestamps stripped.

The demo event carries `config.demo`, and `BackupManager.handleChange` returns
early on it, so the tutorial never writes a fake tournament into the organiser's
backup folder. That is asserted both ways: a demo event writes nothing, a real
one still writes.

Help text lives in `help.js` as data, not inline in the markup, so
`help.test.js` can check that every `data-help` key used in `index.html` and
`ui.js` resolves to real wording. A `?` with nothing behind it looks like a bug
to the organiser and nothing else would catch it.

## Two bugs worth remembering

Both only appeared when the built file was actually opened. Neither was reachable
from the unit tests.

**Classic scripts share a lexical scope.** The modules had only ever been loaded
through `require()`, where each file gets its own scope. Loaded as eight scripts,
their top-level `const API`, `Rational` and `$` collided and the page died before
the interface attached. Hence the IIFE wrappers.

**`String.replace` ate a `$`.** With a *string* replacement, `$$` means a literal
`$`. The bundler inlined the sources that way, silently rewriting `const $$ =` in
`ui.js` to `const $ =` — a page that would not load, from a build step that
reported success. The replacements are functions now, and the build fails loudly
if a `$`-containing declaration does not survive.

---

## How the port was verified

Version 1 was Python with a local web server. The scoring and seating engines
were ported, not rewritten, and the port was checked against the original rather
than against anyone's reading of it.

A differential harness generated randomised tables, scored them with both
engines, and compared every field: placement, shared-placement flag, delta, uma,
oka, hanchan score, penalty, and the validation codes. Final run before the
Python was retired:

- **12,000 tables × 4 seats = 48,000 hanchan scores**, of which **5,527 tables
  contained ties** — the case where the rounding rule actually bites
- **1,500 standings cases**, comparing rank, score and the coin-toss flag
- across 7 uma sets (including ones that divide badly), 4 point configurations
  including oka, both tie modes, both rounding modes, riichi sticks, chombo and
  penalties

Every value identical. The CSV headers were compared the same way.

The Python version is no longer published — see Versioning below — but it is
still in this repository's history, at `fc4eb27`. It supported score runners
entering results from their own phones, which needs a server.

---

## Versioning

Below 1.0 until the system has run a real tournament end to end.
`web/package.json` is the single source of truth, and `release.js` refuses to
build an artefact whose version disagrees with it.

**Only the newest release is published.** Below 1.0 the older ones are deleted
rather than left on the releases page, so an organiser downloading the software
cannot pick a stale build by mistake, and there is only ever one answer to
"which file do I want". Use the `manage release` workflow, `action: delete`, to
remove the previous one after the new one is up.

Nothing is lost by that: a release is built from a commit on `main`, the commit
stays in the history, and `release.js` reproduces the artefact byte for byte
from it. The tag goes with the release; the code does not.

## Releasing

```bash
# bump the version in web/package.json first
git tag v0.2.1 && git push origin v0.2.1
```

Or the **Run workflow** button on the `release` workflow. Either way CI runs the
tests, builds the page, opens it in a real browser and drives a tournament
through it, and only then publishes. `release.js` refuses to build if the version
disagrees with `web/package.json`, so the program can never report a different
version from the file people downloaded.

**One artefact.** A release is `riichi-tournament.html` and nothing else, and the
workflow fails if `dist/` ends up holding more than one file. There used to be a
zip as well, carrying the same page plus the guides; the guides are in the
program now, under Help, so the zip only offered a second download that was
worse than the first — a folder to unpack instead of a file to open. Dropping it
also took about 160 lines of hand-written zip writer out of `release.js`.

### The workflows

| | |
|---|---|
| `tests.yml` | every push and pull request: the suite on Node 20/24 on Linux and Node 22 on Windows, plus the browser run |
| `release.yml` | publishes a release, from a `v*` tag or the Run workflow button |
| `manage-release.yml` | renumbers or removes a published release. Read its header before using it: the Actions token cannot create a tag at a commit whose workflow files differ from the current ones, so some renumbering needs a tag pushed by hand first |
