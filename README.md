# Mahjong Tournament System

[![tests](https://github.com/MilkJugg24/Mahjong-Tournament-System/actions/workflows/tests.yml/badge.svg)](https://github.com/MilkJugg24/Mahjong-Tournament-System/actions/workflows/tests.yml)

Offline tournament software for riichi mahjong, which runs in your browser.
Enter your players, draw the seating and type in the scores. It keeps the
standings, runs the cut, prints the paperwork and writes every result out as
CSV.

Scoring follows the [WRC 2025 rules](https://www.worldriichi.org/wrc-rules),
which is what the [American Riichi Association](https://arariichi.org/tournamentinabox)
uses. The printed sheets match the ARA's Tournament-in-a-Box paperwork.

## Getting started

[Download the latest release.](https://github.com/MilkJugg24/Mahjong-Tournament-System/releases/latest)

Double-click it and it opens. There is nothing to install and no account to
make. It works in Chrome, Edge, Safari and Firefox, on Windows, Mac or Linux.

### Pick a backup folder before your event

Open **Backups & print** and choose a folder. Do this before the players
arrive.

Your tournament lives on whichever computer you set it up on. **Copying the
program to another laptop does not bring the tournament with it.** The backup
folder is what travels.

Put that folder inside OneDrive, Google Drive or Dropbox and every round is
copied off the laptop by the sync client already running there.

Choosing a folder needs Chrome or Edge. In Safari and Firefox the app asks you
to save a backup file by hand after each round, and tells you when one is
overdue.

### Try the tutorial

**Tutorial**, at the top right, builds a demo event of twelve players and plays
it through, explaining each step. It includes a table that does not add up being
refused, so you can watch the check working before your event depends on it.

The demo is a separate tournament, and nothing it does reaches your backup
folder. Delete it from the Events tab when you have finished with it.

**Help**, next to it, is the same material written out. The small **?** beside a
setting explains that setting.

### Run the event

1. Create the tournament and choose how many hanchan and how big the cut is.
   You land on the rules page, where you can take the defaults or start from a
   published ruleset.
2. Paste your players in, one per line, with the club after a comma:

   ```
   Player 01, Club A
   Player 02, Club B
   ```

3. Draw the seating. Nobody meets the same opponent twice where that can be
   avoided, seat winds even out, and club-mates are kept apart.
4. Print the seating lists, a report sheet per table, table numbers and a
   sign-in sheet.
5. Enter each table's four scores. They are checked against 120,000 as you type,
   and once three are in the app offers the fourth.
6. Close the round, then draw the next one.
7. Make the cut when the qualifying rounds are done, and play the finals.
8. Collect the results from your backup folder, where they already are.

The [organiser's guide](docs/ORGANIZER_GUIDE.md) covers all of this in full.

## What it does

- Draws seating that avoids repeat opponents, balances seat winds, moves players
  between tables and separates club-mates. At 100 players over 6 rounds nobody
  meets the same opponent twice.
- Checks every table against 120,000 as you type, riichi sticks included, and
  refuses to save one that does not balance.
- Shows placements, uma and hanchan scores before you commit a table.
- Prints seating lists, per-table report sheets with a riichi-stick row and
  signature lines, sign-in sheets and table numbers.
- Writes CSV after every change: a current set, a dated snapshot per round, and
  an append-only log of every score ever entered.
- Handles fields that are not a multiple of four, sit-in players who fill a
  table without being ranked, withdrawals, chombo and penalties.
- Stops and asks you to settle a tie at the cut line rather than picking one.

## Why you might not want it

- **Score runners cannot use their phones.** It runs on one computer. An earlier
  version supported phones, but it was not offline.
- **It is a laptop tool.** A phone can open it, but the screen is wrong for
  running a room.
- **Choosing a backup folder needs Chrome or Edge.** Safari and Firefox fall
  back to saving a file by hand each round.
- **No real event has used it yet.** It is tested, and the scoring reproduces
  the rulebook's own worked examples, but it is below 1.0 for a reason.

## Which ruleset?

New tournaments start on WRC 2025: 30,000 start, uma +15/+5/−5/−15. That is what
the ARA uses and what most events want.

The rules page can fill itself in from any of these, and tells you which
document the numbers came from:

| | |
|---|---|
| WRC 2025 | the default, and what the ARA uses |
| EMA RCR 2016 | European riichi. As WRC, except a chombo costs 20 |
| Saikouisen | uma ±30/±10, no oka, chonbo 20 |
| MCR | Chinese Official. Table points 4/2/1/0 by rank, not riichi |
| WRC with oka | the optional oka variant |
| Red fives | the larger uma clubs use for red-five events |

Nothing is saved until you press Save, and every number stays editable
afterwards. These are starting points rather than a closed list.

[Every setting, and the rule behind it.](docs/RULES.md)

## Questions

**Do I need internet?** Only to download the file.

**Can I run two tournaments at once?** Yes. They are listed on the Events tab.

**I closed the tab by mistake.** Reopen the file. Your event is still there.

**My laptop died mid-event.** Open the file on another machine, go to Backups &
print, and load `restore/tournament.json` from your backup folder. You are back
at the end of the last round.

**The app says it cannot save.** You are probably in a private window, where
browsers refuse storage. Open the file in a normal window.

**Is my players' data sent anywhere?** No. It stays on your computer.

## Versions

Below 1.0 until the system has run a real tournament from start to finish. Until
then only the newest release is published, so the download link above is always
the right one and there is no older build to pick by mistake.

## For developers

- [docs/CODE_MAP.md](docs/CODE_MAP.md) says where everything is, arranged by the
  question you arrived with. Start there to check how a score is worked out.
- [docs/TECHNICAL.md](docs/TECHNICAL.md) covers how it is built, and the tests.

## Credits

- Rules and worked examples: [World Riichi Championship Rules 2025](https://www.worldriichi.org/wrc-rules)
  and the WRC Optional Rules extension.
- Format, paperwork and the pairing model: the
  [ARA Tournament-in-a-Box](https://arariichi.org/tournamentinabox) guide and
  its pairing tool.

## Licence

MIT. See [LICENSE](LICENSE).
