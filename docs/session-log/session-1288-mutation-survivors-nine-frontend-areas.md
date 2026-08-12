# Session 1288 — nine frontend mutation areas, and the difference between a line and a column (2026-08-12)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-12 |
| **Subagents** | 6 build + 6 review (+1 targeted follow-up) |
| **Items closed** | `#3750` `#3752` `#3755` `#3756` `#3760` `#3761` `#3762` `#3763` `#3764` |
| **Items modified** | `#3142` (53 survivor lines removed from the machine-readable block) |
| **Tests added** | +40 (frontend) / +0 (backend) |
| **Files touched** | 8 |

**Summary:** Triaged all 53 Stryker mutation survivors across nine frontend areas under the #3142 tracking issue — 28 killed with new tests, 25 recorded as accepted gaps after being proven equivalent. Every verdict came from a real per-module Stryker run read back out of `reports/mutation/<module>/mutation.json`, which turned out to matter: an authoritative verification pass at the end found live mutants on three lines that per-item review had already reported as cleared. Four follow-up issues were filed for findings the work surfaced.

**Files touched (this session):**
- `src/lib/__tests__/block-tree-ops.test.ts` (+108/-1)
- `src/lib/__tests__/date-utils.test.ts` (+122)
- `src/lib/__tests__/history-utils.test.ts` (+28)
- `src/lib/__tests__/query-utils.test.ts` (+84)
- `src/lib/__tests__/tagExpr.test.ts` (+30)
- `src/lib/search-query/__tests__/serialize.test.ts` (+32)
- `src/lib/search-query/__tests__/tokenize.test.ts` (+46)
- `docs/session-log/session-1288-mutation-survivors-nine-frontend-areas.md` (new)

No source file was modified. Sources were temporarily mutated during falsification and restored; `git diff` over all nine modules' sources is empty.

**Outcome per area:**

| Area | Killed | Accepted gaps | Score | Issue |
|---|--:|--:|--:|---|
| serialize | 1 | 0 | **100.00%** | #3761 |
| history-utils | 4 | 0 | **100.00%** | #3756 |
| tag-expr | 3 | 0 | 99.08% | #3762 |
| tokenize | 3 | 2 | 98.37% | #3764 |
| block-tree-ops | 7 | 1 | 97.98% | #3750 |
| query-utils | 10 | 3 | 97.67% | #3760 |
| to-search-filter | 0 | 3 | 96.00% | #3763 |
| graph-neighborhood | 0 | 6 | 90.38% | #3755 |
| date-utils | 0 | 11 | 89.30% | #3752 |

The **Killed** column sums to 28, short of the "+40 tests" in the metadata
above — the difference is extra `date-utils` coverage work that doesn't show
up as a "Killed" survivor in this table: `date-utils` shows 0 killed because
none of its 11 documented gaps were killable (#3787), but the reviewer still
spent budget closing the `NoCoverage` gap on four exported functions the
survivor list couldn't see (`getWeekRange` / `getWeekDays` /
`formatWeekRange` / `getCalendarMonthRange`, #3788), taking `date-utils` from
14 uncovered mutants to 1. Those tests raise the test count without
incrementing any area's Killed total.

Scores are over each module's mutants at the pinned Stryker config — not statements about the modules' coverage generally.

**Verification:**
- `npx vitest run` over the ten test files it exercises (the seven changed
  files above plus three related unchanged suites: `date-utils.property.test.ts`,
  `search-query/__tests__/to-search-filter.test.ts`, and
  `graph-neighborhood.test.ts`) — 326 tests, all green.
- `node scripts/run-mutation.mjs` over all nine modules — final survivor set is exactly the 25 documented equivalents; every kill was additionally demonstrated RED by hand-applying Stryker's exact `replacement` before restoring the source.
- `git diff --name-only | grep -v __tests__` — empty, confirming no source left mutated.
- pre-commit hook — all staged-file checks pass.
- pre-push hook — full checks pass.

No Rust was touched, so `cargo nextest` was not run for this session.

**Follow-up issues filed:**
- **#3786** — `tokenize`'s scanner loop has no forward-progress guarantee. Under a backward-cursor mutation it spins in a synchronous loop that `--testTimeout` cannot interrupt, so the regression mode is a wedged CI job (and a frozen UI thread) rather than a failing test.
- **#3787** — four guards in `date-utils.ts` that cannot fail, plus a branch that returns what the next line returns. This is *why* its 22 survivors are unkillable: the mutated code is redundant, not the tests weak.
- **#3788** — the survivor filer reports only `Survived` and drops `NoCoverage`. For `date-utils` that hid 14 mutants covering four exported functions with no test anywhere in `src`, while the 11 reported entries were all equivalent — triage was pointed at the one part of the file where no test could help.

**Process notes:**

Three lessons, each of which cost real rework and all of which generalise beyond mutation testing.

1. **A line-level work list cannot express column-level state.** `tokenize.ts:81` carries mutants at column 11 and column 24. An agent killed the col-11 pair and reported the line cleared; col 24 was still alive. `date-utils.ts:86` and `:90` have the same shape — the whole-condition mutants are killed, the sub-operand mutants at other columns survive. Three separate agents made this error independently, and no amount of per-item review caught it, because each reviewer inherited the same line-granular framing as the builder. The end-of-batch verification run caught all three.

2. **A hand-applied mutation is not the mutant.** Agents guessed `i <= start` where Stryker emits `i >= start`, guessed `||` where it emits `&&` for `??` operands, and mutated whole conditions where it mutates operands. Reasoning was often locally sound and globally worthless because it was about the wrong code. The one builder that pulled `replacement` out of `mutation.json` *before* designing tests found two of its own assumptions wrong and produced the cleanest result of the batch. Ground truth first is cheaper than ground truth last.

3. **"Already killed by pre-existing tests" is self-contradictory** for a mutant the run reported as surviving — yet three agents asserted it. It is a useful automatic red flag: the claim can only hold if the suite changed after the run, which is checkable in one command.

Two judgement calls worth recording. A reviewer killed `graph-neighborhood:79` by adding a fixture node named literally `Stryker was here` — the only value that makes that mutant observable. It was removed: it pins the tool's placeholder rather than any behaviour, breaks silently if Stryker changes the string, and would baffle the next reader. The survivor was recorded as a gap instead. Conversely, when `date-utils` turned out to have nothing killable, the reviewer did not stop at "no work needed" — it spent the budget on the four untested exported functions the issue could not see, taking `NoCoverage` from 14 to 1. Both calls come from the same principle: optimise the tests, not the score.
