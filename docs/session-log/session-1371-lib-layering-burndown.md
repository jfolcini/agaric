# Session 1371 — Lib-layering baseline 20 → 13, and the second-order violation a move would have created (2026-08-21)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-21 |
| **Subagents** | one builder, one adversarial reviewer (no self-review) |
| **Items closed** | — (**#4006 stays open**: 7 of 20; see the re-scope comment on it) |
| **Items modified** | `#4006` |
| **Tests added** | +0 — this is a pure-move refactor; the proof is that the existing suite is unchanged and green |
| **Files touched** | see PR #4227's file list |

**Summary:** #3121 step 3. The guard has enforced `lib/ (0) <- stores/ (1) <- hooks/ (2) <-
components/ (3)` since step 2 and the count can only go down, but nobody was driving it
down. Four of the issue's five fix shapes are mechanical; those are done, and the
remaining thirteen entries are not moves but decisions, so they are left with the
decisions written out on the issue rather than guessed at overnight.

**The most interesting thing here is a violation that did not happen.** Shape B moves
`nav-items.ts` from `components/common/` to `lib/` — `NAV_ITEMS` is data, not a component,
and the move clears two baseline entries at once. But the file imports `type View` from
`@/stores/navigation`, which is legal from `components/` (3 <- 1) and illegal from `lib/`
(0 <- 1). Moving the file alone would have traded one violation for another, and the
baseline would have shown a win. `View` now lives in `src/types/view.ts` with the store
re-exporting it unchanged.

**What moved**

- **A, type-only:** `AutocompleteItem` -> `src/lib/autocomplete-item.ts`; `AgendaFilter` ->
  `src/lib/filter-dimension-metadata.ts` (co-located with `AgendaFilterDimension`, which it
  already depended on); `SearchSheetMode` -> `src/types/search-sheet-mode.ts`;
  `EditorSurfaceProps`/`EditorSurfaceComponent` -> `src/types/editor-surface.ts`.
- **B:** `nav-items.ts` -> `src/lib/`, plus `View` -> `src/types/view.ts`.
- **C:** `getWeekStartDay` -> `src/lib/preferences.ts`, beside the `WEEK_START_PREFERENCE`
  definition it wraps.
- **D:** `render-keyboard-shortcut.tsx` renders real JSX (`<KbdChord …/>`), so it is a
  component and belongs in `components/common/`. Moved with its test.

Every lower-tier consumer was rewired to import **directly** from the new home; the
re-exports left behind serve only same-or-higher-tier consumers, which is always legal.
All six moved symbols are plain `interface`/type-alias declarations — no enum, no const
object — so no runtime dependency direction changed.

**The review corrected the report, not the code.** Verdict was ship, and every one of the
seven baseline removals is a genuine tier-legal fix rather than a relocation out of the
guard's view. But three of the builder's eight self-reported importer denominators were
wrong: `AutocompleteItem` 2 -> **3**, `AgendaFilter` 3 -> **4**, `View` 6 -> **8**. Each
gap is a file that uses the symbol internally beyond its re-export line. No importer was
actually left broken — the re-exports cover them regardless of whether they were counted,
and `tsc -b` plus the full suite are green — so this was a counting defect, not a
functional one. The numbers here are the reviewer's independently derived ones.

Worth naming that the largest gap, `View` at 6 vs 8, lands on precisely the move the
builder flagged as its own catch. A self-audit is least reliable exactly where it feels
most thorough.

**Verification:** `check-lib-layering.mjs` → `OK: 13 baseline layering violation(s), no new
violations, no stale entries`; its `--self-test` all 13 assertions pass;
`check-import-cycles.mjs` → `1638 modules scanned, 0 import cycles`; `tsc -b` clean;
`vitest run` → 777 files, 17692 passed, 1 expected fail.

**Filed:** `#4226` — the guard excludes `src/types/**` on the premise that it is type-only,
and nothing enforces that premise. This PR makes "move it to `src/types/`" the standard
fix for a type-only edge, which widens that door at the same time as it documents it.

**Commit plan:** single commit on `claude/fe-lib-layering-burndown`, shipped as PR #4227.
