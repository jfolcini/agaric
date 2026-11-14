# Session 4175 — Nested tags: a tag filter finds the tags named under it, and the Tags view nests them

Set out to build #6760: someone importing an Obsidian vault with `#projects/web` gets nothing from a filter on `projects`, and a flat Tags view.

## What shipped

- **A `Tag` leaf matches the tag and every live tag of its space named under it.** `FilterPrimitive::Tag` compiles to `tag_id IN (TAG_AND_NESTED_IDS_SQL)` in `PagesProjection` and `SearchProjection` (`filters/primitive.rs`), so search (`tag:#projects`, `SearchFilter.tag_ids`), query blocks and the query builder (`run_advanced_query`), the Pages view's tag filter and the MCP `search` tool all nest. The hierarchy is read from `blocks.content` at query time (`substr(name, 1, length(parent) + 1) = parent || '/'`, `COLLATE NOCASE`); nothing is stored. `under:` (`tags_match_inline_and_inherited`) widens the same id set over attached, inline and inherited rows.
- **A name no tag holds stands for the tags under it.** A vault that only ever wrote `#projects/web` has no `projects` tag. The search box then sends the nested tags' ids as one group of the new `SearchFilter.tag_any_of` (one tag of every group, AND-ed with `tag_ids`), and a query block compiles the name to an `Or` of `Tag` leaves. The builder opens such a text as text only: saving the `Or` would freeze it to today's tags.
- **The Tags view nests.** `TagList` feeds the tags through `buildPageTree`, the Pages view's namespace tree, and renders the rows depth first: a tag shows its last name segment, indented, with `aria-level`; a name no tag holds is a plain row.
- The mock mirrors both (`tagAndNestedIds`, `tagAnyOf`), pinned by `conformance/fixtures/query_nested_tags.json`.

## Decisions

- **A bare `tag:projects` nests** (the orchestrator's provisional call, the maintainer's to overrule on the PR). No spelling for the exact tag fell out of the existing syntax, so there is none. `TagOrRef`, the leaf a tag's own page lists by, still matches the one tag, so a tag's page and its usage count are unchanged. The Tags view's boolean query (`TagExpr`) and backlink filters are unchanged too.
- **Inherited tags are separate from nesting.** `block_tag_inherited` is not written for a parent name: a block under one tagged `projects/web` inherits `projects/web` only, and `under:#projects` finds it because that tag's id is in the nested set.
- **One bind, read from `blocks`.** A first cut bound the id twice (`SELECT ? UNION ALL …`), which renumbered every placeholder in the assembly goldens. The tag row is always in `blocks` (`block_tags.tag_id` is a foreign key), so `n.id = p.id OR (…)` needs one bind; SQLite plans it as a multi-index OR over the primary key and `idx_blocks_space_type`. `tags_cache` was not used: it lags a tag just created.

## Traps

- `ActiveBlockId` uppercases on read, so a test block id must be uppercase to compare.
- A blank query takes the filter-only scan (`toggle_filter.rs`) and a text query the FTS match (`search/fetch.rs`): two call sites for the group clause, each needing its own assertion.
- `useTagResolution`'s return gained `tagAnyOf`, so its ten exact-shape assertions gained `tagAnyOf: []`.
- The conformance ratchet reads `prepare_metadata_with_today` for the fields that make a blank query a filtered one; `tag_any_of` is read there, last.

## Existing assertions edited (each pinned the old leaf)

- `filters::primitive::tests::tag_or_ref_emits_union_of_attached_and_inline_refs`: dropped "`Tag` holds no `UNION`"; "`Tag` reads no `block_tag_refs`" stays.
- `fts::filter_builder::tests::tags_via_projection_routes_and_documents_shape_cutover` and both `structured_assembly_is_byte_identical_to_legacy_renumber` goldens: the `Tag` leaf's text, composed from `TAG_AND_NESTED_IDS_SQL`; placeholder numbers and bind counts unchanged.
- `useTagResolution.test.ts`: `tagAnyOf: []` in ten result-shape assertions.
- The MCP tool-description snapshot: `search`'s `tag_ids` and the `Tag` / `TagOrRef` lines of `list_pages` and `query` say that `Tag` reaches nested tags and `TagOrRef` is the one tag.
- `conformance-coverage.test.ts`: `tag_any_of` / `tagAnyOf` in the two has-filters lists.

## Suites run

`cargo nextest run --workspace` in two halves (4,090 of 4,091 and 4,085 of 4,085; the one failure was the MCP tool-description snapshot, refreshed, after which the MCP and snapshot tests ran again, 661 of 661), `cargo clippy --workspace --all-targets -- -D warnings`, `SQLX_OFFLINE=true cargo check --workspace --all-targets`, the specta bindings regeneration. Frontend: `npm run typecheck`, the vitest files of the search panel, the Tags view, the query builder, query text, the IPC helpers, the page tree, the hooks and the Pages view (231 files, 4,265 tests), all of `src/lib/tauri-mock` (2,106 tests), and Playwright `e2e/nested-tags.spec.ts` with the eight other tag specs and `query-block-text.spec.ts`. Each new test was shown red by breaking the code it covers: thirteen Rust mutations, the mock's five conditions against the conformance fixture, and the frontend units one mutation each. Not run: the whole vitest and Playwright suites, doc-tests, WebdriverIO, the bench lanes; CI's runs are the check, and `bench-slo` is dispatched on the branch because `interactive_slo` times `search_blocks` with a tag.

The first Playwright run of the search test failed one time in three under parallel workers: Enter pressed while the tag suggestions of the previous value are still open accepts one and rewrites the input. The spec ends each query with a space, which closes the popover.
