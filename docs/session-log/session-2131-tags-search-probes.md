# Session 2131 — Tags and Search get 100K probes

#5366, proposed change 3. The Tags view opens on `list_all_tags_in_space`
and the Search panel on `search_blocks`. Neither had a probe in
`interactive_slo`. Four are added to `slo_green`:

- **`list_all_tags_in_space`** at 1K and at 10K tags over the 100K fixture.
  Tags and tagged blocks share the SLO space, because usage counts only
  blocks in the tag's own space. `tags_cache` comes from the production
  `rebuild_tags_cache`.
- **`search_blocks`**, page size 50 as the panel sends:
  - a 3-character query matching 10K blocks;
  - a word query matching 20.

  The FTS index comes from the production `rebuild_fts_index`.

Each probe asserts its exact answer before timing:

- **Tags:** the whole `(name, id, usage)` list.
- **3-character query:** the first page's 50 ids and `has_more`. Its
  10K matches have one hit each at the same length, so bm25 ties and
  the id tiebreak orders them.
- **Word query:** the 20 seeded ids and no more.

The budgets start at the 30 ms list tier. A probe over that gets the
measured time doubled, never above 200 ms, from the CI `bench-slo` run
on this branch.

Ran: `cargo clippy --bench interactive_slo -- -D warnings` in the lane,
and rustfmt. The probes run only in `bench-slo`.
