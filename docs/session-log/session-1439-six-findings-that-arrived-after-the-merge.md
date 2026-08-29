# Session 1439 — six findings that arrived after the merge

Two `agaric-reviewer` rounds landed on #4511 and #4506 minutes before each was
merged, carrying six findings nobody acted on. The convention says a merged PR's
review body is still owed a follow-up; this is it.

Every one is a comment, a doc, or a test assertion — no behaviour changes. That
is not a reason to skip them: five of the six are statements that are *false*
about code now on `main`, and the sixth is a test that asserts less than it looks
like it does.

## The one that matters: a benchmark that measured neither side

The last round of #4511 replaced three paragraphs of argument with a benchmark
table, on the grounds that "the measurement is cheaper than the comment arguing
about it". It was — but the table compared `replace`-always against the guarded
`indexOf` form, and **neither of those is what the code was before #4507**. That
was a bare string equality:

```ts
const f = ch.toLowerCase()
return f === 'ς' ? 'σ' : f
```

cheaper than both. So the table established that the guard beats the naive regex
while reading as though it established that the slow path did not regress.
Measured against the code as it actually stood:

```
latin (no sigma)      pre-#4507  50 ms   shipped 113 ms   +127% SLOWER
turkish (İ-bearing)   pre-#4507 181 ms   shipped 208 ms    +15% SLOWER
greek (has sigma)     pre-#4507 271 ms   shipped 323 ms    +19% SLOWER
```

**The slow path did regress**, by a constant factor, and the `indexOf` guard
recovers most of what the regex cost but not all of it — a lookup over one code
unit is still dearer than an equality against one. That is a real price paid for
one owner of the sigma rule, and it was worth paying; what was not defensible was
presenting numbers that made it look like a win.

The correction is the same shape as the mistake it fixes. Both rounds produced a
measurement; the first measured a comparison that flattered the change, and the
difference between them is which baseline was chosen. A benchmark is only as
honest as its control, and "replace-always" was never the control — it was a
strawman I had built two rounds earlier while arguing against the guard.

## Two comments that were simply wrong

**`İ` is not an exception to the fold distribution.** The `foldForMatch` docblock
said whole-string and per-code-point folding "produce the same result for every
input except the length-expanding İ". They agree on `İ` — it folds to `i` +
U+0307 both ways, which the harness sweep asserts and a probe confirms. `İ` goes
to the slow path because it changes *length*, breaking the offset mapping. The
sentence conflated "the folds disagree" with "the length changes" and sent a
reader hunting a discrepancy that does not exist.

**The DEV assertion's reach was overstated.** Its comment said a broken premise
"surfaces on the fast path through the wrong `needle`". True of the bug class;
false of the assertion, which sees only the *query*. A newly context-sensitive
mapping would break matching for any *text* containing it and fire here only if a
compiled query contained it too — and a bare `Σ` query, the very shape whose
fast-path miss #4507 fixed, folds identically both ways and leaves it silent.

Which is exactly why the seventeen adversarial queries added in the previous
round exist. The comment now says so, and the reviewer's framing was the sharp
part: this PR is elsewhere strict about precisely this class of overclaim.

## A test that asserted twice and covered once

The adversarial-query block asserted both a case-insensitive and a
case-sensitive compile. `compileQuery` guards the fold loop and the DEV check
behind `if (!caseSensitive)`, so the second line skips the assertion under test —
delete the DEV check outright and it still passes for all seventeen cases.

Rather than drop it, the case-sensitive path got the test it actually deserves:
four queries asserting that a case-sensitive compile leaves the query *unfolded*,
checked by matching each against itself. Falsified by splicing away the
`opts.caseSensitive ? query : foldForMatch(query)` early return — all four fail.

## And two more copies that went stale

#4506's session log still carried the `mapfile -t targets < <(…)` snippet the
workflow abandoned, with the correction three hundred lines below it, so a reader
who stopped at the first section copied the wrong form. The fix reached the
workflow, then the PR description, and never reached the log — across two further
review rounds, in a log whose subject is second copies going stale.

And `src-tauri/fuzz/README.md` introduces its listing command as "the same
command the weekly lane uses", while omitting the `| sort` the lane applies. Same
set, different order, and the claim is parity.

## What to take from it

The tally for #4506 alone now runs: a stale target table, two stale copies of one
budget number, a stale claim in a target header, a stale description snippet, a
stale sentence in AGENTS.md, and a stale snippet in its own session log. Six, in
a change whose entire purpose was removing a second copy of a list.

The pattern is not carelessness about the risk — the risk was the subject of the
work. It is that **a correction propagates to the artifact you are editing when
you notice, and stops there**. Every one of these was fixed in one place and left
in another, and the only thing that ever caught the remainder was someone else
reading the diff. Reviewing one's own change for copies is apparently not a thing
one can do; the copies are invisible precisely because you already know the fact
they state.
