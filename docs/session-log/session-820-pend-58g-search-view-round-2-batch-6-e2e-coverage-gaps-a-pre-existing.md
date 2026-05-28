## Session 820 — PEND-58g search-view round-2: Batch 6 (E2E coverage gaps + a pre-existing test fix) (2026-05-23)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-23 |
| **Subagents** | 3 build (e2e by spec file); orchestrator: Playwright suite verification + pre-existing-test fix + docs/log |
| **Items closed** | E2E-A1, E2E-A2, E2E-A7, E2E-A8, E2E-A10, E2E-A11 (E2E-A3 reclassified → harness blind spot) |
| **Items modified** | PEND-58g (Batch 6 section; E2E section + action order updated) |
| **Tests added** | +12 e2e (search-filters: 7 IPC-marshalling; autocomplete: 3 anchors; search-results: 1 single-page contract; search-history: 1 per-space isolation) + 1 pre-existing test repaired |
| **Files touched** | 4 (e2e specs) + 2 plan/log |

**Summary:** Closed the verifiable E2E coverage gaps for the search view. Added
IPC-marshalling assertions for the negated filters (`not-state:`→`excludedStateFilter`,
`not-priority:`→`excludedPriorityFilter`, `not-prop:`→`excludedPropertyFilters`),
`scheduled:`→`scheduledFilter` (named + op shapes), `not-path:`→`excludePageGlobs`, and
the `prop:key=` empty-value key-presence contract (`{key, value:''}`) — all in
`search-filters.spec.ts`'s E2E-6 block via the existing `searchUntil`/`latestFilter`
helpers. Added autocomplete-anchor coverage for `priority:`/`due:`/`scheduled:`
(`autocomplete.spec.ts`) and per-space search-history isolation
(`search-history.spec.ts`, pre-boot localStorage seed). Installed the Playwright
Chromium browser (absent in the dev env) and ran the suite: **47 search e2e tests
green**.

**Pre-existing bug fixed:** `search-filters.spec.ts`'s "adds a tag filter via the tag
picker" queried `getByRole('button', { name: '#work' })`, but the Batch-2 UX-A6 a11y
work made the tag items `role="option"`, so the assertion timed out. It had slipped
through because the e2e browser wasn't installed locally. Confirmed it was NOT a
Batch-5 regression by reverting `FilterHelperPopover.tsx` to the pre-Batch-5 version —
it failed identically — then switched the query to `getByRole('option', …)`.

**REVIEW-LATER impact:**
- **PEND-58g open items:** closed E2E-A1/A2/A7/A8/A10/A11; E2E-A3 (Load-More)
  reclassified as a web+mock harness blind spot (the mock returns one page; the
  append path stays unit-covered) alongside E2E-A6. Remaining: BE-A5, UX-A8,
  UX-A10/A12/A13, FE-A18, BE-A7, FE-A19, E2E-A4/A5/A9, weak result-assertions.
- **Previously resolved:** 1323+ → 1329+ across 819 → 820 sessions.

**Files touched (this session):**
- `e2e/search-filters.spec.ts` (E2E-A1/A2/A8/A11 IPC tests + tag-picker `role="option"` fix)
- `e2e/autocomplete.spec.ts` (E2E-A7 priority/due/scheduled anchors)
- `e2e/search-results.spec.ts` (E2E-A3 single-page contract pin)
- `e2e/search-history.spec.ts` (E2E-A10 per-space isolation)
- `pending/PEND-58g-search-view-review-2.md`, `SESSION-LOG.md`

**Verification:**
- `npx playwright test e2e/{search-filters,autocomplete,search-results,search-history}.spec.ts` — 47 passed, 0 failed.
- `npx tsc -b --noEmit` + `biome check` on the e2e files — clean.

**Process notes:** Build subagents wrote tests but did NOT run Playwright (one shared
dev server; parallel runs collide), so the orchestrator ran the suite once — which is
also what surfaced the pre-existing tag-picker failure. A concurrent agent was active
in `src-tauri/` (sync/recovery); all work here stayed in `e2e/` + docs and was staged
by name to avoid touching it.

**Commit plan:** single commit (Batch 6). Not pushed.
