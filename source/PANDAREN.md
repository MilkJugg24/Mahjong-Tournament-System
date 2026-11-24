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

## The built page is committed, and must not go stale

`Mahjong-Tournament-System.html` at the root is what people download — there
are no releases, so the repository is the distribution.

Any change under `web/src` means `node source/web/build.js` in the same commit.
`web/tests/built-file.test.js` compares the committed page with a fresh build
byte for byte and fails if they differ, and CI asks git the same question, so
this is caught rather than shipped. Do not edit the page by hand.

Keep the build deterministic. Nothing time-dependent, random or
machine-dependent goes into the output: the moment two builds of the same
sources differ, that test has to go, and nothing is left watching the file
people download.

## The root is for people downloading

Someone arriving on GitHub should see the program and the README and nothing to
puzzle over. The root holds only `README.md`, the built page, `LICENSE` (GitHub
only shows a licence it finds there) and what git and GitHub need there:
`.github/`, `.gitignore`, `.gitattributes`. Everything else lives under
`source/`. A new file goes in there too, wherever it belongs.

The root README is for organisers. Developer and agent material goes in
`source/README.md`, which the root README points to in small print at the end.

Paths in the docs under `source/` are written from that folder, and commands
from the root of the repository.

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
