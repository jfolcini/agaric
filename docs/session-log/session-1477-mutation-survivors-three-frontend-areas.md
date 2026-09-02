# Session 1477 — mutation survivors in three frontend areas

The weekly mutation lane re-filed survivors for history-utils (#3756), export-graph (#3753) and agenda-sort (#3749) after a small line shift moved every previously triaged mutant to a new id. This session re-ran the three areas at the current commit, killed what a test could kill, and wrote a proof next to each mutant that no test can kill. Only the three test files changed; no source file was touched.

## Results

| Area | Survivors before | Survivors after | Killed |
|---|--:|--:|--:|
| history-utils | 3 | 0 | 3 |
| export-graph | 10 (+3 no coverage) | 9 (+3 no coverage) | 1 |
| agenda-sort | 21 (+1 no coverage) | 16 (+1 no coverage) | 5 |

Counts are Stryker's raw mutant counts from `node scripts/run-mutation.mjs <area>` before and after; the issue lists dedupe by line, column and mutator, which is why they read 3, 12 and 18. history-utils is back at 100%. The 24 that remain are all recorded as accepted equivalents (below), so the next weekly run should report nothing new for these areas once the ids are in the parent issue's accepted block.

## What the kills needed

The three history-utils mutants sit in the attachment rendering added by #4335, after session 1288 measured the file at 100%. Each mutates only the `typeof … === 'string'` operand of a guard, so the kill needs a non-string with a truthy `.length` (a JSON array), which no empty-string test could reach. The agenda-sort key mutants on line 131 survived because the existing #3845 test compared the two group keys only for inequality, which every mutant preserves; asserting the exact `special:` and `label:` strings kills all four. The export-graph mutant at 560:7 deletes the memo that stops an attachment whose read already failed from being re-read on a later page. The agenda-sort mutant at 261:15 empties the `Tomorrow` rank array; a past-dated raw group must sort before Tomorrow, and now a test says so.

## Accepted equivalents

Eleven export-graph ids and thirteen agenda-sort ids, each with a proof in the ledger comment at the end of its test file. The recurring shapes: a guard whose failing input is erased by a later step (the traversal guard on line 105 and the trailing trim two lines below), a default parameter or `??` fallback whose only call site always passes the argument, a fast path whose slow path returns the same value, a `?.` on a map key drawn from the set the map was seeded with, and a redundant `!== null` conjunct that TypeScript needs for narrowing after an earlier return already handled the null. The `Overdue: []` mutant is equivalent for an ordering reason: `NaN` comparisons coerce to zero, the sort is stable, and Overdue is already first in insertion order; its `Today` and `Tomorrow` siblings are not equivalent, and both are now killed.

The export-graph ledger was stale by three lines and carried a `NoCoverage` tag on 326:65 that no longer applies; it was renumbered to the 2026-08-31 positions and gained the 636:7 entry. agenda-sort had no ledger and now has one.

date-utils (#3752) was not touched. Its twelve survivors were proven equivalent on 2026-08-12 with a differential harness, but the file has moved since and the old ids do not map cleanly onto the current ones, so recording them needs one run of `node scripts/run-mutation.mjs date-utils` against the current commit.

## Verification

`npx vitest run` on the three files: 205 tests passing. `npm run typecheck` clean. Sources confirmed unmutated after each run.

Also this session: PR #4604 (six small Rust fixes) opened and PR #4603 (three frontend fixes) carried through two reviewer rounds.
