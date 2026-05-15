# Design-system maintainability — remaining open work

> **Status:** Phases 1 + 2 + 3a + 3b mostly shipped. **Open below: only
> FormattingToolbar.tsx remains at 624 LOC — its parallel-batch subagent
> in session 745 was killed before wiring the extracted sub-components
> into the orchestrator. Pick it up as a focused single-file session.**
>
> History of closed items lives in `SESSION-LOG.md` sessions 709-734 + 745.

---

## Phase 3b — Triage the remaining ≥590-line feature files

Three of the original nine flagged files were closed in earlier sessions (`sidebar.tsx`, `BlockTree.tsx`, `RichContentRenderer.tsx`). Five of the six Phase-3b files landed in session 745:

| File | Before | After | Outcome |
| --- | --- | --- | --- |
| `HistoryListItem.tsx` | 645 | 228 | 2 siblings extracted (`BlockHistoryItem`, `HistoryItemCore`); 15 new tests |
| `GoogleCalendarSettingsTab.tsx` | 637 | 448 | 3 siblings extracted (`OAuthStatusSection`, `SettingsForm`, `SyncStatusSection`) + `connectErrorMessage` helper |
| `BugReportDialog.tsx` | 627 | 448 | 3 siblings extracted (`BugReportForm`, `DiagnosticsCollector`, `SubmitSection`) |
| `PageHeader.tsx` | 592 | 494 | 2 hooks extracted (`usePageAliases`, `usePageTemplateMeta`) |
| `SearchPanel.tsx` | 590 | 462 | 4 siblings extracted (`SearchFilters`, `SearchHeader`, `SearchResultList`, `SearchStatusRegion`) |
| `FormattingToolbar.tsx` | 624 | **624 (still)** | **OPEN — subagent killed mid-orchestrator rewrite; subdir reverted.** |

**Remaining:** `FormattingToolbar.tsx` — extract mark/state/action groups. The earlier killed subagent created `MarkGroup.tsx`, `StateGroup.tsx`, `ActionGroup.tsx`, and a `shared.tsx` for context types but never wired them into the orchestrator. Approach: a focused single-file session that (a) re-extracts the three groups, (b) rewrites the orchestrator body to render them in toolbar order, (c) preserves all 75 audited assertions from session 739. Cost remains S-M.

**Note on prioritisation:** size alone is a weak signal. Filter by "are we actively editing it?" before scheduling. A 645-LOC file that's been untouched for six months and has clear test coverage may be cheaper to leave alone than a 400-LOC file that's churning every week.

**Cost:** remaining one file — S-M. **Impact:** gradual code-health. **Risk:** low.

---

## Out of scope (for completeness)

Findings the original audit raised that this plan deliberately skips:

- **Round-1 claim of "219 hex/rgb/hsl leaks"** — verified to be ~26 after filtering issue-number references and comments, and `prek`'s `no-hsl-rgb-var-wrap` already prevents the drift class. Not pursued.
- **Round-1 claim of "6 untested primitives"** — actual is 2 (the rest had tests under different filenames). Covered by Phase 1.1c.
- **Tailwind v3 → v4 token migration audit** — separate concern.

History of the closed items (Phase 1 / Phase 2 / Phase 3a sidebar+BlockTree+RichContentRenderer) lives in `SESSION-LOG.md` Sessions 709-727 with file-level details.
