## Session 1251 — Due panel data fixes (2026-08-04)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-04 |
| **Subagents** | 2 build + 2 review (+1 discovery) |
| **Items closed** | #3284 |
| **Items modified** | — |
| **Tests added** | +3 frontend / +0 backend |
| **Files touched** | 5 |

**Summary:** Upcoming-deadline queries now exclude completed and empty rows before the
bounded fetch window is applied. Fresh projected-agenda cache hits restore parent titles,
concurrent title resolutions merge safely, and unresolved projected navigation uses the
same translated fallback as ordinary Due panel rows.

**Files touched (this session):**
- `src/hooks/useDuePanelData.ts` (+44/-24)
- `src/hooks/__tests__/useDuePanelData.test.ts` (+127/-0)
- `src/components/agenda/DuePanel.tsx` (+3/-1)
- `src/components/agenda/__tests__/DuePanel.test.tsx` (+36/-0)
- `docs/session-log/session-1251-due-panel-data-fixes.md` (new)

**Verification:**
- Focused Vitest — 2 files passed, 95 tests passed.
- `npx vitest run` — 730 files passed, 15,930 tests passed.
- `oxfmt` and `oxlint` on the four changed frontend files — passed.
- `git diff --check` — passed.
- pre-commit hook — all staged-file checks pass.
- pre-push hook — full CI-equivalent checks pass.

**Process notes:** Independent review required the main-list resolver to merge into the
shared title map so a slower main response cannot erase titles restored from projected
cache. UX review also exposed a pre-existing roving-focus issue in DuePanel keyboard
navigation; a proposed local propagation fix proved unsafe because the hook does not move
DOM focus, so that out-of-scope change was reverted rather than shipped here. This branch
is stacked on #3412 so its session-1250 reservation remains contiguous; the PR targets
that branch and can retarget to `main` after #3412 lands.

**Commit plan:** two commits, pushed.
