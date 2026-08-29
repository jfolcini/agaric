# Session 1443 — a noise floor I did not measure

#4530 shipped three benchmark tables to correct two earlier wrong ones. A
review on its final commit arrived after the merge and found that the
corrections had the same defect as the thing they corrected, one level down.

## Reporting 8% as a finding when the spread was 12%

The block disclosed, in its own parenthetical, that two runs of *identical
code* differed by up to 12.5%. It then labelled `+12%`, `+15%` and `+19%` rows
`SLOWER`. Those numbers do not survive their own stated noise floor, and the
disclosure was sitting four lines above them.

Re-measured properly — one experiment, three variants, nine interleaved
repetitions with rotating order, medians, spread reported per row:

```
per CODE POINT (1M iters)      pre    naive    now    now vs pre   noise
latin (no sigma)               20 ms   82 ms   32 ms     +63%       ±24%
turkish (İ)                    56 ms  125 ms   68 ms     +22%        ±8%
greek (has sigma)              93 ms  163 ms  112 ms     +21%        ±9%
astral (pairs)                 87 ms  160 ms  106 ms     +22%        ±6%

per WHOLE TEXT NODE (150k)      pre     naive     now   now vs pre   noise
short heading (15)             4 ms    14 ms    7 ms      +53%       ±8%
english para (540)            24 ms    34 ms   26 ms       +8%       ±8%  <- noise
greek para (504)             740 ms  1108 ms 1136 ms      +53%      ±10%
```

The published `+127%` was really `+63%`. `+15%` and `+19%` were `+22%` and
`+21%`. `+56%` was `+53%`. And `english paragraph +12% SLOWER` was `+8%`
against a `±8%` floor — a row that should never have carried the label.

The conclusion holds: both call sites regressed, five of six rows clear their
noise. But every magnitude I published was wrong, in a block whose subject was
publishing wrong magnitudes.

One thing the interleaved run showed that no single run could: on a long string
that *does* contain a sigma, the guard does not help at all (1136 vs 1108,
inside noise) — the `indexOf` is paid and the `replace` runs anyway. That is a
real fact about where the guard earns its keep, and it was invisible in three
rounds of single-run numbers.

## Editing a log that was already merged

The same review caught something I had done four times without noticing:
`docs/session-log/README.md:34` says **"Never rename or edit existing files
(reviewer corrections go in the PR / issue comments, not in the log)."**

#4530 edited `session-1430`, which #4506 had already merged. Earlier rounds
appended to `session-1430` and `session-1425` while their PRs were still open —
arguably fine, the files were not yet on `main` — but #4530's edit was not.
The `session-log-numbering` guard only checks the number and the H1, so nothing
caught it.

Filed rather than fixed, because the fix is a maintainer's call between two
reasonable options: move such corrections into the *new* session's log as a
pointer, or carve out an explicit exception for correcting a statement that is
false. What is not reasonable is the current state, where the rule is written
down, is not enforced, and I broke it while writing a log about not letting
copies drift.

Two defects consequently left standing in `session-1430`: a dangling colon
("The array is now derived:" now introduces prose, not the code block), and
whatever else that hunk should have said. They stay until the convention
question is answered.

## The shape of six rounds

Across #4511, #4506 and #4530 the reviewer found, in order: a benchmark against
a strawman baseline; a correction that fixed one of two tables; a sentence with
two false claims; an illustration leaking a tempfile the code cleans up; an
abridged copy in a file arguing against abridged copies; and now magnitudes
reported below their own disclosed noise floor.

Every one was locally correct and stopped at the edge of what I was looking at.
The interesting part is that the *category* was known to me throughout — I was
writing the argument for why it matters while committing the next instance. The
only thing that ever caught one was a reader with no memory of having already
fixed it, which is an argument for review as a mechanism rather than for trying
harder.
