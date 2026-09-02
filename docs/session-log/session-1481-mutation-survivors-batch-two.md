# Session 1481 — Mutation survivors, second frontend batch

Continues session 1477's work on the weekly Stryker lane's survivor list (#3142), taking the next three child issues: date-utils (#3752), tree-utils (#3765) and page-blocks-move (#3759).

Every mutant in the three lists was read against the current source and put in one of three bins. Killable: a test now pins it, and each new test was shown red against a hand-applied copy of the mutation before the copy was restored. Equivalent: the mutated program cannot be told apart from the original by any caller, with a one-sentence proof in the test file's ledger. Gap: observable in principle, not worth a test today, recorded with the input that would falsify it.

Two findings worth keeping. In date-utils, the fractional-month assertion was true for two reasons: the old `'2026-1.5-05'` input passed the integer guard and the range guard alike, so forcing the guard true did not move it; `'2026-2.5-05'` isolates the integer arm and the test is now `Jan 5`. The `101:40` round-trip mutant is killable only under vitest's default forks pool, because a worker thread ignores `process.env.TZ`; Stryker's vitest runner hard-codes threads, so that mutant stays a lane-only survivor with a committed test that kills it under `npm test`. Also, this session's first local Stryker runs, taken while a cargo build shared the box, reported 42 timeouts in date-utils; the same lane in CI reports none. Stryker timeouts in CI are almost all hit-limit ones (a mutant that loops past a hundred times its dry-run count), which are honest kills. Local mutation runs should not overlap a heavy build.

Shipped: strengthened and corrected tests in `date-utils.test.ts`, `tree-utils.mutants-drop.test.ts`, `page-blocks.move-reparent.test.ts` and `page-blocks.reorder.test.ts`; 19 accepted-equivalent lines and two accepted gaps for #3142. Production files unchanged.

Verified: `npx vitest run` in the worktree, 804 files, 18483 passed, 1 expected fail, 37 skipped; oxlint, oxfmt and `tsc -b --noEmit` clean on the four files.
