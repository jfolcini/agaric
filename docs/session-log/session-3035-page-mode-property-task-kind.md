# Session 3035 — The page-mode property test learns that a task is a list kind

`page-mode.property.test.ts` started failing on most seeds in CI, on two unrelated PRs (#6168 and #6170), always at `expectListsHeld`. Its counterexamples:
- a bullet block, then a typed `[ ] ` (case 1);
- the same in the bullet block Enter made (case 2).
In both, the editor's model kept the bullet and the backend had none.

**The product was right; the test's model was stale.** #6167 made a task the third list kind. A typed checkbox commits through `commitCheckboxState`, which sets the task state and then clears the block's list style. The real editor's `bringIn` re-reads the list styles afterwards, so it shows no bullet either. The property's harness ran the same commits but never re-read the styles into its `PageLists`. The `refuse` flags in the counterexamples (refused block creates) play no part: the case fails the same with all of them off.

**Changed (test only):**
- `commitAndCycle` re-reads the page's list styles after the commits, as `bringIn` does.
- It now also checks that a committed task marker took the block's list style off. That pins the #6167 rule in the property instead of only mirroring it. Disabling the product's `clearListStyles` call turns that check red.
- Both CI counterexamples are pinned in `EXAMPLES`, exactly as found. Example steps may now carry a `refuse` flag; existing examples are unchanged.

**Reds:**
- Each pinned example fails with the CI assertion when the re-read is removed: example 1 alone, then example 2 with example 1 deleted.

**Suites:**
- vitest over page mode, the editor components and hooks (4,587 tests);
- the property file 5 times unseeded;
- typecheck and lint.
