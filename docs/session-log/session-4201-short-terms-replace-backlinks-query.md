# Session 4201 — Short terms in replace across pages, the backlinks Contains filter and query text

#6781 made a search term under three characters work in the search box. The maintainer chose to lift the same floor in the three places that still dropped it: replace across pages (`MIN_FIND_LENGTH`), the References panel's `Contains` filter and a query block's (and the Advanced Query box's) full-text term.

## What shipped

- **One predicate, three callers.** `add_shown_text_contains`'s SQL moved into a free function, `shown_text_contains` (`fts/filter_builder.rs`), which returns the `EXISTS` over `fts_blocks_content` with its placeholders numbered from a given slot and the `LIKE` patterns to bind. The search builder, `resolve_contains` (`backlink/filters.rs`) and `compile_query_ctx` (`query/engine.rs`) all call it, after `parse_query`, now `pub(crate)`.
- **Backlinks.** Beside a MATCH the predicate narrows it; alone, `resolve_contains` walks `blocks` by id through the primary key and stops at `FTS_ROW_CAP`, as the MATCH query did. `compile_contains` had its own `sanitize_fts_query` early return, which would have kept the panel's compiled path empty; it is deleted and `Contains` joins the other pre-resolved leaves, since `resolve_contains` and `membership_fragment` already return the empty set for an empty query.
- **Query engine.** `sanitize_fulltext` became `parse_fulltext`. The short-term predicate is AND-ed after the filter, its binds appended to `filter_binds`, so every statement (count, rows, aggregates, grouped) binds it in the same order. A text of only short terms has no MATCH and keeps the structural FROM; a `Relevance` sort key would make `resolve_sort` refuse it, and every row ties on it anyway, so the flat path drops it. A text left with nothing to search for is still refused, with the "at least 3 characters" clause gone from the message.
- **Replace across pages.** `candidateQuery` keeps every non-blank stretch between quotes; search answers a quoted phrase under three characters as a short term. `tooShort` became `noText` (empty box) with a new i18n string. The count, the `MAX_BATCH_BLOCK_IDS` refusal and the undo are the existing code, which already loads every candidate page before it counts.
- **Mock.** `matchesSearchText` applies `splitShortTerms` per row; `run_advanced_query` and the backlinks `Contains` arm use it, and a short-only advanced query ranks nothing and drops `Relevance`, as the engine does.

## Traps

- `CONFORMANCE_UPDATE=1` rewrites every fixture's formatting; keep only the fixtures you changed and run `oxfmt` on them.
- The first backlinks fixture step, `task fi`, passed against `main`'s mock because it is also one substring of "task five"; `fi task` is not.
- e2e-tauri text that holds a run-scoped marker can contain any two base-36 characters, so its short term is `+1`.
- A full workspace build filled the disk; `CARGO_INCREMENTAL=0` after clearing `target/debug/incremental`.

## Not done

The root `AGENTS.md` phrase change ("typed scalar or list properties") was refused by this session's permission classifier and is not in the PR.

## Ran

Red then green: `filter_contains_matches_a_short_term` (resolver and compiled path, each falsified separately), `fulltext_short_term_matches_like_the_search_box` (no MATCH, beside a MATCH, `Relevance`, each falsified), the vitest replace and `candidateQuery` tests, the two conformance fixtures against `main`'s mock handlers, and `e2e/search-replace.spec.ts`'s two-letter test against `main`'s `useSearchReplace.ts`. The two e2e-tauri cases were not run locally (no `tauri-driver`).
