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

## The collapse's position: one real constraint, and an argument that did not follow

It reads as arbitrary that the collapse sits last — after NFKD, after `toLowerCase`, after
`ß`→`ss`. One of those is a constraint; the rest is habit.

The constraint is **after `toLowerCase`**, and it comes from Final_Sigma: `toLowerCase` is what
*creates* the `ς` the collapse removes. `ΟΔΟΣ` contains no final sigma until Final_Sigma puts
one there, so a collapse placed ahead of `toLowerCase` matches nothing and the fold still ends
in `ς`. Measured: moving the collapse between `.normalize('NFKD')` and `.toLowerCase()` reddens
8 of the 68 fold-suite tests, all of them word-final cases.

The first version of this note argued something stronger, and wrong. It observed — correctly —
that NFKD can *produce* a literal `ς` from a character that was never a plain final sigma
(`U+1D6D3` MATHEMATICAL BOLD SMALL FINAL SIGMA decomposes straight to `ς`, in any position, with
`toLowerCase` playing no part), and concluded that the last position was necessary because "any
earlier position would miss it". That does not follow. *Every* position after NFKD catches
`U+1D6D3`, including one between NFKD and `toLowerCase`, which is earlier than last. Measured in
the same run: with the collapse immediately after NFKD, `foldForSearch(U+1D6D3)` is still `σ`.
The example supports "after step 1"; the conclusion drawn was "last".

Compounding it, `U+1D6D3` had no test at all, so the argument was unpinned in both directions:
the move above kept every case the docblock said the position existed to catch working, and
nothing would have said so. It has a test now, and that test carries a note saying what it does
*not* pin — the position — so the next reader does not re-derive the same overclaim from it.

The generalisable bit: an ordering argument is a claim about what breaks at each *other*
position, and each break has to be run. This one asserted a necessity from an example that was
true and irrelevant to it.

## The reordering residual, measured rather than waved at

`findFoldedMatch` walks the haystack one code point at a time and compares the running buffer's
*length* against offsets taken from the whole-string fold. The first draft of that safety
argument said canonical reordering was harmless because it "only permutes code points within a
fixed-length span, and length is all this loop compares".

That is true at the ends of a reordered mark run and false inside one. Reordering preserves
length but not *contents*, so a folded index landing mid-run denotes a different original offset
in the two views. Reachable whenever a folded index lands inside a reordered run — no plane
mixing required. A BMP-only example: for haystack `"A" U+0653 U+0655 "Z"` searched for `U+0653`,
the whole-string fold is `"a" U+0655 U+0653 "z"` (ccc 220 before ccc 230), `foldedIdx` is 2, and
the walk returns `{start: 2, length: 1}`, spanning `U+0655` — right length, wrong character —
where the correct span is `{start: 1, length: 1}`.

Mixing planes additionally corrupts the *length*, on top of the offset: for haystack
`"A" U+302A U+1D167 "Z"` searched for `U+1D167`, the whole-string fold is
`"a" U+1D167 U+302A "z"`, `foldedIdx` is 1 — inside U+1D167's surrogate pair — and the walk
reaches buffer length 1 having consumed only `"A"`. Running it returns `{start: 1, length: 3}`
where the correct span is `{start: 2, length: 2}`.

Pre-existing, and left unfixed rather than fenced off with a narrower claim than it can support.
The docblock's first draft called the residual reachable only "when a run mixes planes", which
is true of the length corruption but not the offset one: the offset corruption alone needs
nothing more exotic than two ordinary Arabic combining diacritics with reversed combining
classes, run rather than traced, because this file's history is that a plausible trace was wrong
about combining classes:

```
haystack code points:            [ '41', '653', '655', '5a' ]
whole-string fold code points:   [ '61', '655', '653', '7a' ]
findFoldedMatch result:          {"start":2,"length":1}
spanned substring code points:   [ '655' ]
```

Right length, wrong character: `{start: 2, length: 1}` spans U+0655 where the correct span is
`{start: 1, length: 1}`. Verified by executing the function on both inputs rather than by
reasoning about combining classes, which is just as well: the classes quoted in the note that
raised the mixed-plane case had U+1D167 *above* U+302A, which would mean no swap at all, and NFKD
demonstrably swaps them — right conclusion, inverted premise, the sort of pair that only running
it separates.

The guarantee is now stated as "reachable whenever a folded index lands inside a reordered run;
mixing planes additionally corrupts the length" rather than the first draft's narrower claim, and
the BMP case has its own pinning test — a documented residual with no test is how the
mixed-plane one drifted unpinned in the first place, and a later review pass found this same
under-claim still standing before this paragraph was consolidated to close it for good. That
later pass also retired a second stale claim sitting beside it: "no Search surface here is known
to produce such a run" was written with the musical-notation/ideographic-tone-mark pair in mind,
but ordinary Arabic diacritics are not exotic.

## Two claims from the issue that measurement narrowed

**The offset constraint does not exist, but not for the stated reason.** The issue says callers
cannot be mapping folded offsets back because the fold already changes length. Enumerating the
consumers gives a sharper answer: the only offset consumer reaches this module through
`findFoldedMatch`, which returns **original-string** offsets. No caller maps folded offsets at
all; the only code doing that mapping is inside this module, and it walks code points.

**The `ΑΣΑ` row is half-correct.** The issue lists it as already working. `ΑΣΑ` searched for `Σ`
did work; `ΑΣΑ` searched for `ς` did not. The regression guard now pins both directions.

## Four survivors, checked individually

Removing the collapse reddened 11 of the 16 new fold-suite tests, plus both consumer tests
(13 red in all). Five stayed green, and a survivor is either a genuine pre-existing guard or a
test that discriminates nothing — the distinction is not visible from the count, so each was
checked:

- the mid-word `ΑΣΑ` fold value: already correct pre-fix, pinned against an over-broad collapse;
- "does not collapse unrelated Greek letters": a negative control, correctly unrelated to this
  mutation;
- idempotence for a word-final sigma: a real but narrow property that this defect does not touch;
- "does not match sigma against Greek text that has none": a negative control;
- "the sigma constants are the code points they claim to be": by construction it cannot go red
  for this mutation — it asserts on the test fixtures, not on `foldForSearch`. It is falsified
  separately, by tampering with a constant (below).

None vacuous. Reporting "11 of 16 went red" without that breakdown would have left five tests
whose status was simply unknown.

## A third fold, deliberately left alone

Two folds in this codebase had the same Final_Sigma exposure: this one and the in-page-find
matcher, fixed separately. A third exists — the mock FTS index fold — and is **deliberately
divergent**, because it must mirror the real FTS5 tokenizer's context-free fold rather than this
one. Its docblock already names the Final_Sigma under-match as an accepted divergence, so
"fixing" it would break the thing it exists to imitate. Recorded here because a future sweep for
this defect class will find it and needs to know it is intentional.

## The escapes belonged on the inputs

The convention was to write sigmas as escapes rather than pasted glyphs, because `σ` and `ς` are
indistinguishable at a glance and which one comes out is the entire subject. The first round
applied it to the *expectations* and left the **inputs** as pasted literals —
`foldForSearch('οδος')`, a stored tag `name: 'οδος'`, `makeDef('οδος')` — which is exactly
backwards. An expectation written with the wrong sigma fails loudly. An *input* written with the
wrong sigma fails silently: normalise that final `ς` to `σ` and the surrounding assertion becomes
a tautology, green with or without the collapse. That is the failure the convention exists to
prevent, and it was left standing precisely where it bites.

Fixed on both sides now, and made tamper-evident rather than merely conventional: the fold suite
carries a constants test asserting the code points and that the two lowercase spellings of `ΟΔΟΣ`
differ only in their tail. Falsified: normalising `ODOS_FINAL`'s tail to `σ` reddens **only** the
constants test — every other case using it goes green on the tampered input, which is the point.

Each consumer test's own tamper-detector originally asserted only that its stored value and typed
query strings differ (`.not.toBe`) — enough to catch normalising one sigma to the other, but not a
swap to any other distinct pair, so "same for both consumer tamper-detectors" overclaimed parity
with the fold suite's code-point assertions. Both consumer tests now also assert
`codePointAt(3)` against the two sigma code points, closing that gap for real.

Uppercase words (`ΟΔΟΣ`, `ΑΣΑ`, `ΟΞΟΣ`, `ΑΒΓ`) stay pasted deliberately: `Σ` has one uppercase
form, so there is nothing to confuse it with and no silent weakening available.

## Verification

69 tests in the fold suite (68 plus a pinning test for the BMP reordering residual, added in a
review-response pass); 278 across it and the two consumer suites (69 + 189 + 20). `tsc -b`,
`oxlint` and `oxfmt --check` clean on the changed files.

Correction, made by actually re-running the suites rather than trusting the number already
written down: this section originally said "68 tests in the fold suite; 276 across it and the two
consumer suites." The fold-suite figure was right at the time; the combined total was not —
measured at 277, not 276, established by restoring the committed file content, running, and
`cmp`-ing back. Neither figure had been re-run before being written, which is exactly the failure
mode this session is about, and precisely the kind of number nobody was going to re-run, sitting
in a paragraph whose subject is that unrun claims rot.

The 11-of-16-fold-suite / 13-red-in-all falsification above was re-run against a copied backup in
that same review-response pass, and again in a later one, and reproduced exactly both times:
removing the collapse reddens the same 11 fold-suite tests plus both consumer tests, 13 in all,
out of the current 278 — that count was accurate from the start.

Every mutation was made against a copied backup and every restore proven byte-identical with
`cmp`: the collapse removed, the collapse moved to immediately after NFKD, each of the three
input constants normalised to the wrong sigma, and — across the two review-response passes — the
collapse removed twice more to recheck the falsification count.

## The parity claim, made true rather than softened

The two consumer tamper-detectors asserted only that the stored value and the typed query *differ*,
while the log claimed parity with the fold suite's `codePointAt` assertions. They now carry
`codePointAt(3)` assertions of their own — `0x03c2` and `0x03c3`, verified by execution rather than
by counting characters — so the sentence is true instead of trimmed.

Two smaller ones: `AddPropertyPopover.test.tsx` builds a `RegExp` from `TYPED_QUERY`, which is safe
only because that alphabet has no metacharacters, and now says so; and both consumer suites'
references read `(#4514, fixed in #4522)`, since a bisector looking for the implementing PR would
otherwise find only the issue.
