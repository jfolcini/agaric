# Session 2020 — Search e2e asserts rendered results; Agenda and Tags perf journeys

Picked up the mock-lane items of #5366 after its Oct 9 claim went quiet.

What shipped: the thirteen `<token> → filter.<field>` tests in `e2e/search-filters.spec.ts` and the flag tests in `e2e/search-toggles.spec.ts` asserted the `search_blocks` payload, which testing invariant 1 forbids. Each now seeds blocks the filter must keep and blocks it must drop, searches, and asserts the rendered result rows. `e2e/helpers.ts` gained `seedSearchBlocks`, `submitSearch` and `searchResultIds`. `e2e/perf.spec.ts` gained opt-in (`AGARIC_PERF=1`) Agenda and Tags journeys, with dated TODOs and tags in the seed; on view journeys `wallMs` is click to first row.

Premise correction: the spec and helper comments said the mock "ignores the SearchFilter struct"; it has applied the whole filter since #4159, matching `fts/filter_builder.rs` on every field checked, so no mock change was needed and no payload test was kept. One gap no test hits: the backend refuses an empty `prop:` key or an unparseable date, the mock returns more rows. The structured-filter conformance steps for `search_blocks` are left for a Rust session.

Ran: both search specs and `perf.spec.ts` (one opt-in run), `npm run typecheck`, oxlint, oxfmt. Every rewritten test went red with its mock filter (or, for the default toggles, the product default) broken.
