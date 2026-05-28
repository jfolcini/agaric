## Session 809 — PEND-58b: Pages compound-filters review remediation (2026-05-22)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-22 |
| **Subagents** | 3 build + 3 review (backend / PageBrowser / popover+summary) + orchestrator-direct docs |
| **Items closed** | PEND-58b — every confirmed finding from the multi-perspective + adversarial-verification review. |
| **Items modified** | — |
| **Tests added** | +~16 frontend (incl. a 19-case parameterized summary table) / +7 backend |
| **Files touched** | 17 |

**Summary:** Fixed every confirmed PEND-58b finding across backend SQL, frontend a11y/UX, and docs. Backend: scoped the `Orphan` outbound `NOT EXISTS` page-wide (it keyed on the page block, ignoring body-block links → wrong results); computed a real `total_count` on the metadata path (the page-count chip had silently vanished after the default-on flip); promoted the silent unsupported-filter `1=0` to an `AppError::Validation` in all build profiles; reranked the `LastEdited` cost hint; deduped the allowed-key vocabulary behind an exhaustive test. Frontend: chip-only zero-result now renders the no-match state (not "Create your first page"); added a polite live-region announcement on chip add/remove + result settle; `role="dialog"` on the Add-filter popover; per-facet helper descriptions + the missing "Last edited" group label; value-aware `OlderThan` summary. Docs: corrected the inverted `densityV1` flag section (now default-on / `'false'` opt-out), made the bucket table + soft-cap qualitative, noted negation/exclusion are Search-side. Also folds in the previously-uncommitted P0-D/P0-E work (list-virtualization windowing + load-more scroll-jump fix + their e2e).

- **Parallelization.** Rust (`src-tauri`) and TS (`src`) compile independently, so one backend + two frontend build subagents ran concurrently in the main tree on disjoint files with zero compile interference; the only shared write surface (i18n keys) was pre-added orchestrator-side. Each build was reviewed by a separate subagent (no self-reviews); all three reviews returned clean.
- **Orphan SQL.** `src.page_id = b.id AND src.deleted_at IS NULL` mirrors the inbound materialization (migration 0069) — the two halves are now symmetric. EXPLAIN confirms it uses `idx_block_links_source`.
- **total_count.** A single `COUNT(*)` over the same space + compiled-filter predicates (no keyset/cursor/limit, no per-row metadata subqueries) — index-served, within the 20k perf-gate headroom. Known minor redundancy: recomputed on each load-more page (deferred; cheap to gate on `cursor.is_none()`).

**REVIEW-LATER impact:**
- **Top-level open count:** PEND-58b resolved (kept listed in `pending/README.md` until PR #48 merges, per the PR-spanning convention).
- **Previously resolved:** 1256+ → 1257+ across 808 → 809 sessions.

**Files touched (this session):**
- backend: `src-tauri/src/filters/primitive.rs`, `src-tauri/src/commands/pages.rs`, `src-tauri/src/commands/tests/list_pages_with_metadata_tests.rs`
- frontend: `src/components/PageBrowser.tsx`, `src/components/PageBrowser/AddFilterPopover.tsx`, `src/components/PageBrowser/PageBrowserFilterRow.tsx`, `src/lib/i18n/pages.ts`, + tests (`__tests__/PageBrowser.test.tsx`, `PageBrowser/__tests__/AddFilterPopover.test.tsx`, `PageBrowser/__tests__/PageBrowserFilterRow.test.tsx`)
- P0-D/E (carried): `e2e/pages-filter.spec.ts`, `src/lib/tauri-mock/handlers.ts`, `src/lib/tauri-mock/seed.ts`
- docs/meta: `docs/PAGES.md`, `pending/README.md`, `pending/PEND-58b-compound-filters-review-fixes.md`, `.gitignore`

**Verification:**
- `cd src-tauri && cargo nextest run` — 3889 passed, 4 skipped (`#[ignore]` perf gates), 0 failed.
- `npx vitest run` (PageBrowser suites) — green; `npx tsc --noEmit -p tsconfig.app.json` — clean.
- `prek run --all-files` — all hooks pass (cargo-fmt auto-fix applied + re-verified).

**Lessons learned (for future sessions):**
- Rust/TS compile isolation lets backend + frontend build subagents share one working tree safely; the only real conflict surface is a shared i18n file — pre-adding the keys orchestrator-side removes it and lets the frontend subagents reference fixed keys.

**Commit plan:** committed onto `pend-58-phase2-pages-primitives` (PR #48), same-PR convention. Not pushed.
