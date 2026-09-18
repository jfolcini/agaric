# Session 1786 — the frontend mutation lane measures again

#5103 documented #5101 as unfixable: no published `vitest-runner` re-runs tests
under vitest 5, so the lane's numbers were declared meaningless in three files.
This session replaces that with a fix, and corrects the record on the way.

## The mechanism in #5101 was wrong

#5101 blamed `resetContext()`'s `filesMap.clear()` for stopping vitest 5 from
re-collecting. Calling `start()` twice on one vitest 5 instance, with and
without that clear, runs all 24 `tokenize` tests both times. The real cause is
upstream stryker-js#6210: the runner filters each mutant run with a
`testNamePattern` regex built from suite and test names joined by `' '`, and
vitest 5 matches it against names joined by `' > '`. Nothing matches, every
test is `skip`, and a run that executed zero tests is reported survived.

`coverageAnalysis: 'all'` and `'off'` do not avoid it. The runner's setup file
records per-test coverage in every mode, so the planner sends a covering-test
filter regardless, and the regex is built either way.

## The fix, one file

`stryker.vitest.config.mjs` now has a vite plugin whose `configureVitest` hook
replaces `project.config.testNamePattern` with an accessor. Vitest calls the
hook after the project exists and before Stryker assigns the pattern, so the
setter widens each space in the regex to `(?: > | )`: it matches under either
joiner, selects a superset of the covering tests and never a subset, and stays
correct after the upstream fix lands, so removing it is tidiness rather than
urgency. It lives in the one config file Stryker alone loads; `npm test` never
sees it.

Measured before and after, same commit, same machine:

| module | before | after |
|---|---|---|
| `tokenize` (136 mutants) | 0 killed, 30 s | 127 killed, 5 timeout, 4 survived, 33 s |
| `glob-validate` (307) | 0 killed | 283 killed, 24 timeout, 0 survived, 70 s |
| `page-blocks-move` (157, `setup: true`) | 0 killed | 147 killed, 10 survived, 155 s |

## The guard that would have caught it

The #3330 liveness guard keys on mutant count, which this failure leaves
intact, so it passes a sweep in which the runner ran nothing. The guard now
also fails any module that counted mutants and killed none. Per module, not
the sweep total: static mutants still died in the fresh process Stryker gives
them, so modules with module-scope literals scored a few percent during the
outage and the total was never zero; `glob-validate`, all functions, went to
0 of 307. `src/__tests__/check-mutation-reports.test.ts` pins both arms,
including that mixed sweep; stubbing the check out turns them red.

Review caught the first draft of this checking the sweep total, which would
have stayed green on the real data.

## What #5103 left behind

The warnings it added to `AGENTS.md`, `docs/BUILD.md` and
`scripts/run-mutation.mjs` are removed; a lane that measures again must not
say it does not. `docs/BUILD.md` keeps one sentence naming the shim and when
to delete it. The `AGENTS.md` edit reverts #5103's own edit at the
maintainer's request to do better than #5103.

Still open, and not this PR's: the auto-filed survivor issues (#3766 under
#4691) hold phantom findings until the next weekly run re-renders them from a
real report.
