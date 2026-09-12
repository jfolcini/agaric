# Session 1719 — the `toggle_filter.rs` splits (#4639)

Refs #4639, third slice: the three `#[expect(clippy::too_many_lines)]`
sites in `agaric-store/src/fts/toggle_filter.rs`, the FTS search paths
with toggles (`search_with_toggles`, `search_with_toggles_partitioned`,
`regex_mode_query`). Pure moves; SQL text, parameter order, result
ordering, `total_count`, cursor semantics and the UTF-16 `MatchOffset` /
`<mark>` snippet contract are untouched.

- `search_with_toggles` (96 lines): the FTS5 side of the dispatch is
  `fts_page_with_toggles` (the plain `search_fts` call when every toggle
  is off, else compose the literal pattern, build the regex, fetch the
  post-filtered page, truncate); the blank-query and regex branches stay
  in the dispatcher.
- `search_with_toggles_partitioned` (159): cut along the regex/FTS
  dispatch into `regex_partitioned_scan` (early cancel, the two `limit + 1`
  probe scans, the biased select against `cancel`, survivor `has_more` and
  truncation) and `fts_partitioned_with_toggles` (the straight
  `search_fts_partitioned` when toggles are off, else the over-fetched
  post-filtered partitions). A first cut along the blank-query dispatch
  left the dispatcher at 78 because the twelve-argument calls cost a line
  each; this cut leaves it at 66.
- `regex_mode_query` (109): `compose_regex_pattern` (the `MAX_QUERY_LEN`
  guard, NFC normalisation and the `(?i)` / word-boundary composition,
  sibling of the existing `compose_literal_pattern`) and
  `scan_regex_candidates` (the SQL, the structural filters, the
  `REGEX_PRE_FILTER_CAP` bind and the saturation warning), which takes the
  pre-existing `StructuralFilterInputs` bundle rather than seven loose
  arguments. The offset post-processing stays in the caller.

The three twelve-argument helpers carry `#[allow(clippy::too_many_arguments)]`,
repeating the attribute their parents already had (the threshold is
clippy's default and the repo's sole convention is `allow`, 66 sites);
bundling the search arguments into a new struct would change the public
signatures for a line-count fix. Suppression count in the file is
unchanged at nine.

## Verified

`cargo clippy -p agaric-store --lib --tests -- -D warnings` prints nothing
with the three attributes gone; `SQLX_OFFLINE=true cargo check --workspace
--all-targets` 0 warnings; `cargo nextest run --workspace` 6318 passed, 13
skipped; `cargo test --doc --workspace` 10 passed. The regex path's
dynamic SQL region was diffed old against new: byte-identical apart from
the `apply_structural_filters` call taking the pre-built bundle. Falsified
on copies: a post-filter closure replaced by `|_| true` reddened four
`be_a10_*` cursor-pagination tests; both `apply_post_filter` calls dropped
reddened `toggle_on_post_filter_keeps_match_beyond_preview_cap`; the
structural filters dropped reddened `regex_path_applies_tag_filter`; the
reviewer independently forced `(?-i)` in `compose_regex_pattern` and
reddened `partitioned_regex_bare_alternation_matches_both_arms_under_case_flag`.
All restored, `cmp` clean. Attribute count on this branch 116 to 113.
