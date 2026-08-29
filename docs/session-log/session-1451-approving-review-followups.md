# Session 1451 — acting on an approving review's non-blocking notes (#4507, PR #4541)

## What happened

PR #4541 (commit the `foldForMatch` cost experiment) got an **approving** review
on head `9384306` carrying eight non-blocking notes. Approval plus "non-blocking"
is the point at which the cheap thing is to merge and file the rest. Three of the
eight were worth landing before the squash, and two of those are the kind that
only look small.

## The pin that was not there (note 1)

`in-page-find-fold-cost.harness.ts` hand-cloned `const FINAL_SIGMA_RE = /ς/g`
from `matcher.ts:412`, and both the `naive` and `now` variants close over it —
but the file carried only a `#foldForMatch` pin.

The failure mode is specific and silent: change the *pattern* in `matcher.ts`
without touching `foldForMatch`'s body, and the function pin stays green while
this harness goes on measuring the old regex. A cost experiment measuring a
stale copy is worse than no experiment, which is the sentence already in this
file's own header — it just did not cover everything the file clones.

The sibling `in-page-find-matcher-folded-scan.harness.ts:64` has pinned this
exact const since #3953. Adding the marker took the tree from 16 pins to 17, and
the guard validated it against `matcher.ts` rather than accepting it — the pin is
satisfied, not merely well-formed.

Worth naming why this was missed: the previous round's review confirmed "the
clone guard is genuinely enforced" and "the source pin canonicalises the
`foldForMatch` body". Both true. Neither asks whether the file clones anything
*else*. A green guard answers "do the pins match?", never "are the pins
complete?" — and nothing in the tooling asks the second question.

## The tolerance that argued against itself (note 2)

`assertTableIsSelfConsistent` had, five lines apart:

```ts
const roundingSlackPct = 0.5 + 100 * (0.05 / r.pre + (0.05 * r.now) / r.pre ** 2)
...
).toBeLessThan(0.05)
```

The first line, and the comment above it, exist because the previous round's
review showed a fixed bound false-fails the fastest rows — the rounding error is
relative to the operands. The second line is a fixed bound, on the same table,
for the same reason. The fix from last round was applied to the assertion that
was named and not to its neighbour of identical shape.

Propagated through a ratio the error is `0.05 * (1 + naive/now) / now`, which
exceeds 0.05 once `now` falls to a few ms. `short heading` is ~13 ms here, so a
host four or five times quicker reports "printed naive/now does not follow from
printed naive and now" about a table that is fine — a self-consistency check
whose own failure mode is a false accusation of inconsistency.

## Labels (notes 5 and 6)

`spreadPct`'s docstring states that writing a full peak-to-peak range as `±`
overstates the band about 2x, and that is why the column renders as `range`. The
same file's header then wrote `±6%` and `±26%`, and `matcher.ts` still headed
both tables `noise` with `±`-prefixed cells — so a reader following the newly
added invocation from the docblock to the harness got a differently defined
column under an adjacent name. No number changed; both are relabelings of
figures that were already peak-to-peak. The harness header also gained the
`--disable-console-intercept` flag the other two copies of the invocation carry.

## A sixth run, and a claim that did not survive it

Re-running after the edits produced **7 of 7 rows clearing**, `english para`
included, at +11% against a 10% floor:

```
row                         pre     naive       now   now/pre  naive/now   range   verdict
latin (no sigma)           22.0      83.7      36.6      +66%       2.3x      8%   clears
turkish (İ)                57.3     125.3      71.6      +25%       1.7x      6%   clears
greek (has sigma)          92.6     162.6     110.2      +19%       1.5x      4%   clears
astral (pairs)             85.5     159.6     103.7      +21%       1.5x      5%   clears
short heading (15)          8.7      26.8      13.0      +51%       2.1x      2%   clears
english para (540)         42.1      61.6      46.6      +11%       1.3x     10%   clears
greek para (504)         1463.4    2252.3    2260.1      +54%       1.0x      6%   clears
```

The docblock's parenthetical said `english para` "failed to clear in both" runs
and offered it as the standing example of a row that never clears. Six runs in,
it has flipped too. The direction and coarse magnitude have reproduced in every
single run; only the verdict column moves. That is the thesis of the block
getting stronger, not weaker — but the sentence illustrating it had become
false, so it was corrected in place rather than left to be quoted later.

The table itself was **not** re-transcribed. Six runs have produced six tables
and re-copying the newest one each time is how this sequence generated four
rounds of wrong numbers; the docblock now carries the invocation, so the
authority is the harness and the printed table is an example.

## Left standing, with reasons

- **Note 3** — `noisePct` is the max spread across all three variants including
  `naive`, while `deltaPct` uses only `pre` and `now`, so a noisy `naive`
  inflates a floor for a delta it is not an operand of. Real, and it fails
  safe: it can only mislabel a real effect INSIDE NOISE, never the reverse.
  Fixing it changes the verdict column on every published row, which means a
  re-run and a re-transcription of both tables — the exact churn above. Filed as
  #4543 with the two-floor fix written out.
- **Notes 4 and 7** — both are about claims in the PR body outrunning the
  artifact (the recompute check "cannot catch a transcription error, because
  nothing is transcribed"; the body's table not being the harness's output, and
  still saying "three runs"). Fixed in the body before the squash, since this
  repo squashes PR text onto `main` and #4537's lesson was to check the text
  against its body *before* merging rather than record the mismatch after.
- **Note 8** — `median` returned the upper-middle element for even-length
  input. Safe at the `reps = 11` default but `reps` is a parameter, so it was
  fixed rather than filed; no published figure changes.

## The transferable bit

Two of the three landed notes (1 and 2) are the same shape: a fix applied
correctly to the instance a review named, while an identical instance five lines
away or in a sibling declaration went untouched. Both were invisible to every
check in the repo, because both files were green — the guard matched the pins
that existed, and the assertion passed at this runner's speeds. When a review
names a defect, the cheap follow-up question is not "is it fixed?" but "where
else does this exact shape occur?", and neither the test suite nor the pin guard
will ask it.
