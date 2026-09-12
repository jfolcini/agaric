# Session 1734 — the `agaric-engine` coordinator and apply splits (#4639)

Refs #4639, ninth slice: the six `#[expect(clippy::too_many_lines)]`
sites in `agaric-engine` (`materializer/coordinator.rs`: `build`,
`try_enqueue_background`, `status_with_sync`; `apply/loro_apply.rs`:
`hydrate_page_subtree_into_engine`, `apply_move_block_via_loro`,
`purge_block_sql_cascade`). Pure moves: every write, engine call, queue
send and spawn keeps its order, every SQL literal and log line is
byte-identical, and the one pre-existing `type_complexity` allow went
away in favour of a named tuple type.

- `build`: the two consumer spawns and the initial block-count task are
  now `&self` methods (an associated fn would have needed ten
  arguments), so the struct literal is assembled first; it has no side
  effects, and the six spawns keep their relative order.
- `try_enqueue_background`: `shed_background_task` is the whole `Full`
  arm and `persist_shed_task` the body of its spawned task, awaited under
  the same guard.
- `status_with_sync`: the timing conversion and the retry-queue count are
  helpers; the reads happen in the same order.
- `hydrate_page_subtree_into_engine`: `read_seed_node` is the per-row
  read and `seed_nodes_into_engine` the synchronous guard scope.
- `apply_move_block_via_loro`: `move_block_in_engine` is the engine guard
  scope (the not-found branch became an early `return Ok(None)` after the
  same reads) and `mirror_swept_cohort_into_engine` the swept-cohort arm.
- `purge_block_sql_cascade`: the descendant walk, the five relation
  `DELETE`s, the eight derived-table `DELETE`s and the three link-ref and
  doc-state `DELETE`s each moved as a group, in statement order; the
  parent keeps the PRAGMA, the final `DELETE FROM blocks` and the `DROP`.

## Verified

Reviewer (opus) read the full `-U5` diff hunk by hunk against `HEAD`
and confirmed the three `build` claims: the struct literal only
allocates (`OnceLock`, atomics, `QueueMetrics::default()`), the spawn
order is fg → bg → block-count → metrics → the two debounces in both
revisions, and the `write_pool` handle count is three either way.
`shed_background_task` keeps the `Ok` → `Full` → `Closed` arm order and
the `_shed_guard` lifetime; `move_block_in_engine` does the same reads
before its early return. Lexed string-literal multisets of both files
differ from `HEAD` only by the three deleted `expect` reasons per file
and one deduplicated `OnceLock` message; the purge cascade is the same
24 statements in the same order.

- `cargo clippy -p agaric-engine --lib --tests -- -D warnings`: clean,
  no `unfulfilled_lint_expectations`, no `#[allow]` or `#[expect]` left
  in either file.
- `cargo fmt --all -- --check`, `cargo check --workspace --all-targets`,
  `node scripts/check-bulk-equivalence.mjs`: clean.
- `cargo nextest run --workspace`: 6318 passed, 13 skipped.
- `cargo test --doc --workspace`: all lanes ok.
- Falsified on a copy: dropping the
  `delete_purge_link_refs_and_doc_state` call reddens
  `purge_clears_block_tag_refs_and_page_link_cache` (the purge connection
  runs with `PRAGMA foreign_keys = OFF`, so the final `DELETE FROM
  blocks` cannot mask a missing explicit `DELETE`); restored, `cmp`
  clean.

One correction to the builder's rationale: `page_aliases` cascades from
`blocks` (migration 0061), `fts_blocks` does not (FTS5 virtual table, no
trigger), so its explicit `DELETE` is load-bearing and merely untested.
