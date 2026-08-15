# Session 1309 — commit the mutation sweep harnesses (2026-08-15)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-15 |
| **Subagents** | 1 build + 1 review |
| **Items closed** | — (partial: `#3804`) |
| **Items modified** | filed `#3905` |
| **Tests added** | +0 (frontend) / +0 (backend) |
| **Files touched** | 6 |

**Summary:** Committed the two mutation sweep harnesses whose modules changed tonight, so
the equivalence ledgers' empirical half can be re-run rather than only read. Each carries
its validation control — the known-killed mutants it detects — which is what separates
"no differences found" from "the sweep was too weak to find any". Backfilling them also
surfaced that three ledger entries described code that no longer exists.

**Files touched (this session):**
- `scripts/mutation-harnesses/tree-utils-compute-drop-index.harness.ts` (new)
- `scripts/mutation-harnesses/page-blocks-move-reconcile-batch.harness.ts` (new)
- `scripts/mutation-harnesses/vitest.config.ts` (new)
- `src/lib/__tests__/tree-utils.mutants-drop.test.ts`
- `src/lib/__tests__/tree-utils.mutants-depth.test.ts`
- `src/stores/__tests__/page-blocks.reorder.test.ts`

**Verification:**
- Both harnesses run in under a second combined; every control asserts `> 0` differing and
  every equivalence claim asserts `0`.
- `npx vitest run src/lib/__tests__/tree-utils src/stores/__tests__/page-blocks.reorder.test.ts
  src/stores/__tests__/page-blocks-move.test.ts` — 8 files, 175 tests, all passed.
- `npx tsc -b` — clean, though see the process note below on what that does and does not mean.
- CI isolation verified empirically, not by reading the glob: `npx vitest run --config
  vitest.config.ts scripts/mutation-harnesses` and `npx vitest related --run` against the
  harness files both report "No test files found".
- pre-commit hook — all staged-file checks pass.
- pre-push hook — full clippy + push-staged checks pass.

**Process notes:**

- **Scope followed the issue's own advice rather than its title.** #3804 lists five modules
  with uncommitted harnesses, but its closing scope note says to commit them going forward and
  backfill only the ones whose modules are about to change — naming `tree-utils` (#3793) and
  `page-blocks-move` (#3799). Both landed tonight in #3887, which makes them the only
  defensible backfill targets and leaves `in-page-find-matcher` (4.4M cases), `export-graph`,
  `inline-property-parse` and `date-utils` explicitly un-backfilled.

- **The control is the whole point, so it was falsified rather than asserted.** A sweep
  reporting "0 differences" proves nothing unless the same sweep detects mutants the suite
  already kills. Review weakened each harness's generator to check the controls measure real
  discriminating power: disabling the depth-corruption injection in the `tree-utils` sweep
  dropped its `item.depth === childDepth` control from 20768 differing to **0** and reddened
  the assertion; removing `null` and `'GHOST'` from the `page-blocks-move` sweep's parent
  choices dropped its presence-check control from 6488/9811 to **0/0** and reddened both. Both
  reverted, both reproducing their original counts exactly. That is the difference between a
  control and a number.

- **Counts differ from the originals; verdicts do not.** The harnesses use a fresh generator
  rather than a reconstruction of the discarded corpus, so raw totals will not match the
  ledgers' historical figures. Each harness says so in its header and prints its own
  denominators, rather than quietly overwriting numbers it cannot reproduce.

- **Three ledger entries described code that had been deleted, not moved.** The
  `page-blocks.reorder.test.ts` ledger recorded equivalence arguments for the `byId.has`
  pre-check, the vacated-source renumber loop and a dead ternary arm — all three removed
  outright by #3799 hours earlier. Verified against `git show` of the merge rather than
  inferred from line drift, then retired with an explanation. Two other ledgers had pure line
  drift (`+2` on `computeDropIndex`, `-3` on `projectDepth`), the first of which had been
  introduced by #3887's *own* ledger update — a ledger corrected in the same PR that
  invalidated it.

  This is the decay #3804 predicted, arriving within hours rather than months. A ledger is a
  claim about code at a position; both halves rot.

- **`tsc -b` passing said nothing about the new files.** No tsconfig project includes
  `scripts/`, so the two harnesses were type-checked by nothing — and did in fact carry 6
  errors under the repo's real strict options (`noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`), found only when review built a throwaway tsconfig pointing at
  them. Fixed here; the gap that hid them is filed as `#3905`, along with the more valuable
  question of which *other* directories are similarly unexamined. A green gate and an
  unexamined one are indistinguishable from the outside, which is what makes this worth an
  issue rather than a one-line fix.
