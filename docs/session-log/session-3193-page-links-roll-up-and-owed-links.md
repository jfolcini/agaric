# Session 3193 — page links roll up to their pages, and every writer owes its links

The second half of item B3 of #6054, as comment 6473155757 scoped it. With this, every B3 item is closed.

**`list_page_links` roll-up.**
- The fuzzer's woven texts can now name the second seed page (`MOVED_PAGE`), so `list_page_links` returns edges.
- Once that page moves to another space, it joins `elsewhere`, so no later create names it; the write gate would refuse that create.
- The query token now carries `#ref_count=N`, so the edge weight is compared on both sides.
- The lane went red twice:
  - the mock counted only a page's direct children;
  - it counted a token repeated in one block twice, where `block_links` holds one row per source and target.
- The mock now rolls each edge up to `COALESCE(page_id, parent_id, id)`, weights it by distinct edges, and orders by weight then both ids, as `fetch_page_link_edges` does.

**Owed links.**
- Batch create, paste (a new block and a splice into the anchor), draft flush and duplicate now go through `indexLinks`. A token to a trashed target is then owed, not linked, as the backend's create and edit ops make it.
- `link_owed_by_other_writers` pins all five. Each fix was shown red by removing its call.
- The duplicate hunk is one line, kept small for #6190's open work there.
- The spliced paste was first left out. The reviewer showed it was cheap to reach, so it is fixed and pinned too.

**Waived.** Import: the mock's importers are backend-only by decision (#5071), and the harness cannot import into its space.

**Left alone.** The `tagIds` filter on `list_page_links` reads direct tags only, while the backend also reads inherited tags and tag refs. Pages are roots, and no read either harness makes reaches it.

**Suites:**
- conformance nextest;
- the fuzz lane, 256 cases and 1000 via `cargo test`;
- vitest over `src/lib/tauri-mock`, `src/components/graph` and `src/hooks`;
- the graph e2e specs (`graph-happy-paths`, `graph-restore`, `graph-view`);
- typecheck, knip, clippy and fmt.
