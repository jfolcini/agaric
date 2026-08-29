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

## The correction that stopped one table short

Review of the correction found the same defect one paragraph lower, and it is
the most useful thing in this log.

The fix above rebaselined the **per-code-point** table against what
`foldCodePoint` actually was before #4507. It left the **per-whole-text-node**
table untouched — and that table had the identical problem. Pre-#4507
`scanLiteral` folded with a bare `text.toLowerCase()`, cheaper than either
column it compares. So `short heading, no sigma (len 15) 26 ms -> 12 ms +113%`
read as a win for the shipped code, on a call site where the shipped code is in
fact slower. Measured:

```
short heading, no sigma  (len 15)  pre-#4507   12 ms   shipped   19 ms   +56% SLOWER
english paragraph        (len 540) pre-#4507   47 ms   shipped   52 ms   +12% SLOWER
greek paragraph          (len 504) pre-#4507 1410 ms   shipped 2152 ms   +53% SLOWER
```

**Both call sites regressed**, not just the slow one. The caveat paragraph added
in the first correction was scoped to `foldCodePoint`, so it did not reach the
second table; a reader would have found an explicit warning about one table
sitting directly above another with the same flaw and no warning.

That is the honest cost accounting for #4507, and it is not a bad trade — it is
just a trade, which is what the earlier framing obscured. The fast path was
*wrong* before: it silently missed every word-final sigma. The comparison worth
making is "correct and 12–56% slower on a fold" against "fast and missing
matches", not "guarded beats replace-always".

## Three smaller ones, and a pattern that will not stop

- The comment justifying four case-sensitive tests said they were "the
  fold-changing subset of the list above". `ςσ` is not in that list, and
  `\u{10400}` was cited as a query that maps to itself — Deseret capital long I
  lowercases to U+10428, so it folds away and would falsify fine. So would `ẞ`
  and `ΑΣ`. Two wrong claims in one sentence written to justify a choice that
  was correct for a different reason: the four cover distinct *shapes*, and more
  would repeat them.
- The two benchmark tables labelled the same code `guarded` and `shipped`, up to
  11% apart, with nothing saying they were separate runs.
- The workflow snippet in session-1430 was abridged with `…` in both `::error::`
  strings. Defensible anywhere else; not in a log whose subject is second copies
  going stale, since an abridged copy is what goes stale next. Replaced with an
  outline plus a pointer to the live step.

**Four rounds of review on a change about stale second copies produced, from
me:** a benchmark against a strawman baseline, a correction to it that fixed one
of two tables, a justification with two false claims in one sentence, an
illustration that leaked a tempfile the code cleans up, and an abridged copy in
the file arguing against abridged copies.

The consistent shape is that each fix was *locally* correct and stopped at the
boundary of what I was looking at. I corrected the table I was editing, not the
one below it; the description, not the log; the log, not AGENTS.md. There is no
insight here about being more careful — I was being careful, and had the
argument for why it mattered written out in front of me. What actually caught
every one of them was a second reader with no memory of having already fixed it.
