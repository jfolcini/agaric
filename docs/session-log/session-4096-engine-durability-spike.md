# Session 4096 — engine durability spike: a restart no longer undoes a peer's later write

`Refs #6521`. The spike the issue asks for first. Its findings are a comment on the issue; this log holds the measurements, the recommendation, and the one fix that shipped.

## The loss found, and the fix

A snapshot pass stamped each `loro_doc_state` row one below the op-log head it read, and then moved the apply cursor to that head. Every boot therefore rewound the cursor by one and replayed this device's newest op. A replayed op is not a no-op for the engine: `apply_edit_via_diff_splice` diffs the op's whole `to_text` against the engine's current text, and a property write lands as a newer last-writer-wins value. So if a peer changed the same block after that op, and a sync session saved the peer's change, the next restart wrote the old state back, and the next sync sent that to the peer. The peer's text or value was gone on both devices. No crash is needed: a clean exit and start does it.

Two tests in `spaces/session_save_tests.rs` show it, red on `3b717b1`: B's last op edits X to `abcB`, A extends it, B's session saves that, B restarts, and both devices end at `abcB`. The same with a select property (`1h` against A's later `2h`).

The fix: a pass stamps the head it read. A healthy boot then finds nothing to rewind and replays nothing. The `debug`-level branch that hid the routine one-op rewind (#4018) is deleted with the rule it served.

What the fix trades, for the maintainer:

- The replayed newest op used to mask one window for that op only: a pass that reads the head between a delete, restore or purge commit and its post-commit engine fan-out. `op_log_head`'s doc already accepts that window for every older op. It now covers the newest op too.
- Rows written by an older build are stamped one below their cursor, so the first boot after the update replays the newest op once more, and logs the stale-snapshot `warn` once.

## Windows, and what the tests showed

Run here, not committed, because each pins a loss that is still open (the test code is in the issue comment):

- **Rows written, cursor not moved.** A pass writes its rows, then drains the background queue, then moves the cursor. A kill in between (or a pass where one space failed to save, or the two callers of `save_all_engines` that never move the cursor) leaves the cursor behind the rows. Boot replays every local op since the old cursor onto engines that hold them. Result: the same loss as above, for every block those ops touched: `abcB, and A went on` became `abcB` on both devices.
- **Kill between an import's commit and the session-end save**, with a local edit on top. Boot replays the local edit onto an engine without the peer's edit, and the peer's text is in the block twice on both devices: `abcXZX`.
- **A pass exports a write whose transaction rolls back.** `DetachedRevert::revert` does not mark the space dirty again, so the pass clears the flag: the saved row held the rolled-back block, the live engine did not, and the space read clean.

Traced in code, not run: the post-commit fan-out window above, and two passes interleaving because `mirror_sql_tombstones_onto_engine` calls `save_all_engines` outside the one-pass lock.

## Measurements

Harness: `agaric-engine/src/loro/durability_cost_tests.rs`, an ignored test, command in its module doc. One space of `n` blocks, each edited `m` times. Release build without LTO, a 4-core cloud container, two runs. Each cell is the two runs' medians, then the lowest and highest sample of either run.

| | 10K blocks × 10 edits | 100K blocks × 10 edits |
|---|---|---|
| Snapshot export (what one pass costs per dirty space) | 54–61 ms [51–223], 1.4 MB | 791–807 ms [716–2688], 14.2 MB |
| Snapshot row write | 2.5–3.0 ms [2.2–50] | 46–62 ms [21–147] |
| Delta of one edit: export | 0.010–0.013 ms [0.009–0.22], 91 bytes | 0.013–0.028 ms [0.013–0.31], 93 bytes |
| Delta of one create | 0.021–0.032 ms [0.019–0.079], 223 bytes | 0.024–0.046 ms [0.021–0.19], 228 bytes |
| Delta of one property write (one run) | 0.014 ms [0.012–0.046], 95 bytes | 0.030 ms [0.016–0.062], 98 bytes |
| Delta row insert in an open transaction | 0.034–0.036 ms [0.033–0.31] | 0.033–0.046 ms [0.031–0.25] |
| Boot: snapshot alone | 62–86 ms [59–90] | 750–781 ms [715–878] |
| Boot: snapshot + 1000 deltas | 93–96 ms [90–122] | 895–1010 ms [815–1025] |
| Boot: snapshot + 1000 edits replayed (engine only) | 92–96 ms [90–111] | 893–951 ms [880–1018] |
| One sync update of 1000 edits: size, and import at boot | 13 KB, 27 ms [26–41] | 13 KB, 201–212 ms [194–234] |

Read as direction, not as deltas:

- A snapshot pass grows with the space. A delta does not: 10K and 100K overlap.
- A delta is three to five orders of magnitude smaller than the snapshot it would replace, in bytes and in time.
- At boot, importing 1000 deltas and replaying 1000 edits are inside each other's noise.
- The 1000-edit import includes the index rebuild `LoroEngine::import` runs over every live block.

Per importing session on a 100K-block space, the issue's three numbers:

- **Today, with the session-end save:** one snapshot pass for the space, about 0.5 to 0.8 s of export and 9 to 14 MB written, whatever the size of the import.
- **(1) Keep the inbox blob:** no write beyond the inbox row a session already writes (13 KB for 1000 edits). Boot imports it in about 0.2 s.
- **(2) Delta in the transaction:** the same 13 KB, stored with the projection. A local write adds about 100 to 230 bytes and under 0.1 ms.

Not measured: the SQL half of boot replay, the whole-tree projection a replayed inbox slot runs today (`loro_snapshot_bench`'s `cold_first_sync`, which has no 100K number yet), memory, Android.

## Recommendation

Option (2), built in stages, after the small fixes that need no schema. It needs one new table, which is the maintainer's to approve. The reasoning and the open questions are in the issue comment. Option (1) is not recommended: it also needs a migration, closes one window, and brings back an ordering problem between kept blobs and replayed local ops.

## Traps

- `set_todo_state_inner` writes several ops, so a test that needs "the last op is this property" must use `set_property_inner`.
- `effort` is a built-in select; a free-text value is refused.
- A test-only module with runtime `sqlx::query` must be named `*_tests.rs`, or the dynamic-SQL guard counts it as production code.
- `git mv -k` on an untracked file does nothing and exits 0.
- The debug build, a release build of one crate and clippy filled the container's disk; `target/debug/incremental` was 9 GB.

## Tests changed, and why

Each pinned the old stamp or the routine replay:

- `snapshot.rs`: four tests expected `head - 1` (499, 6); they expect the head (500, 7).
- `replay.rs`: `routine_one_op_rewind_does_not_warn_4018`, `a_stale_snapshot_still_warns_4018` and `a_missing_snapshot_warns_even_at_a_gap_of_one_4018` pinned the deleted log-level split. One test replaces them: a snapshot one op behind is rewound and announced. `heal_rewind_target_is_not_pinned_by_a_quiescent_space_3309` expected a rewind to 19; nothing rewinds now, and the cursor stays at 20.
- `recovery/tests.rs`: the #4018 boot test seeds the row at the cursor and asserts zero ops replayed; `crash_after_a_snapshot_pass_replays_only_the_tail_5418` expects the tail, not the tail plus one.
- `session_save_tests.rs`: the hydration test no longer needs a filler edit to keep the child's ops from being the replayed one.

## Ran

On `37bd056` plus this change: `cargo nextest run --workspace` in two halves (4046 and 4038 tests pass), `SQLX_OFFLINE=true cargo check --workspace --all-targets` and `cargo clippy --workspace --all-targets -- -D warnings`. `prek run --hook-stage manual --all-files` passed on the tree before it, `3b717b1` plus this change.

`main` then moved by four commits, one of which edits another line of `data-and-events.md`, so it was merged in. On that tree (`5675d4e` merged): the recovery, snapshot, session-save and daily-snapshot tests (278 pass), the offline check and clippy. The whole suite was not run a third time; CI's run on the PR is that check.

No SQL changed, so no `.sqlx` regeneration. The two new tests were shown red twice: on `3b717b1` before the fix, and with the old stamp put back by one guarded command. The three uncommitted tests were run again on the fixed tree and print the same losses. No bench lane was dispatched: no bench, fixture or timed SQL changed. Not run: vitest, Playwright, WebdriverIO; no frontend file changed.
