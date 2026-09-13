# Session 1740 — the cache rebuild splits (#4639)

Refs #4639, the slice that finishes `agaric-store/src/cache/`: the seven
`#[expect(clippy::too_many_lines)]` sites in `block_links.rs`
(`reindex_block_links_conn`, `reindex_block_links_split`), `block_tag_refs.rs`
(`reindex_block_tag_refs_in_tx`, `reindex_block_tag_refs_split_in_tx`),
`page_links.rs` (`recompute_rows_for_rollup_key`), `agenda.rs`
(`apply_sort_merge_rebuild`) and `purge.rs` (`purge_block_satellite_caches`).
Pure moves: every SQL literal, bind and bind ORDER, early return and await point
keeps its text and its position.

Counts below are clippy's own metric (its diagnostic prints it); the line
numbers in brackets are before → after.

- `purge_block_satellite_caches` (106 → 5): the eleven-DELETE chain splits at
  the seam its own module doc already draws — `purge_tag_property_and_link_rows`
  (52) for the rows that name a member block directly (`block_tags`,
  `block_tag_inherited`, the two `block_properties` sweeps, `block_links`,
  several of which match a member from more than one column) and
  `purge_cache_and_lookup_rows` (57) for the six single-id-keyed caches and
  lookup satellites. The eleven `DELETE FROM` statements are byte-identical and
  in the same order; the caller runs the two halves back to back on the same
  borrowed `&mut SqliteConnection`, so the chain is still one caller-owned
  transaction with no commit anywhere inside it.
- `recompute_rows_for_rollup_key` (76 → 58): only the read comes out, as
  `read_touched_targets_for_rollup_key` (22). Cutting on the read/write seam
  leaves the aggregate UPSERT and the zero-edge DELETE adjacent in the caller,
  where their ordering is the thing that matters — the UPSERT must run before
  the sweep that removes what it did not write.
- `reindex_block_links_conn` (89 → 40) and `reindex_block_links_split` (95 →
  47): each gets `read_recorded_link_targets{,_split}` (22/22) for the
  `UNION ALL` read plus the fold into `old_targets` / `had_unresolved_rows`, and
  `write_block_link_diff{,_split}` (35/35) for the `json_each` DELETE + upsert.
  The split variant's helper takes `&mut sqlx::SqliteConnection` (called with
  `&mut tx`, the same deref-coercion the adjacent `sync_unresolved_links` call
  already relies on) and writes only; the caller still
  owns `begin_immediate_logged`, the `sync_unresolved_links` call that must
  observe the upsert, and `tx.commit()` — one transaction, unchanged.
- `reindex_block_tag_refs_in_tx` (71 → 42) and
  `reindex_block_tag_refs_split_in_tx` (71 → 43): the same write-phase cut,
  `write_block_tag_ref_diff{,_split}` (33/33). Both were barely over, so a
  one-statement shave would have done — the read/diff-then-write seam was
  chosen instead because it is the same seam as `block_links.rs`'s and leaves
  the next comment paragraph room.

**The four `*_split` twins stayed twins.** `write_block_tag_ref_diff` and
`write_block_tag_ref_diff_split` carry the same SQL, and so do
`read_recorded_link_targets{,_split}` and `write_block_link_diff{,_split}`;
each pair is two private helpers, not one shared one. Folding a pair would
delete one copy of a SQL literal that HEAD carries twice, which is a change to
what the file says, not a cleanup this slice is entitled to. Applying the SAME
two extractions to both members of a pair was deliberate for the same reason:
a deliberately duplicated pair is only safe while the two read alike.

- `apply_sort_merge_rebuild` (94 → 22): `merge_agenda_streams` (67) is the
  lockstep walk — the `pull_desired!` macro, the four-arm merge and the
  mid-stream flush — and `flush_pending_agenda_diff` (12) is the `&str`-view
  build plus the `apply_agenda_diff` call that HEAD spells out twice. The walk
  takes both streams by `&mut`, so `drop(desired_stream)` /
  `drop(current_stream)` stay in the caller, in front of the final flush,
  exactly where the comment says they belong. The macro stayed a macro: it
  exists to keep the dedup bound to the desired-advance step, and rewriting it
  as a function is a restructure, not a move.

Two type aliases, `DesiredAgendaStream` / `CurrentAgendaStream`, exist so
`merge_agenda_streams` can name the two `fetch(...)` streams in its signature.
No struct was needed anywhere in this slice: every value crossing a seam is
either a single value or a pair of different types
(`(HashMap<String, String>, bool)`), so there is no same-typed tuple slot for a
silent swap to hide in.

No `#[allow]` or `#[expect]` was added, no existing item was renamed, and no
statement moved across a commit. `scripts/check-bulk-equivalence.mjs` matches
`_`-separated segments exactly equal to `batch` / `bulk` / `by_ids`; none of the
eleven new helper names has one, so the baseline is untouched. The agenda flush
helper is `flush_pending_agenda_diff` because that is what it does — it flushes
the pending buffers — and not to dodge the heuristic: no function was renamed,
only new ones named.

## Verified

Counted, not assumed: `grep -ro 'expect(clippy::too_many_lines' --include=*.rs
src-tauri | wc -l` goes from **61 to 54** across the workspace. (It was
67 → 60 while this slice sat on 26f77d7; rebasing onto #5008 moved both ends
down by its six, leaving the delta of seven unchanged.)

- `cargo clippy -p agaric-store --lib --tests -- -D warnings`:
  `Checking agaric-store v0.1.0 … Finished dev profile … in 28.49s`, no
  diagnostics. With `-D warnings` this is the oracle in both directions — the
  attributes are gone, so a function still over 70 would fail here.
- Falsified on copies and restored byte-exact (`cmp` clean on all five files):
  re-adding `#[expect(clippy::too_many_lines, reason = "falsification probe")]`
  to `merge_agenda_streams`, both `reindex_block_links_*`, both
  `reindex_block_tag_refs_*_in_tx`, `recompute_rows_for_rollup_key` and
  `purge_cache_and_lookup_rows` produces seven
  `warning: this lint expectation is unfulfilled` — so clippy really does
  evaluate each of them and really does find them under the ceiling.
- The same mechanism pinned the metric before the work: removing the expect
  from `reindex_block_tag_refs_in_tx` on HEAD printed
  `this function has too many lines (71/70)`, which is what the split sizes
  above are measured in.
- String-literal multisets of all five files lexed before and after
  (comment-aware, raw-string-aware, with Rust's `\`-newline continuation
  applied so the dedent inside a wrapped SQL literal is not counted as a
  change). The only difference is `'#4639: split before growing'`:
  1/2/2/1/1 → 0.
- `DELETE FROM` order in `purge.rs`: the same eleven tables in the same order
  before and after (`block_tags`, `block_tag_inherited`, `block_properties` ×2,
  `block_links`, `agenda_cache`, `tags_cache`, `pages_cache`, `fts_blocks`,
  `page_aliases`, `projected_agenda_cache`).
- `cargo fmt --all -- --check`: clean (run after `cargo fmt --all`, which
  reflowed the dedented helper bodies).
- `node scripts/check-bulk-equivalence.mjs`:
  `OK: 54 bulk-named function(s) inventoried (6 converged, 13 covered, 2
  exception, 1 gap, 8 not-a-fan-out, 9 read-only, 15 wrapper), no new entries,
  no stale entries`, exit 0.
- `cargo nextest run -p agaric-store`:
  `Summary [65.457s] 1441 tests run: 1441 passed, 3 skipped`.
- `cargo check -p agaric --lib`: `Finished dev profile … in 54.65s` — the app
  crate still compiles against the changed crate (`-p agaric-store` alone would
  not have said so).

Not run here, left to the reviewer: `cargo nextest run --workspace`,
`cargo test --doc`, the four `sqlx prepare --check` lanes and the `prek` hook
set. No SQL text changed, so no `.sqlx` cache entry can have moved; nothing
outside `src-tauri/agaric-store/src/cache/` is touched. Playwright was not run:
no frontend file is touched.

Two things a reviewer should check rather than take on trust. The moved blocks
are pure moves except three adaptations forced by the extraction:
`write_block_link_diff_split` takes `write_conn: &mut sqlx::SqliteConnection`
and so spells its two executes `.execute(&mut *write_conn)` where the inlined
code said `.execute(&mut *tx)` (`&mut tx` deref-coerces at the call site, as it
already does for `sync_unresolved_links`);
`read_touched_targets_for_rollup_key` ends `Ok(touched_targets)` where the
inlined code simply bound the local; and `source_space` moves into the two
write helpers by value instead of living as a local, so the bind expression
`&source_space` / `source_space` is unchanged but its owner is not. And
`merge_agenda_streams` lands at 67/70 — under, but the tightest function in the
slice: three more lines of *code* in that walk re-trip #4639. Comments are
free — clippy's `too_many_lines` counts neither blank nor comment-only lines,
so the 101-line item measures 67.
