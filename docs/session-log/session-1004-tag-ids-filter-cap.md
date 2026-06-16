# Session 1004 — cap the unbounded `tag_ids` filter array (#1325)

`/loop /batch-issues` run (2026-06-16), one of three issues built in parallel isolated
worktrees (#1325 this, #1341 checkbox guard, #1345 agenda errors).

## Shipped

- **#1325 — unbounded `tag_ids` filter on the no-clamp listing IPCs.** The two no-clamp
  "return all of X" IPCs accepted a caller-supplied `tag_ids` filter with no length bound, so
  the dynamic SQL placeholder count / bind loop (listing) and the per-tag query fan-out (tags)
  scaled 1:1 with caller input — a SQLite param-limit error on attacker input, or a cheap
  CPU/memory DoS during query construction. The *result* set is intrinsically bounded by the
  space's page/tag count, but the *filter input* was not.

  Fix: added `pub(crate) const MAX_FILTER_TAG_IDS: usize = 1000` in `commands/tags.rs`
  (mirroring `MAX_BATCH_BLOCK_IDS`), and in **both** `query_by_tags_inner` (`commands/tags.rs`)
  and `list_all_pages_in_space_inner` (`commands/pages/listing.rs`) reject
  `tag_ids.len() > MAX_FILTER_TAG_IDS` with `AppError::Validation("tag_ids.too_many")`
  **before** any SQL/bind/`TagExpr` construction. Each function's docstring documents the cap
  + rationale. Extends the same defense already present on the MCP search surface (#699) to the
  two listing IPCs.

## Tests

- One over-cap test per function (`page_cmd_tests`, `query_cmd_tests`): build a
  `MAX_FILTER_TAG_IDS + 1` array against a fresh empty pool (where a DB-reaching query would
  return `Ok`), so the `Err` proves the guard fires pre-DB; both assert the exact
  `AppError::Validation("tag_ids.too_many")` code. Boundary: 1000 allowed, 1001 rejected.
- Independent adversarial reviewer ran the full suite: **4190 passed, 0 failed**;
  `cargo clippy --all-targets` clean; confirmed guards precede all allocation, the cap is safe
  vs SQLite's `SQLITE_MAX_VARIABLE_NUMBER` (32766), and the tests discriminate with a correct
  boundary.

Dimension robustness-bounds · severity medium.
