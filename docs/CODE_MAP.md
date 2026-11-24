# Where things are

A guide to the code, arranged by the question you turned up with rather than by
the order the files happen to be in.

For how it is built and why, see [TECHNICAL.md](TECHNICAL.md). For running an
event, see the [organiser's guide](ORGANIZER_GUIDE.md).

---

## If you only read one thing

**`web/src/scoring.js`** decides every result. The formula is written at the top
of the file, followed by a short list of the five functions that do the work.
Everything else in the project is bookkeeping around it.

The downloaded `Mahjong-Tournament-System.html` is the same code, inlined. Its opening
comment is a contents list giving the line each source file starts on, and each
one sits behind a banner you can search for:

```
RT:FILE scoring.js
```

---

## The arithmetic

| Question | Where |
|---|---|
| What is a player's hanchan score? | `scoring.js` → `scoreTable()` |
| Where is the formula written out? | `scoring.js`, the file header |
| How is uma split when players tie? | `scoring.js` → `scoreTable()`, the grouping loop |
| Why is oka added before the split, not after? | same place; it is the order the rulebook gives |
| Why does a tied table not come to exactly zero? | truncation, not rounding — `rational.js` → `truncate()` |
| Why fractions instead of ordinary numbers? | `rational.js`, the file header |
| Where does "keep one decimal, do not round" happen? | `rational.js` → `truncate()`, one line |
| What refuses a table that does not add up? | `scoring.js` → `validateTable()` |
| Who came first, and who tied? | `scoring.js` → `placementsFor()` |
| How is the tournament ranking decided? | `scoring.js` → `buildStandings()` |
| Where are the published rulesets? | `scoring.js` → `RULESET_PRESETS`, each citing its document |
| How does MCR score differently from riichi? | `scoring.js`, the scoring-model note; `scoreTable()` branches on `usesPointDelta` |
| Why does MCR not have to sum to zero? | the zero-sum check is riichi-only — table points come to 7 |
| What happens at a tie the tiebreaks cannot settle? | `buildStandings()` sets `needsCoinToss`; the cut then refuses to guess |
| How is a chombo applied? | `scoring.js`; under WRC 2025 it is a tournament penalty, not a payment at the table |

## The draw

| Question | Where |
|---|---|
| Who sits where? | `seating.js` → `generateSeating()` |
| How are repeat opponents avoided? | `seating.js`; a pair's second meeting costs 1, a third 4, a fourth 9 |
| Why is the draw the same twice in a row? | the seeded PRNG (mulberry32) in `seating.js`; `Math.random` cannot be seeded |
| How are seat winds balanced? | `seating.js`, the cost function |
| Who sits out when the field is not a multiple of four? | `seating.js`, bye rotation |

## The event

| Question | Where |
|---|---|
| Everything that changes a tournament | `store.js` — every mutation goes through here |
| Why can a round not be re-drawn after a score is in? | `store.js` → `reseatRound()`, which refuses |
| Why can a closed round not be edited? | `store.js` → `saveTable()`, which refuses |
| How is a closed table corrected, then? | `store.js` → `amendTable()`, which needs a reason and logs the old scores |
| How do seats change after the draw? | `store.js` → `swapSeats()`, including someone from outside the round |
| Where do free-play tables beside a final come from? | `store.js` → `generateRound()`, the `freePlayForRest` block |
| How does the cut work? | `store.js` → `applyCut()` |
| Where is the audit trail written? | `backup.js` → `appendAudit()` |

## Storage and files

| Question | Where |
|---|---|
| Where does the working copy live? | `persist.js` — IndexedDB |
| What gets written to the backup folder? | `backup.js` → `buildAll()` |
| What are the CSV columns? | `backup.js`; they are a contract, pinned in `web/tests/backup.test.js` |
| How does restoring an event work? | `backup.js` → `restorePoint()` / `readRestorePoint()` |
| Why is the data not in the folder next to the HTML? | `file://` storage belongs to the browser profile — see TECHNICAL.md |

## The interface

| Question | Where |
|---|---|
| The whole interface | `ui.js` |
| The printable sheets | `printing.js` |
| Help topics and the "?" text | `help.js` — plain data, no DOM |
| The guided tutorial | `tutorial.js` — the steps and the engine |
| How the one file is assembled | `build.js` |
| What people download | `Mahjong-Tournament-System.html` at the root — the built page, committed |

---

## Reading order, if you want the whole thing

1. `rational.js` — small, self-contained, and everything stands on it.
2. `scoring.js` — the rules as code. Read the header first.
3. `store.js` — how a tournament is actually run and what it refuses to do.
4. `seating.js` — independent of the above; skip it unless you care about the draw.
5. `ui.js` — large but shallow; it renders the above and calls into `store.js`.

`backup.js`, `persist.js`, `printing.js`, `help.js` and `tutorial.js` can be read
whenever, in any order.

## Conventions worth knowing before you change anything

- **Nothing derived is stored.** Scores are facts; placements, uma and standings
  are computed from them every time. So changing a rule and recomputing is
  consistent across a whole event, and there is no cache to go stale.
- **The engines are pure.** `rational.js`, `scoring.js` and `seating.js` touch
  no storage, no DOM and no clock. That is why they are the well-tested part.
- **Every mutation goes through `store.js`**, which is where the guards live.
  The interface never edits the tournament directly.
- **Each source file wraps itself in an IIFE** and publishes through
  `window.RT`. This is not style: inlined as plain scripts they share one
  scope, and without the wrappers their top-level names collide and the page
  dies before it loads. TECHNICAL.md tells that story.
- **The CSV headers are a contract.** Organisers have spreadsheets pointing at
  those columns. Adding a column at the end is safe; renaming, reordering or
  removing one is a breaking change.
