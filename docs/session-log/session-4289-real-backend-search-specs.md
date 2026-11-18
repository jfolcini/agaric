# Session 4289 — six search spec files join the real-backend project

Stage 2 of #6529: one area's specs move onto `REAL_BACKEND_SPECS`, and each failure is triaged as its file joins. This PR moves the search area: `search-filter-chips`, `search-filters`, `search-happy-paths`, `search-replace`, `search-shown-text-6277` and `search-toggles`.

On a locally built `bridge`, 39 of their 41 tests passed on the first run. The two failures:

- **`search-happy-paths` › clicking a result opens its page.** The search found "No results". The real backend writes FTS rows in the background, so a search sent right after creating 81 blocks can find nothing yet. The mock indexes synchronously. Fixed in the spec: it resends the search until the row shows. `e2e-tauri/advanced-query-group-by.e2e.ts` waits on FTS the same way. This is not a backend bug.
- **`search-toggles` › a non-regex backend error.** Its error comes from `__injectMockError`, which the bridge does not have. The `?.` call made it a silent no-op. Tagged `@mock-only`.

#6883's per-PR check then failed a third test on the mock, as it should: `search-toggles` › invalid regex. On the bridge the real backend rejects the pattern itself. On the mock the error only comes from `__injectMockError`, because the mock's `buildSearchRegex` answers an invalid pattern with no rows rather than with `InvalidRegex`. Teaching the mock that error would mean matching the regex crate's message text, so the test is tagged `@mock-only`, which is where it was before the file joined.

Also folded in from #6896's review: `scripts/measure-page-mode-webkit.mjs` seeds its page into `SEED_IDS.SPACE_PERSONAL` (as a literal: the script cannot import the TS module).

Ran: the six files on the bridge (39 passed, 2 tagged out) and on the mock (41 passed).
