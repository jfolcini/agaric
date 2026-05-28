## Session 817 — PEND-58g search-view round-2: Batch 3 (filter-only search, regex-mode autocomplete + cue) (2026-05-23)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-23 |
| **Subagents** | 2 build (backend NEW-3 · frontend NEW-1/NEW-2) + 3 review (backend technical w/ mutation testing · frontend technical · frontend UX); orchestrator-direct: docs, stale-comment update, i18n polish, formatting |
| **Items closed** | NEW-1, NEW-2, NEW-3 |
| **Items modified** | PEND-58g (Batch 3 section added; "New follow-ups" section cleared; action order renumbered); PEND-68 (markdownlint MD040/MD004 fix, separate commit) |
| **Tests added** | +5 frontend (2 autocomplete-contract, 3 regex-cue incl. axe) / +13 backend (`new3_*`, incl. the exact-multiple `has_more` boundary added by the reviewer) |
| **Files touched** | 11 (src + src-tauri + docs) + 2 plan/log (+ PEND-68 in its own commit) |

**Summary:** Actioned Batch 3 — the cluster-1 follow-ups. **NEW-3 (filter-only
search):** a blank free-text query carrying ≥1 structural filter now returns the
filtered blocks recency-ordered (`b.id DESC`) instead of empty, in BOTH the cursor and
partitioned paths and mode-independent. FTS5 MATCH can't express "match all", so a new
`filter_only_scan` (+ `fts_fetch_filter_only_page` cursor / `fts_fetch_filter_only_partitioned`)
bypasses FTS/regex; the old blank-query short-circuits in `search_blocks_inner` /
`search_blocks_partitioned_inner` were removed (the decision moved into
`search_with_toggles*`). `space_id` is excluded from the "has filters" test (always
supplied), so a space-only blank query still returns empty. **NEW-1 (regex-mode prefix
autocomplete):** the over-broad `suppressed={isRegex}` gate is gone — the caret anchor
detector already returns null on free-text, so filter prefixes (`tag:`, `state:`, …)
autocomplete in regex mode while the regex remainder stays suppressed. **NEW-2 (regex
cue):** the input gains a regex placeholder + monospace + an sr-only `aria-describedby`
hint when regex mode is on. Also fixed the two markdownlint errors in PEND-68 (separate
commit).

**REVIEW-LATER impact:**
- **PEND-58g open follow-ups:** 3 → 0 (NEW-1/NEW-2/NEW-3 closed; the "New follow-ups"
  section removed and the suggested action order renumbered to start at UX-A1).
- **Previously resolved:** 1312+ → 1315+ across 816 → 817 sessions.

**Files touched (this session):**
- `src-tauri/src/fts/toggle_filter.rs` (+~410 — `filter_only_scan`, `fts_fetch_filter_only_page`, `fts_fetch_filter_only_partitioned`, blank-query dispatch in `search_with_toggles*`)
- `src-tauri/src/commands/queries.rs` (removed leading empty-query short-circuits + dead `empty_partition()`)
- `src-tauri/src/fts/tests.rs` (+~700 — `new3_*` tests + helpers)
- `src/components/SearchPanel.tsx` (drop `suppressed`, add `regexMode`; refreshed the stale `enabled`-gate comment)
- `src/components/SearchPanel/SearchAutocomplete.tsx` (removed the `suppressed` prop; anchor memo unconditional)
- `src/components/SearchPanel/SearchHeader.tsx` (regex placeholder + `font-mono` + sr-only `aria-describedby` hint)
- `src/components/__tests__/SearchPanel.autocomplete.test.tsx`, `src/components/__tests__/SearchPanel.toggles.test.tsx`
- `src/lib/i18n/references.ts` (`search.searchPlaceholderRegex`, `search.regexModeHint`)
- `docs/SEARCH.md`, `docs/architecture/search.md` (filter-only path + regex-mode autocomplete)
- `pending/PEND-58g-search-view-review-2.md`, `SESSION-LOG.md`
- `pending/PEND-68-page-actions-and-recent-quick-nav.md` (separate commit — MD040/MD004 fix)

**Verification:**
- `cd src-tauri && cargo nextest run` — 3954 passed, 0 failed, 6 skipped.
- `prek run --all-files` — all hooks pass (after applying `cargo fmt` + biome formatting to the new tests / the wrapped placeholder).

**Lessons learned (for future sessions):**
- Precise, fully-designed build prompts paid off: all 5 subagents finished without the
  session-limit deaths that plagued Batch 2. For a cohesive cross-cutting backend change
  (NEW-3), front-loading the exact SQL/cursor design into the subagent prompt — rather
  than "implement filter-only search" — was the difference.
- Mutation testing in the backend review caught a real gap a reading review would miss:
  the `has_more` `>`→`>=` mutation only diverges when the filtered set is an exact
  multiple of the page limit, which the original fixture never hit. Re-applied the
  Batch-2 lesson too: independent `grep MUTATION` + boundary-residue scan after the
  mutation-testing review (clean this time).

**Commit plan:** two commits — (1) `docs(pending)` PEND-68 markdownlint fix; (2) `feat(search)` PEND-58g Batch 3. Not pushed.
