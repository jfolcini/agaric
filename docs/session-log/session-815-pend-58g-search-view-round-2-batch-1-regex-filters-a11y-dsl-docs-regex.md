## Session 815 — PEND-58g search-view round-2: Batch 1 (regex filters, a11y, DSL, docs, regex-path robustness) (2026-05-23)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-23 |
| **Subagents** | 5 build (SearchPanel/Cluster-1 · search a11y · DSL · docs · backend regex-robustness) + 6 review (DSL, docs, a11y, backend, SearchPanel-technical, SearchPanel-UX); orchestrator-direct integration (FE-A8 `resetKey` wiring, UX-review fixups) |
| **Items closed** | DSL-A8/UX-A4 (cluster 1), FE-A5/A7/A8 (cluster 3), DSL-A1, DOC-A1/A2/A3/A5/A6, BE-A4, SQL-A4/A5/A6, FE-A13, FE-A12, UX-A11, UX-A2 |
| **Items modified** | BE-A10 (regex-under-cancellation half now covered); PEND-58g trimmed + 3 new follow-ups (NEW-1/2/3) |
| **Tests added** | +frontend (SearchPanel toggles/grouping, SearchResultGroups, useListKeyboardNavigation, classify) / +backend (fts: regex tag-filter contract, raw-len guard, mixed-case tag dedup, partitioned regex cancellation) |
| **Files touched** | 17 (src + src-tauri + docs) |

**Summary:** Actioned Batch 1 of the PEND-58g round-2 review across five
file-disjoint build subagents, pipelined with six review subagents (two dimensions —
technical + UX — for the user-facing SearchPanel change). **Headline (Cluster 1):**
structural filters (`tag:`/`path:`/`state:`/…) now apply in **regex mode**. The user
chose "apply filters in regex mode"; investigation showed the backend `regex_mode_query`
already binds every filter — the bug was frontend-only (`regexModeFilterParams()`
zeroed them and the full query was sent as the pattern). Fix: regex mode is now
symmetric with FTS mode — filter tokens are parsed out and applied as SQL filters;
the free-text remainder is the regex pattern. **Cluster 3 (a11y):** the FE-3
virtualization vs roving-listbox regressions — focus clamps instead of resetting to
row 0 on collapse/Load-More (FE-A8, wired via `resetKey={debouncedQuery}`), the
results region stays tabbable when no row is focused (FE-A7), and the active row gets
a page-level `scrollIntoView` across groups (FE-A5). Plus DSL-A1 (quoted-phrase
whitespace), the doc accuracy set (DOC-A1/A2/A3/A5/A6), regex-path backend robustness
(BE-A4 cancellation, SQL-A4 raw-length guard, SQL-A5 dead code, SQL-A6 ULID dedup),
and four SearchPanel fixes (FE-A13 aria parity, FE-A12 ast reuse, UX-A11 info-styled
hint, UX-A2 single-announce invalid-regex).

- **Review-driven corrections (orchestrator-direct):** the UX reviewer caught stale
  copy now that filters apply in regex mode — fixed the in-app help string
  (`references.ts`) and a contradictory `SEARCH.md` line. The technical reviewer
  flagged a filter-only-regex empty-result path; verified it's **pre-existing and
  symmetric** (the cursor `search_blocks_inner` short-circuits any blank query in
  both modes, not a regex regression) → logged as NEW-3 instead of force-fixing. The
  FE-A13 fix initially advertised `aria-controls` for a listbox that doesn't render
  in the history-off+empty case; corrected so the combobox aria tracks the actual
  listbox (`historyListboxVisible`).
- **Deferred (collide on the same files / own focused session):** Cluster 2
  pagination/`has_more` (SQL-A1/A2/A3/BE-A1), the FilterHelperPopover cluster
  (UX-A3/A5/A6, FE-A20), UX-A1 mobile parity, FE-A18 hook extraction, and the e2e
  gaps — all carried in PEND-58g.

**REVIEW-LATER impact:**
- **Top-level open count:** PEND-58g Batch 1 (19 findings) closed; file trimmed to
  the remaining clusters + 3 new follow-ups.
- **Previously resolved:** 1281+ → 1300+ across 814 → 815 sessions.

**Files touched (this session):**
- frontend: `src/components/SearchPanel.tsx`, `src/components/SearchPanel/SearchStatusRegion.tsx`,
  `src/components/search/SearchResultGroups.tsx`, `src/components/search/VirtualizedResultListbox.tsx`,
  `src/hooks/useListKeyboardNavigation.ts`, `src/lib/search-query/classify.ts`,
  `src/lib/i18n/references.ts`, + tests (`SearchPanel.toggles`, `SearchPanel.grouping`,
  `SearchResultGroups`, `useListKeyboardNavigation`, `classify`)
- backend: `src-tauri/src/fts/toggle_filter.rs`, `src-tauri/src/fts/search.rs`, `src-tauri/src/fts/tests.rs`
- docs: `docs/SEARCH.md`, `docs/architecture/search.md`, `pending/PEND-58g-search-view-review-2.md`

**Verification:**
- `npx vitest run` — 10591 passed.
- `npx tsc -b --noEmit` — clean.
- `cd src-tauri && cargo nextest run` — 3934 passed, 6 skipped.
- `prek run --all-files` — all hooks pass.

**Process notes:** No bindings/SQL/migration changes (Cluster 1 was frontend-only;
backend robustness was Rust-side only) so no `bindings.ts` / `sqlx prepare` regen.
`tsc -b` (not `tsc --noEmit`) is the real type gate — the root `tsconfig.json` has
`files: []`, so a bare `tsc --noEmit` checks nothing; the prek `tsc` hook (`tsc -b`)
caught test-file type errors a plain `tsc --noEmit` missed.

**Commit plan:** single commit on `pend-58f-search-view-hardening`; not pushed.
