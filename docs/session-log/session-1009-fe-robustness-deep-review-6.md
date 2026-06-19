# Session 1009 — /batch-issues loop: frontend robustness, batch 10 (2026-06-19)

## What happened

Tenth batch of the `/loop /batch-issues` run, built in an isolated worktree
concurrently with batch 9's backend work: five frontend correctness/robustness
findings from the multi-agent deep review, each on a disjoint file, built by five
parallel subagents and adversarially reviewed.

## Shipped

Single PR `fix/fe-robustness-deep-review-6`:

- **#1576** (MEDIUM) — TipTap StarterKit Bold (Ctrl+B) / Italic (Ctrl+I) had no
  keyboard-catalog entries, so `findConflicts()` never saw them as taken and Settings
  offered those chords as free (despite `toggleSidebar` already binding Ctrl+B). Added
  `rebindable: false` `bold`/`italic` catalog entries (`editorFormatting`, `inEditor`,
  `documentLevel: true` so they enter the cross-category conflict pass) + i18n strings,
  and gave the existing `toggleSidebar` entry the `outsideEditor` condition to model its
  real runtime guard (the window handler bails on contenteditable/inputs). A global
  action rebound onto Ctrl+B/Ctrl+I is now flagged; the editor-disjoint default pair
  stays unflagged.
- **#1561** (LOW) — the batch-undo group-size append could push onto `redoGroupSizes`
  after `reanchorAfterRemoteOps` wiped the stacks, stranding an orphan size entry that
  redo could never reclaim. Clamp the recorded size to `redoStack` capacity
  (`min(actualGroupSize, max(redoStack.length − sum(existing), 0))`), recording nothing
  when the batch was fully reanchored away. Happy-path grouping is a no-op clamp.
- **#1564** (LOW) — `jaro()`/`jaroWinkler()` indexed by UTF-16 code unit, so astral
  chars (emoji) caused lone-surrogate comparisons + inflated length, mis-scoring Cmd+K
  page-title ranking. Convert inputs to code-point arrays once (`Array.from`) and index
  length/match-window/mark-buffers/prefix by code point. BMP/ASCII scores byte-identical
  (frozen-value regression guard).
- **#1565** (LOW) — `tryNoYear`'s numeric branch always treated the first number as the
  month, so `'13/5'` (no year) rejected instead of retrying DD-MM; and `defaultYear`
  built a Date with no validity guard so Feb 29 in a non-leap year overflowed to Mar 1.
  Added the DD-MM fallback mirroring `tryAmbiguousNumeric`, and a leap-day guard that
  advances to the nearest year that holds the date — bounded to an 8-year scan so
  plausible-but-impossible inputs (`'2/30'`, `'4/31'`) reject via `isValidDate` instead
  of hanging.
- **#1560** (LOW, defensive) — the per-page store registry's `unregisterPageStore` had
  no `slot.store === store` check or re-point fallback, so a slot-owning newer provider
  unmounting first left `slot.store` referencing an unmounted store. Track `liveStores`
  per slot and re-point the canonical store to the newest survivor on out-of-order
  unmount.

## Review pass

Five adversarial reviewers, two real catches:
- **#1565 reviewer** found the leap-day guard's `while (!yearHolds) year += 1` was
  **unbounded** — plausible-but-impossible dates (`'2/30'`, `'2/31'`, `'4/31'`) passed
  the `day<=31` plausibility gate and would spin forever, hanging the app on user input.
  Bounded it to an 8-year `for` scan and added 3 loop-termination tests + 2 non-edge
  regression tests.
- **#1560 reviewer** fixed a `noUncheckedIndexedAccess` tsc error (`liveStores[len-1]`
  is `T | undefined`) with a type-safe `undefined` guard (no cast).
- **#1576 reviewer** verified against `use-sidebar-keyboard.ts` that the `outsideEditor`
  condition faithfully models the runtime guard (so suppressing the default Ctrl+B
  conflict is correct, not a fudge), and confirmed `documentLevel` entries do enter the
  cross-category conflict pass.
- **#1564** / **#1561** reviewers independently reproduced the BMP-invariance frozen
  values and the redo-invariant revert-failure, confirming real guards.

## Notes

- Files: `keyboard-config/catalog.ts`, `i18n/shortcuts.ts`, `stores/undo.ts`,
  `lib/jaro-winkler.ts`, `lib/parse-date.ts`, `stores/page-blocks.ts` (+ their tests).
  Built in worktree `wt-fe10`. Frontend-only, no Rust/codegen.
