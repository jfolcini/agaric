# Session 1739 — the backlink query splits (#4639)

Refs #4639, thirteenth slice: the six `#[expect(clippy::too_many_lines)]` sites
in `agaric-store/src/backlink/` (`query.rs`: `eval_created_sort_keyset`,
`eval_property_sort_keyset`; `grouped.rs`: `eval_backlink_query_grouped`,
`eval_unlinked_references`; `filters.rs`: `resolve_filter_with_candidates`,
`compile_backlink_filter`). Pure moves: every SQL literal, bind, early
return and await point keeps its text and its order. The sweep total drops
67 → 61. It was 73 → 67 while this slice sat on 6539260: the brief's 67
counted #5007 as already merged when it was not. Rebasing onto that merge
moved both ends down by its six, leaving the delta of six unchanged.

## What moved

- `eval_created_sort_keyset` keeps the count, the slice and the cursor;
  the compose-and-bind block is `fetch_created_sort_page`. The two are one
  unit — the SQL's bare `?` are positional — so they moved together.
- `eval_property_sort_keyset` splits four ways: `property_sort_key` (the
  column/key/direction match, including the `Created` rejection),
  `property_sort_keyset_clause`, `fetch_property_sort_rows` and
  `property_sort_response`. The keyset clause and its binds leave as one
  pair for the same positional reason.
- `PropertySortKey` and `PropertySortBinds` are structs, not tuples: four
  `&str` in a row (column, key, order_dir, cmp) and two id-shaped `&str`
  plus two space slots are exactly where a positional swap compiles and
  silently mis-pages. Both are destructured at the top of their consumers
  so the moved bodies stay verbatim, `format!` captures included.
- `property_sort_response` takes `total_count` and `filtered_count` as
  two `usize`. That is the one same-typed pair left in an argument list;
  the call site passes locals of the same names, and the alternative (a
  struct invented for one call) buys nothing.
- `eval_backlink_query_grouped` becomes counts → page → members →
  groups: `count_grouped_backlinks`, `count_filtered_grouped_backlinks`,
  `fetch_group_page`, `fetch_group_members`, `sorted_capped_groups`. The
  two COUNTs stay on either side of `compile_backlink_filters`, because a
  zero `total_count` must still return before any filter is compiled — a
  filter that rejects (`DueDate` with `Contains`) must not start erroring
  on an empty backlink set.
- `GROUP_KEYSET_CLAUSE` is a `const` because it is a fixed `&'static str`
  either way; hoisting it is what let `fetch_group_page` fit. The long
  step-(b) comment describing that query's ordering and keyset arms moved
  with the SQL rather than staying above the call.
- `fetch_group_page` returns `GroupPage { groups, has_more }` with the
  page already cut to `limit`. The `+1` probe row is an implementation
  detail of that query and now never leaves it.
- `CappedGroup` replaces the 4-tuple both grouped surfaces built, and
  `distribute_rows_into_groups` is shared by them: the two fetch-and-
  distribute blocks were identical apart from binding by reference vs by
  value. `eval_unlinked_references` splits the rest into
  `unlinked_fts_query`, `unlinked_fts_matches`, `unlinked_total_count`,
  `filter_matching_ids`, `group_unlinked_matches` and
  `sorted_capped_unlinked_groups`.
- `empty_grouped_response` collapses the seven identical no-groups
  literals across the two grouped surfaces.
- `resolve_filter_with_candidates` and `compile_backlink_filter` are now
  dispatches over per-variant helpers, one helper per `BacklinkFilter`
  arm. `HasTag` / `HasTagPrefix` stay inline in the resolver: they are
  two-line delegations to `tag_query`, and a wrapper around a wrapper
  explains nothing.
- `compile_and` and `compile_or` stay as two helpers with duplicate
  bodies. Folding them into one `compile_combinator(…, sep)` worked and
  was reverted: it removed one `"({})"` from the file's string-literal
  multiset, which is the difference a reviewer's lexer is looking for. A
  20-line duplicate that HEAD already carries is not this slice's to
  delete.

## Adaptations that are not byte-for-byte moves

Each is behaviour-identical; they exist because a moved body crossed a
signature.

- `value.clone()` → `value.to_string()` (`resolve_property_text`,
  `resolve_property_date`, `compile_due_date`) and `vec![x.clone()]` →
  `vec![x.to_string()]` (`compile_todo_state`, `compile_priority`,
  `compile_block_type`): the leaves take `&str`, because `&String`
  arguments trip `clippy::ptr_arg` and an `#[allow]` is not on the table.
- `.bind(*value)` → `.bind(value)` in `resolve_property_num` (the `f64`
  is passed by value), `.bind(&fts_query)` → `.bind(fts_query)` in
  `unlinked_fts_matches`, and `AssertSqlSafe(sql.as_str())` →
  `AssertSqlSafe(sql)` in `fetch_property_sort_rows` (the SQL arrives as
  `&str`).
- `for x in &v` → `for x in v` where `v` became a slice parameter
  (`fetch_property_sort_rows`, `sorted_capped_groups`,
  `group_unlinked_matches`, `sorted_capped_unlinked_groups`).
- `fetch_group_page` truncates its `Vec` where the caller used to
  subslice it. Same rows, same `has_more`.
- `type UnlinkedGroup` exists because `group_unlinked_matches` returns
  `(Vec<(String, Option<String>, Vec<String>)>, usize)`, which trips
  `clippy::type_complexity` in return position. The alias is used in the
  two new signatures that need it; pre-existing annotations of the same
  tuple are left alone.

## Lifetimes

`resolve_filter_with_candidates` and `compile_backlink_filter` are
synchronous and generic over `'a`, returning a boxed future. The six
recursive helpers (`resolve_and`, `resolve_or`, `resolve_not`,
`compile_and`, `compile_or`, `compile_contains`) declare `<'a>`
explicitly and tie `pool`, the filter and the candidate set to it, since
the recursive call requires one shared lifetime. Nothing was turned into
an owned clone to avoid this, and no public signature changed. The type
recursion still terminates at the same `Pin<Box<dyn Future>>` it did
before. `sorted_capped_groups` needed its `<'a>` REMOVED: the capped ids
borrow a map local to that function, so the elided form is the one that
compiles.

## Verified

Measured, not assumed. Code lines below are from a counter that mirrors
clippy's rule (span lines, skipping blank and comment-only lines) but
counts the signature too, so clippy's own numbers run ~6-9 lower; the
gate is clippy itself, which is silent at threshold 70.

| function | before | after |
|---|---|---|
| `eval_created_sort_keyset` | 89 | 46 (+ `fetch_created_sort_page` 55) |
| `eval_property_sort_keyset` | 200 | 70 (+ 23 / 46 / 71 / 50) |
| `eval_backlink_query_grouped` | 289 | 65 (+ 25 / 37 / 72 / 46 / 49 / 28 / 14) |
| `eval_unlinked_references` | 238 | 61 (+ 44 / 37 / 13 / 28 / 26 / 37) |
| `resolve_filter_with_candidates` | 405 | 55 (+ 15 leaves, 8-60 each) |
| `compile_backlink_filter` | 166 | 58 (+ 8 helpers, 7-27 each) |

- `cargo clippy -p agaric-store --lib --tests -- -D warnings`: clean. No
  `#[allow]` or `#[expect]` added anywhere in the slice.
- `cargo fmt --all -- --check`: clean.
- `node scripts/check-bulk-equivalence.mjs`: `OK: 54 bulk-named
  function(s) inventoried (6 converged, 13 covered, 2 exception, 1 gap, 8
  not-a-fan-out, 9 read-only, 15 wrapper), no new entries, no stale
  entries`. No helper introduced here carries a `batch` / `bulk` /
  `by_ids` segment, so the baseline is untouched.
- `cargo nextest run -p agaric-store`: `1441 tests run: 1441 passed, 3
  skipped`.
- `grep -ro 'expect(clippy::too_many_lines' --include=*.rs src-tauri | wc
  -l`: 61 (was 67 on the rebased base; 67/73 before the rebase onto #5007).
- A Rust-aware lexer that decodes `\`-continuations compared the
  string-literal multiset of each file against HEAD: the only difference
  is the six deleted `expect` reasons. The keyset clause hoisted into
  `GROUP_KEYSET_CLAUSE` decodes byte-identically despite its new
  indentation, because a `\` continuation eats the following line's
  leading whitespace.
- Falsified on copies, each restored byte-exact (`cmp`):
  swapping `.bind(key)` and `.bind(block_id)` in the text arm of
  `fetch_property_sort_rows` reddens 9 backlink tests; `truncated: false`
  in place of `truncated: g.truncated` in `distribute_rows_into_groups`
  reddens 5; joining with `" OR "` in `compile_and` reddens 9.

Not run here: the full workspace suite, doc-tests and Playwright. No
public signature changed and every new item is private to its module, but
`-p agaric-store` does not compile the dependent crates, so the workspace
run is the reviewer's.
