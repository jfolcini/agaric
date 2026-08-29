# Session 1459 — the review that verified the hashes still found two mismatched claims (#4507, PR #4541)

## Context

Third approving review on PR #4541. This one did what no previous round had:
extracted both pinned symbols by hand, applied the guard's `canonicalize`, and
recomputed both sha256s against the tree, then re-derived every published cell
from its own operands. Everything it checked mechanically came back correct.

It still found six things. Three were new, and two of those are the same defect
class this PR is about — a claim that does not match what it describes.

## An assertion message stricter than its assertion

```ts
expect(r.now, `${r.label}: shipped fold should not be FASTER than pre-#4507`)
  .toBeGreaterThan(r.pre * 0.95)
```

The message forbids being faster; the bound tolerates being 5% faster. The
`0.95` is deliberate calibrated slack and is documented as such six lines
above — so the number is right and the sentence describing it is wrong. Worth
noticing that this survived four review rounds *and* my own adversarial re-read,
because both halves are individually defensible and only the pairing is false.
Now: "should be within 5% of, or slower than, pre-#4507".

## The last transcript-only citation, in the block written to remove them

`matcher.ts` still read "a previous run of this identical experiment had
`astral` clearing comfortably (range 6%)". Three runs are now in the tree and
none of them is that one — it exists only in a session transcript, which is the
exact thing committing the harness was meant to end.

The fix did not need a re-run, because both directions were already in the tree:
the docblock's own table has `astral` buried (+20% against 26%) and
`session-1451` has it clearing (+21% against 5%). Same code, same experiment,
opposite verdict, both openable by a reader. The six-run count stays, now with
which three are checkable and why the others are not.

## A budget stated, not silently exceeded

`greek para` costs ~112 s of a ~130 s file (11 reps x 3 variants, plus a
200k-iteration warm-up against a 300k measured loop). The config allows 300 s,
so a host about 2.3x slower fails on timeout and prints **no table** — the worst
possible outcome for a file whose pitch is "do not trust these cells, run it".

Left the methodology alone and documented the budget instead: capping the warm-up
or dropping `reps` would buy headroom by making every published figure noisier,
and re-measuring would restart the transcription churn. The header now says what
a timeout means, so it is diagnosable rather than mysterious.

## What was NOT fixed, and why the rule decided it

The review found that `session-1447`'s table is introduced as coming from the
committed harness but is **hand-reformatted**: `renderTable` pads the label to
22 columns, so `latin (no sigma)` is followed by exactly 11 spaces before its
first value. `session-1451` has 11 and is genuinely verbatim. `session-1447`
has 8.

Verified and true, and it is one more instance of the move this PR exists to
end. It was still not fixed, because `docs/session-log/README.md:34` does not
merely forbid editing logs — its parenthetical says where the correction goes:
*"reviewer corrections go in the PR / issue comments, not in the log."* A
reviewer found an error in a log; the rule names the destination, and it is not
the log. Recorded in the PR body instead.

That is the first time in this sequence the rule has been applied rather than
broken or worked around, and it is worth noting that the rule was easy to follow
once I read the parenthetical as instruction rather than as rationale. #4536,
which asks what to do about merged logs, is unaffected — this one is unmerged
and the rule still answers it.

## Round count

Five review rounds. The findings are converging in severity — round 3 landed a
missing pin and a broken tolerance, round 5 landed a wrong sentence and a stale
citation — but not in number. Repeats are now appearing: the unchecked renderer
and the three-variant noise floor (#4543) have each been raised twice and are
already recorded. Absent something blocking, this is the last correction round.
