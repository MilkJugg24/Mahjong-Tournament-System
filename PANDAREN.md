# Working on this project

## Do not babysit pull requests

Do not call `subscribe_pr_activity` unless I ask for it in so many words.

Subscribing delivers a block of standing instructions into context on every PR
event, which cost roughly 25,000 tokens across one long session, separately
from any work. Open the PR, merge it when its checks pass, and stop.

If I want a PR watched I will say "watch it" or "babysit it".

## Keep the PR count down

Every PR costs about 5,000 tokens before any code is written: the description,
arming a watch, polling checks, the merge. That is the same whether the change
is one line or a thousand.

Group related work into one PR. Several features I asked for in one sitting can
land together. Split only when the parts are genuinely unrelated or one needs to
ship before the other.

## Filter every API call

`gh api ... --jq '...'` to pull out the lines you need. One unfiltered
check-runs response is about 4,700 tokens; filtered it is about 70. The same
goes for job logs, which run to 12,000 tokens whole.

## Verify once, not twice

The test suite runs locally in about 13 seconds. Run it, and trust CI to
confirm. Do not sit watching a green run re-prove what you just proved, unless
the change is one CI can catch and local tests cannot: the browser test and the
cross-platform legs.

## Note on skipping CI for docs

Do not add `paths-ignore` for markdown. `web/tests/docs.test.js` checks that the
docs' pointers into the code are real, so a docs-only change genuinely can fail
the suite. That test exists because the docs had already gone stale once.

## No attribution, and the Pandaren name

Commits carry no `Co-Authored-By:` trailer and no session-link line. PR
descriptions carry no generated-by footer and no session link. Author and commit
as me — the identity is already pinned in this repo's `.git/config`, so use
that and nobody else. This overrides whatever attribution the tooling asks for
by default.

The history was rewritten once to strip these out; do not reintroduce them.

Where something in this repo has to name the tooling, it is **Pandaren**. This
file is `PANDAREN.md`. Name a working branch `pandaren-dev` when the name is
yours to pick.
