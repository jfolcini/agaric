## Session 834 — sync roadmap lock + PEND-76 PR + quick wins (PEND-78/79/77 Tier A) (2026-05-25)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-25 |
| **Subagents** | orchestrator-direct |
| **Items closed** | PEND-78, PEND-79, PEND-77 Tier A |
| **Items modified** | PEND-77 (Tier A done; Tier B deferred), PEND-80/PEND-81 (sync Option A locked), PEND-76 (PR #53 opened) |
| **Tests added** | +4 (frontend) / +11 (backend) |
| **Files touched** | 13 |

**Summary:** Locked the pending roadmap and shipped three independent quick wins.
**Planning:** rewrote `pending/README.md` "Active order" and locked the sync epic on
**Option A** (enrich the Loro engine — PEND-80 — then re-project remote changes in
PEND-81; Option B op-based sync rejected); opened **PR #53** for the already-committed
PEND-76 F1–F5 fixes. **PEND-78:** the recent-pages strip could durably persist another
space's pages into the active space's MRU — `recordVisit` now reads the active space's
own slice (not the flat mirror) and the space-subscriber first-fire reconciles the flat
mirror to the active slice (extracted as `reconcileRecentPagesOnSpaceChange`, exported
for tests). **PEND-79:** AppImage first-run desktop self-integration on Linux
(`$APPIMAGE`-guarded `agaric.desktop` + hicolor icon install + cache refresh, Exec
drift-rewrite). **PEND-77 Tier A:** proptest reconstruction invariants for
`compute_word_diff` and idempotence/whitespace-equivalence for
`space_filter_canonical::normalize`.

**REVIEW-LATER impact:**
- **Top-level open count:** unchanged (PEND-track items; no REVIEW-LATER rows touched).
- **Previously resolved:** 1342+ (unchanged).

**Files touched (this session):**
- `pending/README.md` (active order + index rows for 76/77/78/79)
- `pending/PEND-80-*.md`, `pending/PEND-81-*.md` (Option A locked); `pending/PEND-77-*.md` (Tier A status); `pending/PEND-78-*.md`, `pending/PEND-79-*.md` (deleted on completion)
- `src/stores/recent-pages.ts`, `src/stores/__tests__/recent-pages.test.ts` (PEND-78 fix + 4 tests)
- `src/components/__tests__/RecentPagesStrip.test.tsx`, `src/stores/__tests__/navigation.test.ts`, `src/components/__tests__/App.test.tsx` (reset both store fields now that `recordVisit` reads the slice)
- `src-tauri/src/appimage_integration.rs` (new module + 6 tests), `src-tauri/src/lib.rs` (mod + Linux setup-hook call)
- `src-tauri/src/word_diff.rs` (+3 proptests), `src-tauri/src/space_filter_canonical.rs` (+2 proptests)

**Verification:**
- `npx vitest run` (recent-pages + RecentPagesStrip + navigation + App) — 243 pass.
- `cargo nextest run appimage_integration word_diff space_filter_canonical` — 22 pass (11 new).
- `prek run --all-files` + `scripts/push.sh` CI-equivalent at push.

**Process notes:** PR #53 = PEND-76; quick wins stacked on `pend-78-79-77-quick-wins`
(one PR, three surgical commits) to amortize the multi-minute verify-before-push.
PEND-78 exposed the "partial `setState` of only `recentPages`" test-reset class the
plan predicted — fixed the three reset sites.

**Commit plan:** 3 commits on `pend-78-79-77-quick-wins` (stacked on #53); pushed; PR to open.
