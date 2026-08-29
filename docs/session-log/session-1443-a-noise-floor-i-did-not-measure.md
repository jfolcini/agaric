# Session 1443 — a noise floor I did not measure

#4530 shipped three benchmark tables to correct two earlier wrong ones. A
review on its final commit arrived after the merge and found that the
corrections had the same defect as the thing they corrected, one level down.

## Reporting 8% as a finding when the spread was 12%

The block disclosed, in its own parenthetical, that two runs of *identical
code* differed by up to 12.5%. It then labelled `+12%`, `+15%` and `+19%` rows
`SLOWER`. Those numbers do not survive their own stated noise floor, and the
disclosure was sitting four lines above them.

Re-measured properly — one experiment, three variants, eleven interleaved
repetitions with rotating order, medians, spread reported per row:

```
per CODE POINT (1M)     pre    naive     now   now/pre  naive/now  noise
latin (no sigma)       19.6     80.4    31.7    +62%      2.5x     ±20%
turkish (İ)            55.2    122.5    67.9    +23%      1.8x      ±5%
greek (has sigma)      90.3    159.7   108.7    +20%      1.5x      ±4%
astral (pairs)         86.0    159.6   103.6    +20%      1.5x     ±26%

per TEXT NODE (300k)      pre    naive      now   now/pre  naive/now  noise
short heading (15)        8.6     27.2     12.9    +50%      2.1x     ±3%
english para (540)       46.7     66.4     51.1     +9%      1.3x    ±11%
greek para (504)       1489.6   2284.5   2331.1    +56%      1.0x     ±9%
```

The published `+127%` was really about `+62%`. `+15%` and `+19%` were about
`+23%` and `+20%`. `+56%` was `+50%`. And `english paragraph +12% SLOWER` was
`+9%` against a `±11%` floor — a row that should never have carried the label.

## And the re-measurement needed a second pass of its own

The first interleaved run reported nine repetitions and I wrote the block from
it. Review then checked three claims against my own printed table and all three
failed: "five of six rows" when the tables have seven; "2-3x" when the rows give
1.5-2.6x; and a `4 ms -> 7 ms` row labelled `+53%` when those operands give
`+75%` — the whole-millisecond display could not represent the ratio it carried.

Re-run at eleven repetitions with decimals, and the more useful finding
appeared: **row-level verdicts are not stable on this runner.** `astral` cleared
its floor comfortably in the first run (±6%) and is buried in the second (±26%),
on identical code. `english para` failed to clear in both.

So the honest form is not a fourth table of per-row verdicts. It is: report the
band, state that rows within about twice their noise figure have flipped
between runs, and rely only on what survived both — that both call sites are
slower, and that the guard beats or matches the naive form everywhere except a
long sigma-bearing string, where it is fractionally worse — the `indexOf` is
paid for a `replace` that runs anyway.

Review caught that overreach too, in the sentence written to replace the
previous overreach: "beats `naive` on every row, from 1.3x to 2.5x", against a
table whose Greek-paragraph row prints `naive 2284.5` / `now 2331.1`. A ~2% loss,
and a `1.0x` outside the stated band, fifteen lines below the claim. Checking
each summary sentence against its own table before committing then caught two
more that review had not: `astral` is sigma-free and only 1.5x, so the
multiplier is not a sigma signal; and `latin` at +62% falls outside the "+20% to
+60%" band I had just written.

The habit that finally worked is mechanical rather than attentive: extract every
number the prose asserts, recompute it from the table's own operands, and diff.
Three rounds of trying harder produced three more wrong summaries; one script
produced none.

Three rounds of this block were wrong because each reported a single noisy run
to the percentage point. The fourth is right because it stopped reporting
percentages as though they were measurements.

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
