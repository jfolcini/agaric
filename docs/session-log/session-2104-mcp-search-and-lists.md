# Session 2104 — MCP search matches the app's tags; lean rows; list_pages on metadata

The remainder of #5398 and #5401.

- **Search tags.** MCP `search` now matches a tag the block carries inline or
  inherits, not only one attached to it. The mode is
  `SearchFilter.tags_match_inline_and_inherited`, `#[serde(skip)]` so only the
  MCP tool can set it and the IPC wire, bindings and mock stay as they were. It
  reuses the tag query engine's leaf (`tag_leaf_subquery_body(true)`) on both
  the FTS path and the empty-query/regex path.
- **Search filters and rows.** `last_edited` takes the app's `LastEditedSpec`;
  every row carries `page_title` from one batch lookup shared with `get_block`
  and `query`; `match_offsets` only with `include_match_offsets`. The
  description was re-derived from the engine (substring words, 3-char minimum,
  ranking, empty-query behaviour, direct-children `parent_id`).
- **Lean rows.** `omit_null_block_fields` in `to_tool_result` drops null fields
  from block rows across every tool. Objects without `block_type` keep their
  documented nulls. A size test pins `get_page` and `search` at (783, 604)
  bytes, down from (1160, 764).
- **`list_pages`** runs on `list_pages_with_metadata_inner` with the Pages
  view's sorts and filters, cursor-checked per sort, rows with last-modified,
  inbound-link and child counts. Default order is now alphabetical, the Pages
  view's default. `list_pages_inner` had no other caller and is gone.

Review added a search cursor test in the tag mode (its clause binds each tag
three times before the cursor binds) and fixed a stale bind-count comment.
Falsified: tag mode off, null-omission off, and sort forced to creation order
each reddened their test. Not done: `page_title` on agenda, trash and
`get_page` children rows (the last is deliberate: the page is in the same
response).

Gates: whole-workspace nextest (6838, 0 failed), clippy, `SQLX_OFFLINE=true
cargo check --workspace --all-targets`, `cargo fmt --check`, bindings
unchanged.
