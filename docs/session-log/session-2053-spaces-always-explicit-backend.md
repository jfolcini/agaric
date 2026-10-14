# Session 2053 — Spaces: every command takes one space, search an explicit scope

Set out to work #5415's backend slice: `SpaceScope` defaulted to `Global`, `SearchFilter::scope` defaulted to it when omitted, about thirty commands accepted it and dropped the space filter, and `create_block('tag')` made a space-less tag under it.

What shipped: `SpaceScope` keeps one variant, `Active(SpaceId)`, with no `Default`; a missing or `{"kind":"global"}` scope fails to deserialize, and its one accessor is `space_id()`. Search takes a required `SearchScope`: an explicit, non-empty list of spaces (`b.space_id IN (SELECT value FROM json_each(?N))`) or all spaces. A tag is always created in the given space. MCP `list_backlinks` and `get_agenda` require `space_id`. The frontend search wrappers send the active space as a one-element list and fail closed without one; the tauri mock refuses a missing scope with the backend's validation shape. An EXPLAIN test pins the boot and post-sync placement probes to `idx_blocks_space_type`.

Traps: five agents shared one tree, and in-place falsification edits to production files leaked into each other's builds; the review re-read every production hunk on the quiet tree. Ten converted exclusion tests built their fixtures with no space, so a scoped read returned nothing whatever the exclusion did; they now seat the fixture in the scoped space. The `list_page_links` SLO bench had measured the unscoped read, which no longer exists; the scoped read the graph has always sent materialises the space's members, and #5426 item 4 tracks that cost. #5535 made `parse_args` name a missing field, which retired a helper written to do it by hand.

Left: the MCP half of #5415 (the id-addressed reads and enumerations still span every space), and the store functions now only ever called with a space, whose `?N IS NULL OR` arms are dead.

Ran: the whole workspace under nextest (6808 tests, two partitions), clippy with `--all-targets -D warnings`, fmt, doc-tests, the bindings check, the dynamic-SQL and space-filter guards, vitest over every directory, `npm run typecheck`, `npm run lint`, and the MCP tests again after rebasing onto #5535.
