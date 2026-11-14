# Session 4127 — engine loss windows 4, 6 and 2: a rolled-back write, two passes at once, rows ahead of the cursor

`Refs #6521`. The three windows the maintainer chose to close without a schema change, after the spike (session 4096, PR #6722). One commit per window.

## What shipped

**Window 4.** A snapshot pass can export an engine while a transaction's write sits in it uncommitted. When the transaction rolled back, the engine was rewound and nothing marked the space dirty, so the pass cleared the flag and the saved row kept a write nothing else holds. The rollback now marks each space it rewinds, after the rewind. It runs without the registry (a commit failure, a `Drop`), so the registry's dirty set became a shared `DirtySpaces` and each recorded checkpoint holds it.

**Window 6.** `mirror_sql_tombstones_onto_engine`, the one-time hydration and, since #6731, `save_kept_blocks` call `save_all_engines` themselves, and only `save_engines_and_advance_cursor` took the one-pass lock. The lock moved into `save_all_engines`. The outer function no longer takes it: the drain and the cursor move need no exclusion, and the cursor only moves forward.

**Window 2.** Boot applied every local op past the apply cursor, and the cursor can be behind the saved rows. Two changes:

- A pass writes its rows, and moves the stamp of every row it did not write, in one transaction (`write_pass`). A pass that cannot read the head, export a space or write a row writes nothing. Every row then carries one stamp.
- Boot applies the ops above both the cursor and the lowest row stamp. The ops between the two get their index fan-out and nothing else; the cursor is left for the next pass to move, after its drain.

## Why not the two designs the findings named for window 2

- **Skip per op by its space's stamp.** An op does not record its space. The apply handlers resolve it from SQL as it is at replay, in a score of places, and a `set_property(space)` writes two engines. A block a peer purged resolves to nothing, so its create would still replay and bring it back. Not complete, and not small.
- **Rows and cursor in one transaction after the drain.** The two bare callers have no queue to drain, and a queue that cannot drain would then stop the rows from being saved at all, which widens window 3. Putting only the rows in the transaction and letting boot read their stamp covers the bare callers and a failed drain with no plumbing.

## What this trades, for the maintainer

- **A space that cannot be saved now stops every space from being saved.** Before, the others were written. No such failure has been seen; a write failure on one file hits every row alike.
- **Rows an older build left with a space missing.** An older pass that failed one space's first write, or was killed between two rows, could leave that space with no row while the others moved on. Boot now skips its ops below the others' stamp, and its engine never gets them. It needs that failure or kill on the last run before the update. The old rule replayed them, onto the other engines too.
- **An op that commits between a pass's head read and its export** is in the row above its stamp, and is applied again if a kill comes before the next pass. The gap is the exports of the spaces ahead of it: seconds on a 100K-block space.
- **Window 4's residue.** Between the pass that saved the uncommitted write and the next one, the row on disk still holds it. A kill in that gap boots with it.

All four are in a comment on #6521 with options.

## Found by the independent read, not fixed here

`for_space` marks the space dirty before it takes the engine lock. A pass whose collect falls between the mark and the write exports the engine without the write and clears the flag. The write then sits in a space that reads clean, and the next pass moves the row's stamp over it. Microseconds wide unless the engine lock is contended. Older than this change; reported on #6521.

## Traps

- `main` gained a third direct caller of `save_all_engines` while this was built (`save_kept_blocks`, #6731). The comments that named the two callers were already stale at the merge; they now say "a direct caller".
- A `just gen-sqlx` killed mid-run leaves most of `src-tauri/.sqlx` deleted in the working tree. `git checkout HEAD -- src-tauri/.sqlx`.

- `snapshot_all_engines_during_concurrent_writes_2205` times out when run alone in this container, on unmodified `main` too, and passes inside the full suite. Its writers have no bound, so an idle box grows the documents faster than the exports can follow.
- Removing a runtime query from a file fails the dynamic-SQL hook until the baseline is re-anchored for that file: `node scripts/check-dynamic-sql.mjs --update-baseline <path>`.
- `target/debug/incremental` reached 10 GB; `CARGO_INCREMENTAL=0` kept the disk under its limit for the gates.
- A test that needs "the second row of a pass fails" cannot key its trigger on a space: the pass walks a `HashMap`. Key it on a row already carrying the pass's stamp.

## Tests changed, and why

- `snapshot.rs`: `failed_dirty_space_keeps_watermark_when_several_spaces_attempted_3309` became `a_pass_that_cannot_write_one_space_writes_none_6521`. It expected the pass to save the space that could be written (1 saved, stamps 1 / 500 / 500); it expects nothing saved (0, stamps 1 / 1 / 1), and the next pass to write both.
- `snapshot.rs`: `save_all_engines_does_not_advance_watermark_of_failed_dirty_space_3309` is deleted. It expected the clean row to move to 500 beside a failed one; that is the state the test above now forbids.
- `snapshot.rs`: `clean_watermark_refresh_bails_when_the_registry_was_cleared_4020` drives `write_pass` in place of the deleted `advance_clean_space_watermarks`. It expected `advanced == 0`; it expects the pass to fail. The row keeping its stamp is unchanged.
- `recovery/tests.rs`: `replay_over_an_engine_ahead_of_the_cursor_keeps_an_outdented_block_through_the_purge_5670` builds the exit save of a pre-#5418 build. Its fixture now also sets the row's stamp to that build's cursor, as that build did (`snapshot_watermark` read the cursor). Its assertions are unchanged.

## Ran

On the branch merged with `origin/main` at `875512b2`: `cargo nextest run --workspace` in two halves, `cargo test --doc --workspace`, `just gen-sqlx` (no diff), `SQLX_OFFLINE=true cargo check --workspace --all-targets`, `cargo clippy --workspace --all-targets -- -D warnings`, `just gen-bindings` (no diff), `prek run --hook-stage manual --all-files`. Counts are in the PR body.

Each new test was red before its fix on the assertion named in the PR body. Five more behaviours were shown red by one guarded mutation each: the fan-out range, the generation check, the clean rows' stamp move, a failed export skipped, and `MAX` for `MIN` in the lowest-stamp read. Not run: vitest, Playwright, WebdriverIO; no frontend file changed. No bench lane was dispatched: no bench or timed SQL changed.
