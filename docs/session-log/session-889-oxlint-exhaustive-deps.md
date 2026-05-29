## Session 889 — oxlint react-hooks/exhaustive-deps → error (#188 batch 6) (2026-05-29)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-29 |
| **Subagents** | 6 build (+ pending review) |
| **Items closed** | — |
| **Items modified** | `#188` |
| **Tests added** | +0 (dep-array corrections + justified disables; no new tests) |
| **Files touched** | 28 |

**Summary:** Sixth #188 burndown batch — the behavior-sensitive one. Resolved all 36
`react-hooks/exhaustive-deps` warnings across 28 production files and restored the rule to
`error`. Per-site judgment (per maintainer's "proceed carefully" decision): **add the dep**
where it's a stable reference fixing a real stale-closure (e.g. `setFocusedIndex` setter,
`zoomToRoot` empty-dep callback, `pageStore` StoreApi, `debounced` memoized callback, ref-object
props, `store` per-pageId); **justified `oxlint-disable`** where the dep is intentionally omitted
(version-bump recompute triggers behind ref-backed caches, signature-keyed batch refetches,
mount-only hydration, self-cancelling guard state, month-keyed fetches). Remaining oxlint
warnings after this batch: ~115 (just `prefer-tag-over-role` left).

**Files touched (this session):** 28 — hooks (useBacklinkResolution, useListKeyboardNavigation,
useKeyboardNavigableList, useGraphSimulation, useDuePanelData, useBlockPropertiesBatch,
useBlockDatePicker, useBatchProperties, useBatchAttachments, useLocalStoragePreference) +
components (App, BlockListItem, BlockPropertyDrawer, BlockTree, StaticBlock, PageHeader,
PageBrowser, ViewDispatcher, CommandPalette, GraphFilterBar, ResultCard, SearchAutocomplete,
AutocompletePopover, LinkedReferences, ConfirmDialog, BlockHistoryItem, JournalCalendarDropdown)
+ stores/page-blocks.ts + `.oxlintrc.json` (rule → error).

**Verification:**
- `npx oxlint` — 0 errors; `exhaustive-deps` reports zero violations.
- `npx tsc -b` — no errors.
- `npx vitest run` — **full suite: 469 files, 10921 tests, all pass** (chosen as the decisive arbiter since exhaustive-deps fixes can introduce render loops; a clean full run confirms none).

**Process notes (important):** The 6 build subagents ran in PARALLEL in the SAME working tree,
and at least one used `git stash` — a GLOBAL operation that swept up the other subagents'
concurrent edits into stashes, scrambling the tree (only 12 of 28 files remained modified;
the rest landed in `stash@{2}`). Recovered by checking the 16 A/C/D/F files out of `stash@{2}`
onto the tree's intact B/E edits, then treating the full green verification (oxlint + tsc +
10921 tests) as the source of truth rather than stash provenance. **Lesson: never run parallel
build subagents that may `git stash` in a shared working tree — use isolated git worktrees (or
run sequentially) for multi-subagent batches that touch the tree.** Disable directives for
`exhaustive-deps` must sit on the line immediately before the dependency array (oxlint anchors
the diagnostic there, not at the hook call).

**Commit plan:** single commit (verified state captured first), then review gate, then push + PR.
