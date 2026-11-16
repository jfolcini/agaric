# Session 4230 — A tap on the mobile search sheet's full-search button lands while results arrive

Fixes the `search-sheet-mobile.spec.ts` "escalates to the search view" failure in scheduled deep-checks run 43778607519 (shard 4/4, main at ddee841), its first failure in the last thirty nightly runs.

- **Cause.** `MobileEscalationButton` sat below the palette's `CommandList`, whose height follows its rows. After a keystroke it moved twice: up when the query hid the recents, down when the debounced results rendered. A tap that pressed on it and released after the results landed released on a result row, so no `click` reached the button and the sheet stayed open. Playwright's stability wait sees the button still during the debounce, so a click there hits the same window a thumb does. Not #6848 or #6849: neither touched the escalation, view-switch or sheet-close path.
- **Fix.** The button renders under the palette input, above everything whose height changes with the query (link badge, no-results line, list).
- **Spec.** "a tap on the search-view button lands while the palette results arrive" holds the press across a delayed search (`__setMockLatency(800)`) and releases once a result group renders.

Ran: the new test on main failed 3/3 with the CI symptom (`search-sheet` count 1 after the release); with the fix it and the original test passed 40/40 at `--repeat-each=20 --workers=8`. `search-sheet-mobile`, `search-view-mobile`, `palette-desktop` specs: 13 passed. `CommandPalette*` and `SearchSheet` vitest: 150 passed. Typecheck, oxlint, oxfmt clean.
