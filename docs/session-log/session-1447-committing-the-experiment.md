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

## The instability claim got a third data point

Running the committed harness produced:

```
row                      pre    naive      now  now/pre  naive/now  noise  verdict
latin (no sigma)        20.1     82.9     33.6    +67%      2.5x    ±16%  clears
turkish (İ)             56.8    126.0     70.4    +24%      1.8x    ±13%  clears
greek (has sigma)       93.4    161.8    112.1    +20%      1.4x     ±6%  clears
astral (pairs)          87.1    159.5    106.6    +22%      1.5x    ±11%  clears
short heading (15)       8.3     27.3     12.6    +52%      2.2x     ±9%  clears
english para (540)      47.8     69.0     52.9    +11%      1.3x    ±22%  INSIDE NOISE
greek para (504)      1479.8   2332.6   2313.5    +56%      1.0x     ±6%  clears
```

`astral` has now been REAL, then NOISE, then REAL across three runs of the same
experiment on the same code. That is exactly the claim the docblock makes about
this runner, and it is now demonstrable by anyone rather than asserted from a
transcript.

Note the direction and the coarse magnitudes reproduce cleanly every time —
`now` slower than `pre` on all seven rows, the guard paying ~2.5x on sigma-free
input and ~1.0x on a long sigma-bearing one. Only the per-row verdicts move.
Which is the whole argument for reporting bands.

## The three smaller notes

- The summary read `"beats or matches naive on every row … **and** on the Greek
  paragraph it is fractionally WORSE"`, which is a self-contradiction in one
  sentence even though the parenthetical immediately explains the rounding.
  `except` costs one word and removes the ambiguity.
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
