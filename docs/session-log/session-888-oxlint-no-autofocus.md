## Session 888 — oxlint no-autofocus → error (#188 batch 5) (2026-05-29)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-29 |
| **Subagents** | 3 build (orchestrator-reviewed) |
| **Items closed** | — |
| **Items modified** | `#188` |
| **Tests added** | +0 (suppression comments only; no logic change) |
| **Files touched** | 15 |

**Summary:** Fifth #188 burndown batch. Per the maintainer's decision (keep intentional
focus-on-open, disable per-site), added a justified `oxlint-disable-next-line jsx-a11y/no-autofocus`
to each of the 20 `autofocus` sites and restored the rule to `error`. No `autofocus` was removed
and no logic changed — every site is a genuine focus-on-open in a modal/dialog/popover/inline-editor
(verified per-site; none flagged as accidental page-load focus-steal). Notably the destructive
confirm dialogs (`ConfirmDialog`, `SpaceDeleteButton`) correctly focus the **safe Cancel** action
so a reflexive Enter dismisses rather than confirms. Remaining oxlint warnings after this batch:
~156 (`prefer-tag-over-role` 115, `react-hooks/exhaustive-deps` 36 left).

**Files touched (this session):**
- `.oxlintrc.json` — `no-autofocus` `warn` → `error`
- 15 components, one disable each (ConfirmDialog ×4, AddFilterPopover ×3, FilterHelperPopover ×2, plus DateChipEditor, RenameDialog, BlockDatePicker, DiagnosticsCollector, CodeLanguageSelector, KeyboardSettingsTab, SearchHeader, SpaceDeleteButton, LinkEditPopover, RefEditor, PropFilterForm)

**Verification:**
- `npx oxlint` — 0 errors; `no-autofocus` reports zero violations; no new error-level lint.
- `npx tsc -b` — no errors.
- `npx vitest run` (affected suites) — all pass (105 + 111 + 127 across the three subagent groups).
- Orchestrator diff review — all 20 disable reasons are honest and site-specific; no over-suppression.

**Process notes:** Maintainer decisions for the remaining #188 clusters were obtained via an
in-CLI prompt after a comment-based round didn't propagate to this clone (decisions also recorded
durably on #188): no-autofocus = keep+disable (this batch); exhaustive-deps = proceed carefully
(per-site, small sub-batches); prefer-tag-over-role = proceed in sub-batches. Pure-suppression
batch, so orchestrator-reviewed rather than a separate review subagent.

**Commit plan:** single commit, pushed, PR opened.
