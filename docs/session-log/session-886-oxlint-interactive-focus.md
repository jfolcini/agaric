## Session 886 — oxlint interactive-supports-focus → error (#188 batch 3) (2026-05-29)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-29 |
| **Subagents** | 3 build + 1 review |
| **Items closed** | — |
| **Items modified** | `#188` |
| **Tests added** | +0 (focusability attributes only; assertions unchanged) |
| **Files touched** | 11 |

**Summary:** Third #188 burndown batch. Fixed all 19 `jsx-a11y/interactive-supports-focus`
violations and restored the rule from `warn` to `error`. Each `tabIndex` was chosen to match
the element's real focus model — verified by review — so no Tab order changed. Remaining
oxlint warnings after this batch: ~190 (`prefer-tag-over-role` 115, `react-hooks/exhaustive-deps`
36, `no-autofocus` 20, `no-noninteractive-element-interactions` 14 left for future batches).

**Files touched (this session):**
- `.oxlintrc.json` — `interactive-supports-focus` `warn` → `error`
- `src/components/search/FilterHelperPopover.tsx` — `tabIndex={0}` on 8 flat-menu `menuitem` buttons + the combobox input (flat, non-roving menu)
- `src/components/{BlockContextMenu,PageHeaderMenu,TabBar}.tsx`, `src/components/palette/PaletteActionMenu.tsx` — `tabIndex={-1}` on `role="menu"` containers (roving children; container is focus-target-on-open, not a Tab stop)
- `src/components/JournalControls.tsx` (`role="tab"`), `src/components/QueryBuilderModal.tsx` (`role="radio"`) — roving `tabIndex={active ? 0 : -1}`
- `src/components/TagValuePicker.tsx` — `tabIndex={0}` on the `role="combobox"` input (independent Tab stop)
- `src/components/ui/breadcrumb.tsx` — `tabIndex={-1}` on the `role="menu"` and `role="toolbar"` containers (roving inner buttons)
- `src/components/__tests__/JournalPage.test.tsx` — `tabIndex={-1}` on the `gridcell` mock (matches real render) + removed a now-redundant oxlint-disable

**Verification:**
- `npx oxlint` — 0 errors; `interactive-supports-focus` reports zero violations; no new `click-events-have-key-events` / `no-static-element-interactions` errors.
- `npx tsc -b` — no errors.
- `npx vitest run` (9 affected suites) — 431 pass.
- Technical review subagent (≠ builders) — APPROVE; verified every tabIndex against the component's focus model.

**Process notes:** Branched from post-#204 `main`. Pipelined against #204's CI per the loop.
Review surfaced a pre-existing keyboard-completeness gap (tablist/radiogroup lack arrow-key
roving handlers) — filed as a separate GitHub issue, out of scope here.

**Commit plan:** single commit, pushed, PR opened.
