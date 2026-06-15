# Session 1033 — audit fix #1254/#1272: parseDate month-end overflow + de-vacuumed property test

2026-06-15. From the 2026-06 Opus quality audit. Shipped in the `/loop /batch-issues`
run on the validated audit bugs.

## #1254 — month-end overflow
`src/lib/parse-date.ts` had a local `addMonths` using `new Date(base).setMonth(base.getMonth()+n)`,
which JS rolls over: Jan 31 `+1m` → Mar 3 instead of Feb 28. Replaced it with the
`date-fns` `addMonths` import (the same clamping helper the sibling `date-utils.ts`
already uses). Both user-facing call sites (`+Nm` relative, `in N months` natural) now
clamp to the last valid day of the target month, including the leap-year case
(Jan 31 2028 `+1m` → Feb 29). A reviewer independently confirmed at the date-fns source
that this is genuine clamping and that no other parseDate branch has the analogous bug.

## #1272 — de-vacuum the property test
`src/lib/__tests__/date-utils.property.test.ts` had a "parseDate result is always null
or a valid YYYY-MM-DD string" property that passed even if the parser regressed to
always-null. De-vacuumed with a `nonNullCount` closure guard plus a deterministic
`PARSEABLE_SEEDS` loop that asserts non-null parsing unconditionally before the property
runs — so the guarantee no longer relies on fast-check's random branch selection.
Mutation-verified: forcing `parseDate` to always-null makes the test fail.

## Verification
`src/lib/__tests__/parse-date.test.ts` re-pinned the overflow expectation to `2026-02-28`
+ two new proving cases. Targeted: 48 tests pass. Reviewer's full frontend suite
`npx vitest run` → 12711 passed, 0 failed; `tsc -b --noEmit` exit 0.
