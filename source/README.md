# Source

Everything behind `Mahjong-Tournament-System.html`, the program at the root of
the repository. Nobody running an event needs anything in this folder; the
[README at the root](../README.md) is for them.

## What is here

```
source/
├── web/
│   ├── src/          the program, as separate files
│   ├── tests/        node:test, plus a browser run against the built page
│   ├── build.js      inlines src/ into the one page at the root
│   ├── run-tests.js  runs the tests
│   └── package.json  the version number; no dependencies
├── docs/
│   ├── CODE_MAP.md         where things are, by the question you arrived with
│   ├── TECHNICAL.md        how it is built and why, and the tests
│   ├── ORGANIZER_GUIDE.md  running an event, start to finish
│   └── RULES.md            every scoring setting and the rule behind it
├── tools/
│   └── prose-check.js      flags machine-sounding habits in the docs
└── PANDAREN.md       how to work on this repository: read it before changing anything
```

**Paths in these docs are written from this folder.** `web/src/store.js` means
`source/web/src/store.js`. Commands are given from the root of the repository.

## Commands

```bash
node source/web/build.js                        # rebuild the page at the root
node source/web/run-tests.js                    # every test
node source/web/run-tests.js --not browser      # everything but the Playwright run
```

Node 20 or newer, and nothing to install. Playwright is needed only for the
browser run, and CI installs it.

## Before you change anything

- **Rebuild the page in the same commit.** A change under `web/src` means
  running the build and committing the page at the root with it. A test
  compares the committed page with a fresh build byte for byte, and CI asks git
  the same question.
- **Keep the build deterministic.** Nothing time-dependent, random or
  machine-dependent may go into the output, or that comparison stops working.
- **The CSV headers are a contract.** Organisers' spreadsheets point at those
  columns. Add a column at the end; never rename, reorder or remove one.
- **The docs are tested.** `web/tests/docs.test.js` checks that the paths and
  function names the docs cite are real, so a stale pointer fails the suite.
- **[PANDAREN.md](PANDAREN.md) has the working conventions**: commits, pull
  requests, naming, and what not to do.

## Where to start

[docs/CODE_MAP.md](docs/CODE_MAP.md). To check how a score is worked out,
`web/src/scoring.js` is the file, and its header is the place to begin.
