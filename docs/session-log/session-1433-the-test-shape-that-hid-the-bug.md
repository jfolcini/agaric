# Session 1433 — the test shape that hid the bug

#4514. `foldForSearch` ends in a whole-string `.toLowerCase()`, which applies Unicode's
context-sensitive Final_Sigma rule, so the fold produces `ς` word-finally and `σ` elsewhere and
a needle folded the same way disagrees with the haystack. The fix is one appended
`.replace(/ς/g, 'σ')`. Almost everything interesting here is about the test, not the fix.

## The rule was being followed, and it was not enough

The function's docblock said to apply it to **both** sides of the comparison, and that rule was
being obeyed everywhere. It is necessary and not sufficient, and the docblock read as though it
were both.

Folding both sides only lines up for a **context-free** fold. Final_Sigma is context-sensitive:
the same `Σ` folds differently depending on what surrounds it, so the same character folded on
the two sides can produce different bytes. That is why the bug survived a rule scrupulously
applied — and why the collapse is the thing that restores context-freedom rather than a patch on
top of it.

## The natural test formulation is green over the live bug

The acceptance case is "`ΣΣ` searched for `Σ` finds both sigmas, not one". The obvious way to
write it is a walk: find a match, slice past it, find the next.

That walk reports `[0, 1]` **before and after the fix**. Slicing past the first match makes the
trailing `Σ` the head of a brand-new string, where Final_Sigma's "preceded by a cased letter"
condition no longer holds, so it folds to plain `σ` regardless. The test does not discriminate
the defect at all — it would have shipped green over exactly the bug it was written for.

Scanning the whole folded string instead reports `[0]` pre-fix and `[0, 1]` post-fix. Same
assertion, same acceptance criterion, and only one of the two formulations is a test.

Worth generalising: when a fold is context-sensitive, **any** test that re-folds a fragment in
isolation has destroyed the context that carries the bug. The re-slice looked like an
implementation detail of iteration and was the whole experiment.

## The collapse's position is necessary, not just sufficient

It reads as arbitrary that the collapse sits last — after NFKD, after `toLowerCase`, after
`ß`→`ss`. It is not. NFKD can *produce* a literal `ς` from something that was never a plain
final sigma: `U+1D6D3` MATHEMATICAL BOLD SMALL FINAL SIGMA decomposes straight to `ς`.

Because the collapse matches on literal content rather than on "did `toLowerCase` just apply
Final_Sigma", the last position catches that too. Any earlier position would miss it. This came
out of review probing the ordering rather than accepting it, and it is now in the docblock.

## Two claims from the issue that measurement narrowed

**The offset constraint does not exist, but not for the stated reason.** The issue says callers
cannot be mapping folded offsets back because the fold already changes length. Enumerating the
consumers gives a sharper answer: the only offset consumer reaches this module through
`findFoldedMatch`, which returns **original-string** offsets. No caller maps folded offsets at
all; the only code doing that mapping is inside this module, and it walks code points.

**The `ΑΣΑ` row is half-correct.** The issue lists it as already working. `ΑΣΑ` searched for `Σ`
did work; `ΑΣΑ` searched for `ς` did not. The regression guard now pins both directions.

## Four survivors, checked individually

Removing the collapse reddened 10 of the 14 new tests. Four stayed green, and a survivor is
either a genuine pre-existing guard or a test that discriminates nothing — the distinction is
not visible from the count, so each was checked:

- the mid-word `ΑΣΑ` fold value: already correct pre-fix, pinned against an over-broad collapse;
- "does not collapse unrelated Greek letters": a negative control, correctly unrelated to this
  mutation;
- idempotence for a word-final sigma: a real but narrow property that this defect does not touch;
- "does not match sigma against Greek text that has none": a negative control.

None vacuous. Reporting "10 of 14 went red" without that breakdown would have left four tests
whose status was simply unknown.

## A third fold, deliberately left alone

Two folds in this codebase had the same Final_Sigma exposure: this one and the in-page-find
matcher, fixed separately. A third exists — the mock FTS index fold — and is **deliberately
divergent**, because it must mirror the real FTS5 tokenizer's context-free fold rather than this
one. Its docblock already names the Final_Sigma under-match as an accepted divergence, so
"fixing" it would break the thing it exists to imitate. Recorded here because a future sweep for
this defect class will find it and needs to know it is intentional.

## Verification

95 tests across the fold suite and its offset and filter consumers. `tsc -b` clean; `oxlint` and
`oxfmt --check` clean on both changed files.

The fix was falsified against a copied backup with the restore proven byte-identical, and every
sigma form in the tests is written as an escape (`Σ` / `σ` / `ς`) rather than a
literal, because which lowercase form comes out is the entire subject and the three are
confusable by eye.
