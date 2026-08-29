# Session 1447 — committing the experiment

#4537 merged with an approving review carrying six non-blocking notes. The best
of them is not about a number:

> The microbenchmark that produced these tables is not committed anywhere in the
> repo. Four rounds of correction have now all been litigated against an
> artifact that exists only in a session transcript, so the next reader who
> doubts a row cannot re-run it — they can only re-argue it.

That is the actual root cause of the six-round sequence, and it had gone
unnamed through all six. Every round asked whether a *number* was right. None
asked why checking a number required trusting a transcript.

## The experiment now lives in the tree

`scripts/mutation-harnesses/in-page-find-fold-cost.harness.ts`, on the #3804
convention: committed, re-runnable, outside vitest's `include` globs so it
cannot gate or flake CI.

```
npx vitest run --config scripts/mutation-harnesses/vitest.config.ts \
  scripts/mutation-harnesses/in-page-find-fold-cost.harness.ts \
  --disable-console-intercept
```

It carries `assertTableIsSelfConsistent`, which recomputes every percentage and
multiplier it prints from that row's own operands. That is the mechanical check
whose absence let four successive versions of the docblock publish ratios that
did not follow from the numbers beside them — now a committed artifact rather
than a script I ran once and described.

The `now` variant is a hand-clone of the shipped `foldForMatch`, so it is
pinned like every other clone in that directory. A cost experiment silently
measuring a stale copy would be worse than no experiment.

## The instability claim, across five runs now

The experiment has been run five times today — three while drafting, twice from
the committed harness. `astral` has been REAL, NOISE, REAL, clears, clears.
`english para` has failed to clear every time.

A caveat on that count, because review caught me miscounting it: an earlier
draft of this log and the PR body carried **two different tables**, disagreeing
in 20 of 21 cells, both introduced as "the third run" and both followed by the
same "REAL, then NOISE, then REAL across three runs" sentence. They were two
separate runs. If they are two, it is four, not three — and it is now five.
The table below is one run, from the committed harness:

```
row                      pre    naive      now  now/pre  naive/now  range  verdict
latin (no sigma)        23.0     85.2     37.7    +64%      2.3x     20%  clears
turkish (İ)             57.7    125.2     72.5    +26%      1.7x     25%  clears
greek (has sigma)       92.8    161.2    110.2    +19%      1.5x      4%  clears
astral (pairs)          86.4    161.5    102.9    +19%      1.6x      5%  clears
short heading (15)       8.8     26.9     13.0    +48%      2.1x     30%  clears
english para (540)      44.4     63.7     49.9    +12%      1.3x     17%  INSIDE NOISE
greek para (504)      1491.6   2337.7   2328.6    +56%      1.0x      7%  clears
```

Do not treat these cells as the answer — run the harness and get your own. That
is the entire point of committing it, and quoting a table in prose is what
produced six rounds of corrections.

Direction and coarse magnitude reproduce cleanly every time: `now` slower than
`pre` on all seven rows, the guard paying ~2x on sigma-free input and ~1.0x on a
long sigma-bearing one. Only the per-row verdicts move, which is the whole
argument for reporting bands.

## The three smaller notes

- The summary read `"beats or matches naive on every row … **and** on the Greek
  paragraph it is fractionally WORSE"`, a self-contradiction in one sentence.
  `except` costs one word.

  **This is the one worth recording.** An earlier revision of this log said that
  fix had been applied, and the PR body listed it as done — while the edit was
  not in the diff at all. The Python script that made it hit an assertion on a
  later substitution and exited *before writing the file*, so nothing landed; I
  then verified the tests still passed, which they did, and never verified the
  edit itself. Merging would have written a false "fixed" into a record that
  `README.md:34` forbids correcting afterwards. Review caught it by reading the
  diff against the claim — which is the only thing that can catch it.
- The old block's `"replace-always is a strawman: never a shape that shipped"`
  warning had been dropped in a rewrite. A reader skimming the prominent
  `naive/now` column had one less guardrail against reading it as a regression
  baseline — which is precisely how three earlier versions reported a
  regression as a win. Restored, and sharpened to say so.
- The PR title, `"three published magnitudes were noise"`, overstates its own
  data: of the three it names, one re-measures to noise and two were real
  effects that had been *under*-measured. It is now the squash subject on
  `main` and cannot be edited. Recording it here is the only correction
  available, which is itself an argument for checking a title against the body
  before merging rather than after.

## What did not get fixed, and why

The review also noted that `session-1443` maps five of six superseded
magnitudes, omitting the greek paragraph's `+53% → +56%` — the only row that got
*larger*, and so the one a skimmer would most want listed.

Left alone. `session-1443` is merged, and `docs/session-log/README.md:34`
forbids editing merged logs — the rule I broke four times yesterday and filed
**#4536** about. Fixing an omission in a merged log to make it more accurate is
exactly the case #4536 exists to decide, and doing it unilaterally while that
issue is open would answer the question by fait accompli. The mapping is here
instead, which is what the rule's likely intent prescribes.
