## Session 885 — oxlint control-has-associated-label → error (#188 batch 2) (2026-05-29)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-29 |
| **Subagents** | 3 build + 1 review |
| **Items closed** | — |
| **Items modified** | `#188` |
| **Tests added** | +0 (existing tests preserved; accessible-name additions only) |
| **Files touched** | 12 |

**Summary:** Second #188 burndown batch. Fixed all 25 `jsx-a11y/control-has-associated-label`
violations and restored the rule from `warn` to `error`. 6 production components got
descriptive accessible names; 19 test-fixture controls got matching `aria-label`s with no
assertion changes. Remaining oxlint warnings after this batch: ~209 (large clusters
`prefer-tag-over-role` 115, `react-hooks/exhaustive-deps` 36, `no-autofocus` 20,
`interactive-supports-focus` 19, `no-noninteractive-element-interactions` 14 remain).

**Files touched (this session):**
- `.oxlintrc.json` — `control-has-associated-label` `warn` → `error`
- `src/components/ChoiceValuePicker.tsx` — `aria-label={choice}` on choice checkbox
- `src/components/GraphFilterBar.tsx` — tag checkbox wired to its visible `<span>` via `aria-labelledby` (preserves the UX-270 no-`aria-label` contract while giving an accessible name)
- `src/components/help/SearchHelpDialog.tsx` — `aria-label` on the "see also" link + new i18n key `search.help.regex.seeAlsoLinkLabel`
- `src/lib/i18n/references.ts` — new key (en, single-locale)
- `src/components/PdfViewerDialog.tsx` — `aria-label` on the page `<canvas>` reusing the page-indicator key
- `src/components/QueryBuilderModal.tsx` — datalist `<option>` text content + `aria-label` on the show-as-table checkbox
- `src/components/__tests__/{ConfirmDialog,DeviceManagement,KeyboardShortcuts}.test.tsx`, `src/components/ui/__tests__/{label,primitives}.test.tsx` — `aria-label` on test-fixture controls (queries unaffected; each `aria-label="Theme"` is in a separate render with RTL auto-cleanup, no `getByLabelText` collision)

**Verification:**
- `npx oxlint` — 0 errors; `control-has-associated-label` reports zero violations.
- `npx tsc -b` — no errors.
- `npx vitest run` (all touched suites + prod component tests) — 366 pass across the affected files.
- Technical review subagent (≠ builders) — APPROVE, no changes needed.
- pre-commit / pre-push hooks — run at commit/push time.

**Process notes:** Branch was cut from pre-#203 `main`; rebased onto the updated `origin/main`
after #203 merged — git auto-merged `.oxlintrc.json` (this rule's line is non-adjacent to
batch 1's restored rules). Pipelined against #203's CI per the batch-issues loop.

**Commit plan:** single commit, rebased onto main, pushed, PR opened.
