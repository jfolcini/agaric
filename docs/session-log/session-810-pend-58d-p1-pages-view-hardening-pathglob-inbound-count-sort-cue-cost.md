## Session 810 — PEND-58d P1: Pages-view hardening (PathGlob, inbound-count, sort cue, cost-reorder) (2026-05-22)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-22 |
| **Subagents** | 3 build (filters/D1+D4 · materializer/D2 · frontend/D3) + 2 review (frontend · backend) + orchestrator-direct (D1 `cost_hint`/EXPLAIN-test correction, docs) |
| **Items closed** | PEND-58d P1: D1, D2, D3, D4 |
| **Items modified** | PEND-58d (P2/P3/Testing/e2e remain) |
| **Tests added** | +7 frontend / +4 backend (plus stale-shape parity-test repairs) |
| **Files touched** | 16 |

**Summary:** Shipped the four P1 (correctness/perf) findings of the whole-feature review. **D1:** `PathGlob` now compiles to the documented `title COLLATE NOCASE LIKE ? ESCAPE '\'` via a `glob_to_like` translator (`*`→`%`, `?`→`_`, bare word → `%substring%`), fixing the user-visible inversion (the old `LOWER(title) GLOB ?` matched an *exact* lowercased title for a bare word while the docs promised a substring) and dropping the per-row `LOWER()`. **D2:** the materialised `pages_cache.inbound_link_count` now excludes same-page / self / deleted-source edges — mirroring `backlink/grouped.rs` — via a corrected materializer recompute + a one-shot migration-0070 backfill, so `Orphan` / `HasNoInboundLinks` / `MostLinked` / the `↗N` badge stop over-counting. **D3:** a muted "Sorted within loaded pages" cue (with tooltip) surfaces when a frontend-only sort (`alphabetical`/`recent`/`created`) is active while more pages are unloaded, so the in-page-only ordering at scale is no longer silent. **D4:** a cost-reorder IPC test exercises the `[Priority(cost1), Tag(cost0)]` → Tag-first stable-sort + `?`→`?N` bind-renumber path that both prior compound-filter tests missed.

- **Key discovery (measured, not assumed).** The plan assumed `title COLLATE NOCASE LIKE ?` would be index-backed. It is **not**: SQLite (3.50.6, the family sqlx bundles) won't use a NOCASE index — nor a `LOWER(title)` expression index — for a *case-insensitive* `LIKE`; only an explicit `COLLATE NOCASE >= p AND < p++` range hits the index. Since `pages_cache` is one row per page (a title scan is sub-ms) and a hand-rolled NOCASE prefix range is Unicode-fiddly, the scan was accepted and `cost_hint` made truthful (all `PathGlob` = full scan) rather than asserting an index hit that never happens. The builder's EXPLAIN test (which asserted the index) was replaced with a compiled-shape regression guard.
- **Review caught two stale parity tests** still on the old over-counting inbound shape (`op_log.rs` post-migration parity test — `PAGE_B` 3→2 once a deleted source is excluded — and a `refresh_page_cache_counts` test helper); both were realigned to the D2 shape so they lock the real contract instead of masking a regression.

**REVIEW-LATER impact:**
- **Top-level open count:** PEND-58d P1 resolved; P2 (D5–D15), P3 (D16–D27), and the Testing/e2e expansion remain (kept listed in `pending/README.md`).
- **Previously resolved:** 1257+ → 1258+ across 809 → 810 sessions.

**Files touched (this session):**
- backend: `src-tauri/src/filters/primitive.rs`, `src-tauri/src/commands/pages.rs`, `src-tauri/src/commands/tests/list_pages_with_metadata_tests.rs`, `src-tauri/src/materializer/handlers.rs`, `src-tauri/src/materializer/tests.rs`, `src-tauri/src/op_log.rs`, `src-tauri/migrations/0070_pages_cache_inbound_link_count_exclude_same_page.sql` (new)
- frontend: `src/hooks/usePageBrowserSort.ts`, `src/components/PageBrowser.tsx`, `src/components/PageBrowser/PageBrowserHeader.tsx`, `src/lib/i18n/pages.ts`, + tests (`hooks/__tests__/usePageBrowserSort.test.ts`, `PageBrowser/__tests__/PageBrowserHeader.test.tsx`)
- docs/meta: `pending/PEND-58d-pages-view-hardening.md` (P1 marked shipped), `pending/README.md`, `pending/PEND-58c-pages-filters-followups.md` (deleted — folded into PEND-58d)

**Verification:**
- `cd src-tauri && cargo nextest run` — 3893 passed, 4 skipped, 0 failed.
- `npx tsc --noEmit -p tsconfig.app.json` — clean; D3 vitest suites — 26 passed.
- `prek run --all-files` — all hooks pass.

**Process notes:** Two Rust subagents ran sequentially in the warm main tree (incremental) while the frontend subagent ran in parallel (vitest, no cargo contention) — chosen over worktrees because the 149G target dir made cold worktree compiles costlier than sequential incremental builds. Mid-session the user ran `cargo clean` (reclaiming 174.8 GiB of accumulated `incremental/`+`deps/` cruft), so the D2 subagent paid one cold rebuild.

**Lessons learned (for future sessions):** Verify index-usage claims with `EXPLAIN QUERY PLAN` against real SQLite before encoding them as `cost_hint`/test invariants — SQLite silently declines the LIKE optimization for case-insensitive matches, which no amount of NOCASE indexing fixes. When a change shifts a materialised-count semantic, grep for **every** parity test/helper using that count shape (there were three beyond the obvious one); a self-consistent stale test passes while silently locking the wrong contract.

**Commit plan:** committed onto `pend-58-phase2-pages-primitives` (PR #48), same-PR convention. Not pushed.
