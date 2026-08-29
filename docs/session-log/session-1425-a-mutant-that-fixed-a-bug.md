# Session 1425 — a mutant that fixed a bug

#3757's remaining mutants, triaged. Twenty-five findings, seventeen already covered by the
ledger in `matcher.test.ts` under line numbers that had drifted, six newly recorded as
equivalent — and two that were not equivalent at all. Those two changed behaviour, and they
changed it toward the *right* answer.

## The two that mattered

`matcher.ts`'s literal search has a fast path and a slow one, chosen by whether the case
fold preserved code-unit length. Both surviving mutants at that branch —
`[ConditionalExpression → false]` and its `[BlockStatement → {}]` twin — mean "always take
the slow path", and both left the suite green.

The slow path folds code point at a time through `foldCodePoint`, which collapses the two
Greek sigma forms:

```ts
const f = ch.toLowerCase()
return f === 'ς' ? 'σ' : f
```

The fast path folded with a bare `toLowerCase()`, which applies Unicode's **Final_Sigma**
rule: `'ΟΔΟΣ'.toLowerCase()` is `'οδος'` — with a final `ς` that nothing then normalised.
A needle folded the same way gets `'σ'` or `'ς'` depending on where its sigma sits. So the
two sides disagreed, measured against the real module:

| text | query | result |
|---|---|---|
| `ΟΔΟΣ` | `Σ` | `[]` |
| `ΟΔΟΣ` | `σ` | `[]` |
| `ΟΔΟΣ` | `ς` | matches |
| `ΣΣ` | `Σ` | 1 of 2 |
| `ΟΔΟΣ ΤΙΣ` | `Σ` | `[]` |

Searching a Greek document for a sigma found every non-final one and none of the final
ones — silently, because searching for the visually distinct `ς` worked.

The mutants were the finding. A mutant that survives *and* repairs a defect is the
strongest signal a branch can give: it says the branch is not merely untested but is
carrying the bug, and that the code already contains its own fix on the other side.

## The fix was already written down

The doc comment above `foldCodePoint` describes this failure exactly:

> per-code-point makes them agree on `Σ`, but on its own it does NOT make them agree on
> text that already CONTAINS a final `ς` — natural Greek orthography — because
> `'ς'.toLowerCase()` is `'ς'`. Searching `ΟΔΟΣ` over `οδος` would then fold to `οδοσ` vs
> `οδος` and silently miss.

and closes with "The needle MUST use this same function, not `toLowerCase()` on the whole
string". #3812 established all of that and applied it to the slow path. The fast path — the
one essentially all text takes, since the slow path triggers only on `İ` — kept the bare
fold, which left `foldCodePoint`'s sigma rule as dead code on the path that mattered.

So the fix is the one the module already argued for: both sides fold through one
`foldForMatch`. Both sigma forms are a single UTF-16 code unit, so the collapse is
length-preserving and the `{start,end}` offsets the highlighter ranges over are undisturbed
— the constraint the module says any fold change must respect.

## The comment had it backwards

The branch carried this justification:

> The check stays length-based rather than U+0130-specific: it is also what keeps the fast
> path correct for context-sensitive but length-preserving folds such as Greek final sigma,
> which per-code-point folding would get wrong.

The reverse was true. Per-code-point folding got sigma right; the fast path got it wrong.
Worth recording separately from the code fix, because a confident wrong sentence in a
comment is what a future reader trusts instead of re-deriving — this repo has now hit that
failure mode often enough that it deserves naming rather than quietly correcting.

## Killing them was the wrong goal

Once both paths share the fold, the two mutants **still survive** — and that is now
correct. The branch became a pure optimisation, so "always take the slow path" computes the
same spans. Re-spliced post-fix to confirm: both survive, while `→ true` (always fast)
stays killed by the İ offset tests.

The right outcome for these findings was therefore not a test that kills them. A test that
killed them would have had to pin the fast path's sigma behaviour — pinning the bug as
intended. The outcome is: fix the defect, then record them as equivalent with the proof
attached.

That proof is an empirical claim, not a deduction: it needs `foldForMatch` to distribute
over code points, which holds because Final_Sigma is the only context-sensitive mapping in
the locale-free case-mapping table. Swept exhaustively rather than asserted — every code
point in twelve contexts, 13,344,768 cases, **0 differing**, with the pre-fix fold as a
control that differs on 6 of them. A bare `Σ` does not trigger Final_Sigma at all, so an
empty-context-only sweep would have proven nothing.

The context set took two passes, and the second is the interesting one. The first version
used six **adjacent** contexts — the cased letter immediately before or after — and
reported 0 differing over 6,672,384 cases. Review pointed out that this could not detect
what it claimed to: Final_Sigma scans *past* Case_Ignorable characters to find the
preceding cased letter, so `'Α.Σ'` folds whole to `'α.ς'` and per-code-point to `'α.σ'`,
and no adjacent-only context constructs that. Checked, and true — a full stop, two middle
dots, a combining acute and a soft hyphen all produce the discrepancy.

It did not change the verdict: the ς collapse erases the separated case exactly as it
erases the adjacent one. It changed what the number was worth. Six separated contexts were
added; the control now fires 6 times instead of 1, which is the measure of what the first
sweep could not see. A sweep reporting "0 differing" while structurally unable to build the
harder case is a number that reads stronger than it is — the same failure as a test whose
comment claims a kill it never makes, one section up.

The sweep is committed into the existing harness rather than run once and described, which
is the standard #3804 set for this file.

## Two things this changes that are not "fix the missing matches"

Worth separating from the bug report, because both are semantic and neither is
forced by it.

**The fix widens matching, not only un-breaks it.** On the fast path a
case-insensitive search for `ς` now also matches `σ` and `Σ`, where before that
conflation existed only on the slow path. That is intended and consistent —
regex mode already conflates them under `giu`, and the slow path has since
#3812 — but "searching for the final form now finds the mid-word form" is a
behaviour change a user could notice independently of the missing matches this
started from, and it should not arrive unannounced.

**A guard was left that survives the removal of what it guards.** The sweep's
assertions were `controlDiffering > 0` and `checked > 6_000_000`. Deleting the
six separated contexts — the ones added precisely because the adjacent six were
not enough — left `checked` at 6,672,384 and `controlDiffering` at 1, and every
assertion still passed. The structural weakness the comment directly above it
warns about could have been restored silently.

Caught in review, not here, and it is the same defect as the test two sections
down that claims a kill it never makes: an assertion whose passing is
insensitive to the thing it exists to hold. Now pinned to the exact derived
count (`toBe(6)` — Final_Sigma fires in exactly six of the twelve contexts, a
number derivable rather than observed), plus a separate counter for the
separated family and the context count itself. Falsified by deleting those six
contexts: `expected 1 to be 6`, where the previous assertions stayed green.

## A test that said it killed a mutant, and did not

`length-preserving folds use whole-string folding, not per-code-point folding` opened with:

> Kills matcher.ts:231:7 [ConditionalExpression → false] and 231:40 [BlockStatement → {}]

It never did. Both were spliced at their exact offsets and the suite stayed green. The
reason is structural: the test searches for `ΑΣ` inside `ΑΣ`, and a query finding *itself*
is symmetric — the fast path folds both sides to `ας`, the slow path folds both to `ασ`,
both match. No self-search can separate the two paths.

The comment has been corrected in place rather than deleted, since "this test does not do
what it says" is more useful to the next reader than a silently retitled test. Discriminating
cases need the text and the query to disagree about whether their sigma is word-final;
the four new `#4507` tests do, and three of them fail against the unfixed module (the
fourth guards the case-SENSITIVE path against the fix leaking into it, and passes both
ways by design).

## Line numbers as identity, for the third time

Section D's citations were refreshed once already (#3804, `301` → `430`). This report
arrived with all of section A drifted ~124 lines. The numbers are now stale *again*, since
this change moved everything below `compileQuery`.

Rather than refresh them a third time, the ledger now says to read the construct and gives
a mapping table from each report's `line:col` to the construct and section. All 25 findings
were matched that way and every one landed. Provenance, not identity.

The same pass resolved a sub-mutant ambiguity the ledger had only documented for the `&&`
chain: `v == null || v.length === 0` has both the whole `||` and its left operand starting
at the same column, so "520:11 survived" names four possible mutants. All four were
spliced; only `v == null → false` survives, exactly the section A claim. The other three
die with 21, 1 and 21 failing tests.

## A guard with a blind spot

`scripts/check-mutation-harness-clones.mjs` fired correctly when `foldCodePoint` changed —
that is the guard working. But while re-syncing, both new pins were briefly left as
`sha256=PLACEHOLDER_A` / `_B`, and the guard reported **`OK: 12 source-pin(s) ... all
match`**. Its marker regex requires `sha256=([0-9a-f]{64})`, so a malformed pin does not
fail — it stops being recognised as a pin at all and is skipped silently.

A typo in a pin therefore disables that pin rather than breaking the build, which is the
one failure mode a drift guard must not have. Filed as #4509; not fixed here, where it
would be unrelated to the diff.

## The comment that cited a guard which did not guard

Review found two prose defects, and the second is the one worth keeping.

The smaller: a sentence had been spliced mid-line into the `foldForMatch` doc
block, leaving a 135-character line in an otherwise ~85-column comment. oxfmt
does not reflow comments, so nothing would have rewrapped it. Same class as the
splices the previous round caught — my edits matching only the first line of a
multi-line comment.

The larger: `matcher.ts` gained a paragraph narrating this PR's own review
history — *"An earlier revision of the paragraph above claimed that role for the
`foldedNeedle === ''` assertion… The claim was wrong in the direction that
matters"* — sitting between a future reader of `compileQuery` and the rule they
came for. It is accurate; it is just in the wrong file, and this PR already adds
this log.

Here is the history, where it belongs. An earlier revision claimed that
`scanLiteral`'s `foldedNeedle === ''` assertion was what would notice if the
distribution premise stopped holding. It does not do that job, in two
independent ways: it tests **emptiness**, not equality with `needle`, so a
broken premise leaves it silent; and it sits on the **slow** path, while a
broken premise surfaces on the fast one, through the wrong `needle`. The fix
was to write the assertion the comment described rather than delete the
sentence — a DEV-only equality check in `compileQuery`, which is the only guard
on the premise that runs in CI (the exhaustive sweep lives in a harness outside
vitest's `include` globs, by the #3804 convention).

What stays in the source is that rule and the two constraints that make it the
right shape — compare the folds rather than test emptiness, and site it on the
compile seam rather than the slow path — because those are what a future editor
would otherwise undo. What moved here is why the previous version was wrong.

The distinction is worth naming, because "record the correction next to the
code" and "do not narrate the review in the source" pull in opposite directions
and both are right. The test is whether a reader who has never seen the PR needs
the sentence: they need *"compare, do not test emptiness, and here is why"*;
they do not need *"an earlier revision of this comment said otherwise."*
