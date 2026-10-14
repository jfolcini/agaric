# Session 2058 — MCP: one structured query tool

First slice of #5398. Questions like "what did I edit since Monday", "notes
where estimate > 3" or "count open TODOs per project" took several calls or
could not be asked at all.

Shipped RO `query { space_id, where, sort?, group_by?, aggregate?, cursor?,
limit? }` over `compile_and_run` on the reader pool, scoped to the space.
`where`, `sort`, `group_by` and `aggregate` are the engine's own serde types,
so there is no second schema to drift. Rows carry the page title (one
`batch_resolve_inner`) and only the properties the query reads (one
`get_batch_properties_inner`); groups carry a title when grouped by page or
tag. `limit` is validated against `LIST_RESULT_CAP`, never clamped.

The engine did not check dates: a due/scheduled date that was not
`YYYY-MM-DD` and an inverted `Between` went through, and a malformed
`Created` bound was silently dropped, matching every block. `gate_leaves` now
refuses all three with `Validation`, which the app's `run_advanced_query`
gets too. The browser mock does not mirror the refusals; the frontend only
sends well-formed dates.

Premise corrections, written into the tool description and primer: `Tag`
matches attached tags and `TagOrRef` adds inline refs, but nothing matches
inherited tags; full text is a request field, not a predicate, and is not
exposed; link and parent predicates work one block and one level at a time,
so "pages linking to X tagged Y" is blocks linking X under a parent tagged Y.
Ids inside `where` stay ULIDs, not names.

Also dropped a stale primer sentence saying `list_backlinks` and `get_agenda`
span every space when `space_id` is omitted; #5538 made it required.

Left for later: the `search` fixes (inline and inherited tags, last-edited,
sanitiser docs, `page_title` on rows).

Suites run: the `mcp::` and `advanced_query` nextest subsets, the
agaric-store query and filter subsets, clippy and fmt over the workspace,
`cargo doc -p agaric` with warnings denied, each new test shown red first.
