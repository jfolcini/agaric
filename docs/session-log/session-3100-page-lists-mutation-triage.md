# Session 3100 — page-lists mutation triage

A #5691 follow-up. The diff-scoped mutation lane kept reporting about 90 survivors in `page-lists`, page mode's list styles.

**What it was:**
- **Mostly wiring.** The module's Stryker test list held only `page-lists.test.tsx`. `page-lists.per-key.test.ts` and `page-lists.tasks.test.tsx` were never run against its mutants, so the fast paths they cover counted as survivors. That is the #3142 failure again.
  - The reviewer's sweep found the same gap twice more: `filters-model` without `model.mutants.test.ts`, and `page-tasks` without `page-tasks.gate.test.tsx`.
  - All three are now wired in, and `check-stryker-modules.mjs` passes.
- **Real gaps, now tested:**
  - a block that shows no marker breaking a numbered run;
  - blocks that all stop showing a marker at once;
  - the full leave-the-list walk on a change to several blocks;
  - the undo restore's guards: no style over one given since, a style given back and taken off again, and no `setStyle` for a plain block;
  - a change kept out of the history, as the slash picker's trigger is, keeping the redo that gives a style back.
- **Equivalent:** the test file's header groups the rest by kind, by symbol:
  - spared redraws;
  - `differsInside`'s paired nulls;
  - lazily built maps;
  - `'none'` kept as a read style;
  - id checks on blocks that always have one;
  - undo-depth comparisons.
- **Dead code:** `leave` and `leaveByUndo` drop an `if (style !== 'none')` guard. Their one caller passes only ids `leftTheirList` returns, which carry a style and are distinct after `PageBlockIds` re-mints duplicates.

**Result:** `page-lists` went from 78.0% to 91.1% of covered mutants killed (91 survivors to 36), from line-range Stryker runs on a loaded machine.

**Red first:** each new test was shown red against its mutant, one command per kill. The reviewer re-ran seven kills and got the predicted assertion each time.

**Suites:**
- vitest over `src/editor/page-mode` (851);
- the Stryker config tests and `check-stryker-modules.mjs`;
- typecheck and lint;
- Playwright: list-style-keyboard and list-marker-only-lists.
