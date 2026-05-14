# Design-system maintainability — remaining open work

> **Status:** Phases 1 + 2 + 3a fully shipped. **Open below: 3b LOC triage for 6 feature files (opportunistic).**
>
> History of closed items lives in `SESSION-LOG.md` sessions 709-734. Don't reintroduce them here.

---

## Phase 3b — Triage the remaining ≥590-line feature files

Three of the original nine flagged files were closed across earlier sessions (`sidebar.tsx`, `BlockTree.tsx`, `RichContentRenderer.tsx`). Six remain on the list — each is opportunistic, **not** a blocking initiative:

| File | Lines | Likely seams |
| --- | --- | --- |
| `src/components/HistoryListItem.tsx` | 645 | per-op renderers (create/edit/move/tag) extractable |
| `src/components/GoogleCalendarSettingsTab.tsx` | 637 | extract OAuth state + sync-status + form into siblings |
| `src/components/BugReportDialog.tsx` | 627 | form sections + diagnostics collection |
| `src/components/FormattingToolbar.tsx` | 624 | mark/state/action groups |
| `src/components/PageHeader.tsx` | 592 | already orchestrates 4 named subcomponents; check if more pull out |
| `src/components/SearchPanel.tsx` | 590 | filters + result list + ranking |

**Change:** each is a separate ticket. Don't bundle them. `PropertyRowEditor.tsx` (573 lines) already absorbed the FormField extraction from 2d — no further work scheduled.

**Note on prioritisation:** size alone is a weak signal. Filter by "are we actively editing it?" before scheduling. A 645-LOC file that's been untouched for six months and has clear test coverage may be cheaper to leave alone than a 400-LOC file that's churning every week.

**Cost:** per-file, S-M. **Impact:** gradual code-health. **Risk:** per-file low.

---

## Out of scope (for completeness)

Findings the original audit raised that this plan deliberately skips:

- **Round-1 claim of "219 hex/rgb/hsl leaks"** — verified to be ~26 after filtering issue-number references and comments, and `prek`'s `no-hsl-rgb-var-wrap` already prevents the drift class. Not pursued.
- **Round-1 claim of "6 untested primitives"** — actual is 2 (the rest had tests under different filenames). Covered by Phase 1.1c.
- **Tailwind v3 → v4 token migration audit** — separate concern.

History of the closed items (Phase 1 / Phase 2 / Phase 3a sidebar+BlockTree+RichContentRenderer) lives in `SESSION-LOG.md` Sessions 709-727 with file-level details.
