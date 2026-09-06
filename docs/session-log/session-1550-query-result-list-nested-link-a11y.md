# Session 1550 — QueryResultList's page-title span stops nesting a link inside its option

Fixes #4737, filed against #4736's review of #4719: `QueryResultList` renders each result row as a `role="option"` div, and whenever the row had a parent page it nested `PageLink` — a `<span role="link" tabIndex={0}>` — inside that option. axe 4.11 flags this as `nested-interactive`, impact serious: an option's accessible name computation has no defined behavior for a focusable widget inside it, and the row's own keyboard handling (`useListKeyboardNavigation`) moves between `tabIndex={-1}` rows rather than into them, so the nested link was never reachable from the keyboard in the first place — a mouse-only affordance masquerading as an operable control to assistive tech.

The existing axe test never caught it because its fixture set `parent_id: null, page_id: null`, the exact condition that suppresses the `PageLink` render — the fixture was shaped around the bug it sat next to.

Took option 1 from the issue: the page name renders as plain text inside the option now, and the row's existing click/`Enter` handler (`handleBlockNavigation`, keyed off `block.page_id`) is the row-level "open page" action — it already fired for a click anywhere else on the row, so nothing new was wired. The lost affordance is a direct mouse target on the small page-name text specifically; that target was already unreachable by keyboard, and the whole row still opens the same page. `QueryResultTable`'s own `PageLink` usage is unaffected — there it lives in a plain `<td>`, not a widget-bearing role, which is why the issue named it as the shape to imitate rather than a second violation.

Updated the axe test to set `parent_id`/`page_id` and a matching `pageTitles` entry, so it exercises the row the bug lived in instead of skirting it, and updated the two DOM-shape tests (`getByRole('link', …)` → `getByText`). One test in `QueryResult.test.tsx` had been asserting navigation through `PageLink`'s own direct `navigateToPage` call with no `onNavigate` prop threaded to `QueryResult` at all; rewrote it to pass `onNavigate` and click the row, which is the only path left and matches how every real call site (`ViewDispatcher`, `EditableBlock`) already wires it.

Falsified against a copy: reverted `QueryResultList.tsx` to the old `PageLink`-nested DOM, kept the new fixture, ran `has no a11y violations` — red, axe reporting `nested-interactive` on `#query-result-B1` verbatim. Restored from the copy, `cmp` confirmed byte-identical, reran — green.

Verified: `npx vitest run src/components/query src/components/pages` → 23 files, 730 tests, all passed (plus a spot-check of `src/components/AdvancedQuery` and `StaticBlock.test.tsx`, 6 files / 174 tests, unaffected — they either don't hit the page-title span or already avoid it for the same reason). `npm run typecheck` clean. Formatted only the three touched files with `oxfmt`.

Shipped: fix for #4737.
