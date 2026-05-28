## Session 814 — PEND-58f search-view: hardening + performance trilogy (2026-05-23)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-23 |
| **Subagents** | 5 build (backend SQL/BE, docs, e2e coverage, UX-3 i18n, FE-2, FE-3) + orchestrator-direct (DSL, FE correctness, UX wire-ups, FE-9/FE-10) |
| **Items closed** | DSL-1/2/3/4/5/10, FE-1/2/3/4/5/6/8/9/10/11/12/13/14, UX-1/2/3/4/5/7/8/9/10/11/12/15, SQL-1/3/4/5/6/7/8/9, BE-1/3/4/5/6/8/9, DOC-1/2/3/4/6/7/8/9/10/11, E2E-1/3..10 |
| **Items modified** | E2E-2 (covered + underlying onError bug fixed) |
| **Tests added** | +large (DSL/store/hook/component vitest, 6 new e2e search specs ~47 tests, Rust SQL/BE tests) |
| **Files touched** | ~45 across `src/`, `src-tauri/`, `e2e/`, docs |

**Summary:** Actioned the PEND-58f search-view deep-review findings across SQL/FTS,
backend Rust/IPC, the search-query DSL, the SearchPanel/autocomplete UI, stores/hooks,
docs and e2e. The performance trilogy: FE-2 (abort superseded searches via
AbortController), FE-3 (per-group results virtualization preserving the roving-listbox
a11y), FE-10 (caret state isolated into `<SearchAutocomplete>` so caret moves don't
re-render the panel). Also wired up + i18n'd the SearchHelpDialog (UX-1/3), fixed the
invalid-regex inline error (E2E-2), and added `scripts/push.sh` (verify-then-push) to
fix the long-pre-push-hook SSH timeout.

**Files touched (highlights):**
- `src/components/SearchPanel.tsx`, `src/components/SearchPanel/SearchAutocomplete.tsx` (new),
  `src/components/SearchPanel/useTagResolution.ts` (new), `useFilterSyntaxIntroToast.ts` (new)
- `src/components/search/SearchResultGroups.tsx`, `VirtualizedResultListbox.tsx` (new),
  `SearchHistoryDropdown.tsx`, `SearchHelpDialog.tsx`
- `src/hooks/usePaginatedQuery.ts`, `src/lib/tauri.ts`, `src/lib/search-query/*`
- `src-tauri/src/fts/*`, `src-tauri/src/commands/queries.rs`, `src-tauri/src/filters/primitive.rs`
- `e2e/search-*.spec.ts` (new), `scripts/push.sh` (new), docs

**Verification:**
- `npx tsc -b --noEmit` clean; `prek run --all-files` pass; full vitest + Playwright + cargo green.

**Commit plan:** pushed to `pend-58f-search-view-hardening` (separate PR from PEND-58 / PR #48).
