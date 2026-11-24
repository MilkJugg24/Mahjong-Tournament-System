/* Help content: the help page, and the text behind every "?" bubble.
 *
 * Pure data, no DOM. Kept apart from ui.js so the wording can be checked by a
 * test -- every "?" in the markup has to resolve to a key in FIELD_HELP, and
 * every help topic has to be reachable.
 */
(function () {
'use strict';

/* The text behind each "?" bubble, keyed by the data-help attribute.
 * Short: one or two sentences. Anything longer belongs in a help topic. */
const FIELD_HELP = {
  mode: 'In person prints table numbers and seating lists. Online adds a lobby '
    + 'or room code to each table instead. Nothing else changes -- scoring is identical.',

  rounds: 'How many hanchan everyone plays before the cut. You are not locked in -- '
    + 'add or drop rounds later if the day runs long or short.',

  'cut-size': 'How many players go through to the finals. 4 is the usual choice, '
    + 'so the top four play one final table. Set it to 0 for no cut at all, and the '
    + 'event is decided on the qualifying standings.',

  'final-rounds': 'How many hanchan the finalists play after the cut.',

  'bulk-players': 'One player per line. Put a comma after the name to record their '
    + 'club: "Player 01, Club A". A third comma-separated field is kept as a '
    + 'contact note. Lines starting with # are ignored, and duplicate names are skipped, '
    + 'so you can paste the same list twice without making a mess.',

  'player-role': 'A ranked player appears in the standings. A sit-in fills an empty '
    + 'seat so a table can play, but is never ranked -- use it for a club member who '
    + 'steps in to make up a four. Sit-ins are only seated when they complete a '
    + 'table; when the ranked players fill the tables on their own, they sit out.',

  'change-seats': 'Pick a seated player, then who takes their place. Two seated players '
    + 'swap. Someone sitting out takes the seat, and the other sits out on the same bye '
    + 'score. Someone not in this round -- a late arrival, or a sit-in for a no-show -- '
    + 'takes the seat, and the player they replace leaves the round with no score; add '
    + 'a penalty on the Cut & finals tab if your rules give one for a missed hanchan.',

  'player-status': 'Withdrawn players keep the results they have already earned but '
    + 'are left out of every future draw. Use this rather than deleting someone who '
    + 'has played, or their earlier opponents lose the record of those games.',

  'riichi-left': 'Riichi sticks still on the table when the hanchan ended. They are '
    + 'counted towards the table total, so a table that ends with two sticks left '
    + 'reads 118,000 in scores plus 2,000 in sticks.',

  chombo: 'A chombo is recorded as a tournament penalty under WRC 2025 -- it does not '
    + 'change the points on the table. Enter how many chombo that player made; the '
    + 'penalty is applied to their tournament score.',

  penalty: 'Any other points penalty the referee has given, entered in tournament '
    + 'points rather than table points. Write what it was for in the note so the '
    + 'printed sheet and the CSV log both show it.',

  'test-mode': 'Creates a practice tournament instead of a real one. You get '
    + 'buttons to generate made-up players and fill in made-up scores, and every '
    + 'page says it is a test. No CSVs are written to your backup folder. Discord '
    + 'posting does work, so the feature can be rehearsed; those posts are '
    + 'coloured and labelled as a test. Use it to try the program, or to '
    + 'rehearse before an event.',

  discord: 'Posts the current pairings and standings into one Discord channel, '
    + 'and edits those two messages as the day goes on rather than adding a new '
    + 'one each round. A webhook can only post to the channel it was made for: it '
    + 'cannot read messages or see your members. Your players\' names do leave '
    + 'this computer when you use it.',

  'scoring-model': 'Riichi scores a result as points minus the return, divided by '
    + '1,000, plus the uma. MCR instead awards flat table points for your rank -- 4, 2, '
    + '1, 0 -- and the raw points only break ties. Change this only if you are running '
    + 'Chinese Official rather than riichi.',

  'table-points': 'What each finishing place is worth under MCR. The Green Book gives '
    + '4 to the highest scorer in the session, 2 to the second, 1 to the third and 0 to '
    + 'the lowest. Players level on table points are separated by their raw points.',

  'point-divisor': 'What raw points are divided by to reach tournament units. Riichi '
    + 'scores in thousands, so 1,000. MCR counts its points as they stand, so 1. The '
    + 'step below is the smallest change a score can make, which is what catches a '
    + 'mistyped figure: 100 for riichi, 1 for MCR.',

  uma: 'The bonus added to each placement after the table points are converted. '
    + 'Entered first to fourth. They should add up to zero unless you are also using '
    + 'oka, which the app checks for you.',

  'goal-points': 'The score each player is measured against -- their points minus the '
    + 'goal, divided by 1,000. With a 30,000 start and a 30,000 goal the table is '
    + 'zero-sum. Setting the goal above the start is how oka works.',

  'table-total': 'What every table must add up to: the starting points times the '
    + 'number of seats. A table that does not reach it cannot be saved, which is what '
    + 'catches a mistyped score before it reaches the standings.',

  tiebreaks: 'Applied in order when two players finish level. The chain always ends '
    + 'with a manual decision, so the app stops and asks you rather than inventing a '
    + 'winner -- at a cut line, that matters.',

  carry: 'What the finalists start the finals with. Reset puts everyone back to zero, '
    + 'so the final is decided on the final table alone. Full carries their qualifying '
    + 'score over, and half carries one half of it.',

  'backup-folder': 'The folder the CSVs are written to after every change. Pick one '
    + 'inside OneDrive, Google Drive or Dropbox and each round is copied off this '
    + 'laptop automatically, with no account to set up. After a restart the browser '
    + 'asks for permission again; until you press Reconnect, backups are paused and '
    + 'every page says so.',

  seed: 'The same seed always produces the same draw. Leave it alone unless you want '
    + 'to reproduce a particular seating, or need to re-draw and want a different one.',
};

/* The help page. Each topic is a heading and some paragraphs. */
const TOPICS = [
  {
    id: 'start',
    title: 'Running an event, start to finish',
    body: `
      <ol class="helplist">
        <li><b>Create the tournament.</b> Name it, choose how many hanchan and how big
          the cut is. The defaults are the ordinary ones.</li>
        <li><b>Pick a backup folder</b> on the Backups &amp; print tab. Do this before
          the players arrive, not after something has gone wrong.</li>
        <li><b>Add the players.</b> Paste the list in, one per line, with a comma
          before the club.</li>
        <li><b>Draw the seating</b> for round one, and print the sheets.</li>
        <li><b>Enter the scores</b> as the tables finish.</li>
        <li><b>Close the round</b>, then draw the next one.</li>
        <li><b>Make the cut</b> when the qualifying rounds are done, and play the
          finals.</li>
      </ol>
      <p>There is nothing to undo at the end: every change has already been written to
        the backup folder as it happened.</p>`,
  },
  {
    id: 'storage',
    title: 'Where your tournament lives',
    body: `
      <p>Your event is saved on this computer as you work. It survives closing the
        lid, reloading the page and the browser crashing.</p>
      <p>What it does not survive is moving. <b>Copying the program to another laptop
        does not take the tournament with it.</b> Nor does emailing it to someone.</p>
      <p>That is what the backup folder is for. The files written there are the real
        record, and the one thing that makes your event portable and recoverable. If
        this laptop dies mid-event, you open the file on another machine, load the
        backup, and carry on from the last round.</p>
      <p>Two things will wipe an unsaved event: running in a private window, and
        "clear browsing data". Pick a backup folder and neither matters.</p>`,
  },
  {
    id: 'backups',
    title: 'Backups',
    body: `
      <p>Once you have chosen a folder, everything is written there as it happens --
        you never have to remember to save.</p>
      <ul class="helplist">
        <li><code>live/</code> &mdash; the full set of CSVs, rewritten after every
          change.</li>
        <li><code>log/</code> &mdash; append-only. <code>audit.csv</code> records every
          action; <code>results_log.csv</code> every score ever entered, including ones
          later corrected.</li>
        <li><code>snapshots/</code> &mdash; a dated copy of everything each time a round
          closes.</li>
        <li><code>restore/tournament.json</code> &mdash; the restore point. This is the
          file that puts the event back.</li>
      </ul>
      <p>Put that folder inside OneDrive, Google Drive or Dropbox and the sync app you
        already have copies each round off the laptop. No account, no setup, no network
        code in this app at all.</p>
      <p>Choosing a folder needs Chrome or Edge. In Safari and Firefox the app asks you
        to save a backup file by hand instead, and tells you when one is overdue.</p>`,
  },
  {
    id: 'seating',
    title: 'How the draw works',
    body: `
      <p>The draw tries, in order of importance, to avoid sitting the same two people
        together twice, to even out how often each player sits East, to move people
        between tables rather than leaving them in one corner all day, and to keep
        club-mates apart in the early rounds.</p>
      <p>With 100 players over 6 rounds it finds a draw where nobody meets the same
        opponent twice, in about a fifth of a second.</p>
      <p>Repeats are sometimes unavoidable -- 16 players over 6 rounds cannot avoid
        them, and the app finds the best possible compromise rather than pretending
        otherwise. Rounds are drawn one at a time, as a real event does, so an early
        round can leave a later one with fewer options.</p>
      <p>If the field is not a multiple of four, the players left over sit the round out
        and the app rotates who that is, so the same people are not always waiting. A
        sit-in player can fill a seat to make a table up to four without being ranked.</p>`,
  },
  {
    id: 'scores',
    title: 'Entering scores',
    body: `
      <p>Tap a table and type the four scores. The running total is checked against the
        table total as you type, including any riichi sticks left on the table, and a
        table that does not balance <b>cannot be saved</b>. That single check is what
        stops a mistyped score reaching the standings.</p>
      <p>Once three scores are in, the app offers the fourth, since it is the only value
        that can balance.</p>
      <p>Before you commit, you see the placements, the uma and the hanchan score each
        player will get. Chombo and other penalties go in on the same sheet.</p>
      <p>A saved table can be corrected while the round is open. Once the round is
        closed it is locked -- reopen the round first. Every version is kept in
        <code>results_log.csv</code>, so a correction never hides what was there
        before.</p>`,
  },
  {
    id: 'scoring',
    title: 'How the scoring works',
    body: `
      <p>Under WRC 2025 a player's hanchan score is their points minus the goal,
        divided by 1,000, plus the uma for their placement. With the usual settings a
        table is zero-sum: the four hanchan scores add up to nothing.</p>
      <p>When players tie, the uma for the places they share is pooled and split
        between them, and the result is truncated to one decimal place without
        rounding. That truncation is in the rules, and it is why a tied table can come
        out a tenth or two away from zero. The app reproduces both of the worked
        examples in the WRC Optional Rules exactly.</p>
      <p>With the oka variant the goal is set above the starting points, so every player
        pays in and the winner collects. The oka is added to the uma before the split,
        which is the order the rulebook gives.</p>
      <p>A chombo is a tournament penalty, not a payment at the table -- the points in
        front of the players do not change.</p>`,
  },
  {
    id: 'cut',
    title: 'The cut and the finals',
    body: `
      <p>When the qualifying rounds are done, the Cut &amp; finals tab takes the top
        players through. You choose how many go through, how many hanchan they play,
        and what they start with: nothing, their full qualifying score, or half of it.</p>
      <p>Only players still in the event go through. A withdrawn player keeps their
        qualifying place but is passed over, and the next player takes their seat.</p>
      <p>If two players are level across the cut line, the app <b>stops and asks you</b>
        rather than picking one. Breaking that tie is a tournament decision, and the
        rules put it in your hands.</p>
      <p>Everyone who did not make the cut is seated at free-play tables beside each
        final, unless you untick that on the Cut &amp; finals tab. Those tables are
        printed and posted like any other, but never scored.</p>
      <p>A cut can be undone if you made it too early, and the qualifying standings are
        kept separately from the finals throughout.</p>`,
  },
  {
    id: 'printing',
    title: 'Paperwork',
    body: `
      <p>Everything printable comes off the Backups &amp; print tab, and opens in a new
        window ready for the browser's own print dialog.</p>
      <ul class="helplist">
        <li><b>Seating lists</b> -- who is at which table, by table and by name.</li>
        <li><b>Report sheets</b> -- one per table, with the riichi-stick row and
          signature lines, matching the ARA Tournament-in-a-Box paperwork.</li>
        <li><b>Table numbers</b> -- big enough to read across a hall.</li>
        <li><b>Sign-in sheet</b> -- for the door.</li>
        <li><b>Standings</b> -- current, qualifying or finals.</li>
      </ul>`,
  },
  {
    id: 'trouble',
    title: 'When something goes wrong',
    body: `
      <p><b>A score was entered wrong.</b> Tap the table and correct it while the round
        is open. If the round is closed, reopen it, fix the table, close it again. The
        original entry stays in the log.</p>
      <p><b>Someone has to leave mid-event.</b> Set them to withdrawn on the Players
        tab. They keep the results they earned and drop out of future draws. Do not
        delete a player who has played.</p>
      <p><b>The draw looks wrong.</b> Re-draw the round -- that is allowed until a score
        has been entered. After that, seats are fixed, because the results already refer
        to them.</p>
      <p><b>The laptop died.</b> Open the file on another computer, go to Backups &amp;
        print, and load <code>restore/tournament.json</code> from your folder. You are
        back at the last saved state.</p>
      <p><b>The app says it cannot save.</b> You are almost certainly in a private
        window. Open the file in a normal window, and keep backups either way.</p>`,
  },
];

const API = { FIELD_HELP, TOPICS };

if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof window !== 'undefined') {
  window.RT = window.RT || {};
  window.RT.help = API;
}
}());
