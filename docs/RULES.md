# Scoring reference

Every setting on the **Setup** tab, what it does, and the rule it comes from.

Sources:

- **WRC 2025** — [World Riichi Championship Rules 2025](https://www.worldriichi.org/wrc-rules),
  version `v20250526`.
- **WRC Penalties 2025** — the separate penalties document on the same page.
- **WRC Optional Rules** — the rule book extension covering uma, oka, yakitori
  and other variants.
- **ARA** — the [Tournament-in-a-Box](https://arariichi.org/tournamentinabox)
  guide.
- **EMA RCR 2016** — the European Mahjong Association's
  [Riichi Competition Rules](https://mahjongeurope.org/), *"Riichi — Rules for
  Japanese Mahjong"*, the revision effective 1 April 2016.

---

## The rulesets you can start from

Pick one when you create the tournament. Every number stays editable on the
Setup tab afterwards, so these are starting points rather than a closed list.

| | Start | Goal | Uma | Chombo |
|---|---|---|---|---|
| **WRC 2025** (default) | 30,000 | 30,000 | +15/+5/−5/−15 | 30 |
| **EMA RCR 2016** | 30,000 | 30,000 | +15/+5/−5/−15 | **20** |
| **Saikouisen** | 30,000 † | 30,000 | +30/+10/−10/−30 | 20 |
| **MCR (Chinese Official)** | — | — | table points 4/2/1/0 | — |
| **WRC with oka** | 25,000 | 30,000 | +15/+5/−5/−15 | 30 |
| **Red fives** | 30,000 | 30,000 | +30/+10/−10/−30 | 30 |

† not stated in the Saikouisen documents; see below.

### EMA RCR 2016

The European ruleset is the same arithmetic as WRC 2025, with one number
different: the chombo penalty. The rulebook is quoted directly in
`web/src/scoring.js`, and the figures are pinned as tests.

> the players count their scores and subtract the 30,000 points they began the
> game with

> Winner receives 15,000 points, second ranked player receives 5,000 points,
> third ranked player is penalized with -5,000 points and the last player is
> penalized with -15,000 points.

> If there is a tie, the points for the relevant places are split between the
> tied players. E.g. if two players are tied at the first position, each gets a
> bonus of 10,000 points.

> In a tournament the chombo penalty is 20,000 points which are deducted from
> the player's overall tournament score after the game is finished, and after
> the uma is added to the players' scores.

One RCR rule this program does not need to model: riichi bets left on the table
at the end of a hanchan **go to the winner** under RCR, where WRC 2025 leaves
them on the table. Either way the reported scores plus any remaining sticks come
to the table total, which is what gets checked — so enter the scores as the
players finished with them and the riichi-stick box takes care of the rest.

### Saikouisen

From the **Competition Rules 1.12** (8 June 2026) and the scoring list on
saikouisen-usa.com/rules.

Quoted from the rulebook:

> A deduction of 20 Points from the total points of the player with the penalty.
> *(Chonbo, Article 54; a Sho-Chonbo is 10, and three warnings in a hanchan cost
> 5)*

> If no one has yet collected the Kyoutaku at the end of the Hanchan, the
> Kyoutaku will be left on the table. *(Article 39)*

From the rules page: **No Oka**, and *"Uma (Placement Points) 10000 Points -
30000 Points"* — that is, ±30 and ±10, the usual Japanese professional spread.

**What is not stated anywhere: the starting stack.** The rulebook is a rulebook
for *playing*; it ends at Article 55 without one, and the site says the rules
"may vary" by event. This preset uses 30,000, which is the Japanese professional
convention — it is a starting point, not a quoted figure.

That matters less than it looks. With no oka the goal equals the start, so the
table is zero-sum **whatever** the stack is: changing it moves what a table must
add up to (4 × 30,000 = 120,000) and **nothing else**. Nobody's score changes.
If your event starts on 25,000, set it on the Setup tab and carry on. There is a
test that holds this true.

### MCR (Chinese Official)

A different game, and the only ruleset here that is not riichi. There is no
riichi, no uma and no oka, and the result of a session is a **flat rank bonus**
rather than anything worked out from the points.

From the **"Green Book"** (Mahjong Competition Rules, WMO 2006) §3.9.2:

> After four rounds have been played or the allotted time for a game session has
> run out, all points of all played hands are added to determine the high
> scorer, the second-place scorer, the third-place scorer, and the low scorer
> for the game. The high scorer for the game is awarded 4 Table points. The
> second-place scorer is awarded 2 Table points. The third-place scorer is
> awarded 1 Table point. The low scorer earns 0 points for the game session.

And §3.10.1, which is why the tiebreak is the raw points:

> Players are ranked based on Table Points gained during the competition. In a
> case in which multiple players have equal Table Points, the player who earned
> the most Contest Points ranks higher. (Contest Points are the sum of all
> scores earned by the player during each game session.)

So in this program an MCR event:

- starts players from **0**, not from a stack, because MCR hands are zero-sum —
  a win by discard takes basic+8 from the discarder and 8 from each other player
- enters the **session total** for each player, which must come to 0
- scores **4 / 2 / 1 / 0** by rank, keeps no decimals, and counts points in ones
  rather than hundreds
- ranks on table points, breaking ties on the raw points

The Green Book does not say what happens when two players finish a session
level. The places they share are pooled and split, which is what this program
does everywhere else; set *Ties at a table* to seat order if your tournament
rules otherwise.

**Red fives** is not a published ruleset: it is the bigger uma that clubs
commonly use for red-five events, and it is here as a convenience. Change it to
whatever your event announces.

---

## The formula

WRC 2025 §3.5 and §10.3:

```
score delta    = (player score − goal) ÷ 1,000
hanchan score  = (player score − goal) ÷ 1,000 + uma [+ oka]
tournament score = sum of hanchan scores − point penalties
```

Scores are noted **P**. One P is 1,000 points at the table.

### The three coherency checks

WRC 2025 §10.3 lists the checks a referee makes. This system applies all three:

1. The players' scores plus any remaining riichi deposits must total 120,000
   (starting points × players per table).
2. The uma must sum to zero.
3. The hanchan scores plus the number of remaining riichi deposits must come to
   zero.

Check 1 blocks saving. Check 3 is reported as a warning when an uneven uma
split makes it unavoidable — see *Rounding* below.

---

## Settings

### Starting points · Return/goal

WRC 2025 §6.1: each player starts with 30,000, and the break-even point is also
30,000, so there is no oka.

Setting the goal **above** the starting points creates an oka — the gap, pooled
across the table, goes to the winner. The WRC Optional Rules' variant (Mod.4.2)
is a 25,000 start with a 30,000 goal, making a 20,000 = 20P oka. Deltas are
always measured against the goal, never the start.

| | WRC 2025 | Optional oka |
|---|---|---|
| Starting points | 30,000 | 25,000 |
| Goal | 30,000 | 30,000 |
| Oka | 0 | 20,000 = 20P |
| Table must total | 120,000 | 100,000 |

### Uma

WRC 2025 §10.3: **+15 / +5 / −5 / −15**.

The Optional Rules suggest larger uma when red fives are in play (+30/+10/−10/−30)
and smaller when ura and kan dora are not used (+12/+4/−4/−12). Any set works as
long as it sums to zero.

### Ties at a table

**Split the uma (WRC).** WRC 2025 §10.3: players on equal points share the total
uma for the positions they occupy. Two tied for first get +10 each, and the
others still get −5 and −15. Tied players share the better placement, so a table
can finish 1st, 1st, 3rd, 4th.

With an oka, the Optional Rules say to **add the uma and oka together before
splitting**, which keeps the rounding error as small as possible. That is what
this system does.

**Break by seat wind.** The common Japanese alternative: ties break East > South
> West > North, so every hanchan has a strict 1st to 4th.

### Rounding

WRC 2025 says the hanchan score is computed "without rounding". When an uma does
not divide evenly between tied players, the Optional Rules are explicit:

> keep only one decimal without rounding; the sum of hanchan scores will be
> slightly off.

So **one decimal, cut off** is the default. The rules' own worked examples:

- With a +20/+10/−10/−20 uma, three tied at the top get **+6.6 each** and the
  table sums to **−0.2** instead of 0.
- With that uma and a 20P oka, three tied at the top get **+13.3 each** and the
  table is off by **0.1**.

Both are reproduced exactly, and are covered by tests. When this happens the
table shows a warning explaining that the rules accept the small difference.

With the default WRC uma every possible tie splits evenly, so tables always sum
to exactly zero.

### Chombo

WRC Penalties 2025: a chombo is a **30P point penalty** taken off the offending
player's tournament score. The hand is re-dealt and **there is no mangan
payment**, so the table total is unchanged.

That is the default here: *taken off the tournament score*. Recording a chombo
does not alter anybody's table points.

The alternative, *settled at the table*, is for events that use the traditional
mangan payment — the transfer is already in the reported scores, so the system
adds nothing further.

Under **EMA RCR 2016** the same penalty is **20,000 points**, deducted the same
way — from the tournament score, after the uma. Choosing the EMA RCR ruleset sets
that for you.

The ARA runs WRC 2025 with an optional modification it calls **Lower
Penalties**. That modification is not in the WRC documents published at the link
above, so no figure for it is shipped here; set the chombo penalty to whatever
your event announces. The default is the WRC 30P.

### Other penalties

Point penalties come off the tournament score and never change a table total
(WRC Penalties 2025). Add them on the **Cut & finals** tab. For reference, WRC
2025 uses 30P for a chombo, 30P for missing a hanchan, 10P for being ten minutes
late, and 5P for repeated minor offences.

### Tiebreakers

WRC 2025 §5 recommends, in order:

1. Most firsts
2. Fewest fourths
3. Highest-scoring hanchan
4. Coin toss

The first three are automatic. For the coin toss, set a **Tiebreak** number on
the Players tab; higher ranks higher. Until then, players who are still level
are flagged in the standings and on printouts with an asterisk, and the cut
refuses to run across a tied line.

### Players sitting out

Not a WRC matter — fields are rarely a multiple of four. The ARA's answer is
three sit-in players; where that is not possible, byes rotate so nobody sits out
twice before everyone has sat out once.

Sit-ins are seated only when there are enough of them to complete the last table.
A field that fills its tables on its own leaves them out, so a sit-in never takes
a seat from a ranked player and turns it into a bye.

A bye scores either a **fixed amount** (0P by default) or the player's **own
average so far**. The value is worked out when the round is drawn and stored, so
it is auditable afterwards. Byes do not count as a hanchan played and do not
affect placement tiebreakers.

### Players per table

Four. Settable for three-player variants, but the uma must then have three
entries and the three-player rules themselves are not implemented.

---

## Seating

WRC 2025 §5: "The seating system should not assign players to a specific table
for several hanchan." The draw therefore balances four things, each with an
adjustable weight:

| Goal | Default weight | What it does |
|---|---:|---|
| Avoid repeat opponents | 100 | A pair meeting twice costs 1, three times 4, four times 9 — the ARA pairing tool's model |
| Balance seat winds | 3 | Stops anyone sitting East repeatedly |
| Move between tables | 1 | Satisfies §5 |
| Keep clubs apart | 25 | Avoids seating club-mates together |

Raise **Search effort** for a better draw on a large field; a second or two is
plenty for 100 players.

---

## What is not implemented

This system records results; it does not referee hands. It has no opinion on
yaku, fu, or what happened at the table — only on the final scores reported to
it. Hand scoring, the yaku list and the fu table are in the WRC rulebook, and
the ARA's printable points chart is worth having on every table.
