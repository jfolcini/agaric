# Session 1290 — the four largest mutation areas, and what a harness cannot prove (2026-08-12)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-12 |
| **Subagents** | 4 build + 4 review |
| **Items closed** | `#3753` `#3757` `#3758` `#3759` |
| **Items modified** | `#3142` (140 survivor lines removed from the machine-readable block) |
| **Tests added** | 64 (frontend) / 0 (backend) |
| **Files touched** | 6 |

Per-file line deltas are deliberately omitted — they went stale three times across the two preceding PRs as follow-up commits landed, and `git diff --numstat origin/main...HEAD` is both authoritative and always current.

**Summary:** Cleared the four largest remaining areas under #3142 — 126 mutants killed, the rest recorded as accepted gaps with proofs of equivalence. Three of the four modules gained 12–17 percentage points. The batch's distinctive output was epistemic: every equivalence claim had to survive a reviewer asking not "is this argument plausible" but "could the evidence behind it have detected the opposite", and in three separate cases the answer was no.

**Files touched (this session):**
- `src/lib/__tests__/export-graph.test.ts`
- `src/lib/__tests__/inline-property-parse.test.ts`
- `src/lib/in-page-find/__tests__/matcher.test.ts`
- `src/stores/__tests__/page-blocks.move-reparent.test.ts`
- `src/stores/__tests__/page-blocks.reorder.test.ts`
- `docs/session-log/session-1290-mutation-survivors-four-largest-areas.md` (new)

No source file was modified. Sources were temporarily mutated during falsification and restored; `git diff` over all four modules' sources is empty.

**Outcome per area** (scores read back from `reports/mutation/<module>/mutation.json` after review, not reported by the agent that did the work):

| Area | Killed | Score | Survivors | NoCoverage | Issue |
|---|--:|--:|--:|--:|---|
| inline-property-parse | 19 | 97.20% | 4 | 0 | #3758 |
| export-graph | 29 | 92.89% (from 80.75%) | 13 | 4 | #3753 |
| in-page-find-matcher | 56 | 91.32% (from 74.55%) | 21 | 8 | #3757 |
| page-blocks-move | 22 | 89.19% (from 74.32%) | 15 | 1 | #3759 |

Scores are over each module's mutants at the pinned Stryker config. The denominators again exceed the issue lists, because the filer dedupes by (line, mutator) and omits `NoCoverage`: the four issues listed 140 line-entries against 85, 46, 38 and 23 real unresolved mutants respectively.

**Verification:**
- `npx vitest run` over the changed test files — green.
- `node scripts/run-mutation.mjs` per module. `export-graph` and `in-page-find-matcher` were re-run *after* their reviewers added tests, so their figures reflect the final state rather than the builder's.
- `git diff --name-only | grep -v test` — empty.
- pre-commit and pre-push hooks pass.

No Rust was touched, so `cargo nextest` was not run for this session.

**Follow-up issues filed:** #3797 (an unreachable empty-value guard, and a reserved-key test that cannot detect changes to the list it tests), #3798 (two `export-graph` comments describing the opposite of the code — an absolute path exports as `Untitled/etc/x.md`), #3799 (`moveBlocks` has no cycle guard, unlike `moveToParent`, plus four redundant fragments), #3800 (in-page find case-folds with `toLocaleLowerCase()` and no locale), #3801 / #3802 (contracts that live only in tests).

**Process notes:**

**The most valuable review question was "could this evidence have found the opposite?"** Three equivalence arguments were backed by large differential sweeps and still failed it:

- `export-graph` argued a branch unreachable by observing `segments.length === 1` eleven thousand times and `=== 0` never. That is circular: reaching 0 requires exactly the property the lemma forbids, so the sweep is downstream of the claim rather than independent evidence for it. Replaced with an enumeration of every `return` in `sanitizeSegment`, which is strictly stronger and much shorter.
- `in-page-find-matcher` rested groups of verdicts on "U+0130 is the only expanding lowercase fold in all of Unicode". True for the default locale, and **false** under `lt` (four expand) and `tr`/`az` (none). The verdicts survived, but only because what they actually needed was weaker than what was claimed.
- `page-blocks-move` cited "722 of 3,068 inputs reached the splice" as the warrant for nine exclusions that are in fact provable by construction. The review's judgement was that the sweep number should not have been the citation at all — a shape-independent proof is better evidence than a large sample, and quoting the sample invites the reader to trust volume.

The pattern: a null result is only as strong as the harness's ability to produce a positive, and validating a harness against mutants that differ across a *half-space* says nothing about its ability to hit a single *boundary*. `tree-utils` in the previous session got this right with equality-point canaries; `page-blocks-move` got it right here, and its reviewer independently reproduced the canary counts and extended them across all 16,537 frontend tests.

**Two more pre-existing tests were found to be green for the wrong reason** — bringing this cluster's total to three. The reserved-key test in `inline-property-parse` iterates the very constant it asserts over, so it passes for any value of that constant; worse, blanking one entry still passes because the key is rejected by a length check first, not by the reserved-key logic the test names. And `in-page-find-matcher`'s "skips empty text nodes" test used `<p></p>`, which has no child nodes at all, so the filter under test was never offered anything. Both were found by mutation, not by reading — which is the argument for mutation testing in one line.

**Restraint was exercised twice, deliberately.** `in-page-find-matcher` declined to write the iframe test that would kill the `node instanceof Text` mutant, because passing it would pin a realm-fragility accident as intended behaviour; its reviewer then established the guard is unreachable by construction (the walker is built from `host.ownerDocument`, no `TreeWalker` descends into an iframe, and the app contains no iframe at all), so the restraint was right and the original "realm-fragile in production" framing was an overstatement. And a mutant in `page-blocks-move` was left alive rather than killed by a fixture built around Stryker's own placeholder string.

**The environment is part of the test.** One reviewer found that a "tripwire" test meant to detect a happy-dom deviation actually pinned *spec-correct* parser behaviour, so it would never have fired; it now pins the real deviation (`appendChild` diverting into `.content`) and says explicitly what to do when it fails. The same review found both U+0130 tests silently depend on the runtime's default locale — under `LC_ALL=tr_TR` one fails outright and the other goes vacuously green — and added a precondition assertion so that fails loudly. That locale dependence is a production bug too, filed as #3800.
