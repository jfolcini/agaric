# Session 4165 — boot builds each engine from its saved rows (#6521, stage B)

`Refs #6521`. Stage B of the plan approved on the issue: boot builds each space's engine from its `loro_doc_state` snapshot and the `loro_doc_delta` rows stage A (session 4132) saves with every engine write, and no longer replays the op log into engines. The design note went on the issue before any code (comment 6872629807); this log records what the build changed in it.

## What shipped

- **`rehydrate_registry`** (`agaric-engine/src/loro/snapshot.rs`) builds an engine from its snapshot and its rows through `LoroEngine::import_saved_rows`: the snapshot, then the rows as one `import_batch`. A space with rows and no snapshot is built from the rows alone. A space built from rows is marked dirty.
- **`recover_at_boot`** (`agaric-sync/src/recovery/boot.rs`) skips the cursor heal and the replay, and dispatches the index fan-out (#3298) for the local ops above the cursor (`replay::fan_out_ops_past_the_cursor`). The inbox replay, the drafts and the backfills are as they were.
- **The marker** `loro.boots_from_saved_rows`, one `app_settings` row, says the saved rows hold every engine write that committed. Without it boot is the older one, unchanged: `delta::start_replay_boot` deletes the marker and every row in one transaction, the engines come from the snapshots, the heal and the replay run. `recover_at_boot` sets it at its end when the replay did not abort, every draft's op reached the engine, and no op is parked in `materializer_retry_queue`.
- **A snapshot pass commits nothing when an engine was rewound since its collect** (`LoroEngineRegistry::no_rewind_since`, checked in `write_pass`). Each rollback checkpoint counts as open until it is dropped; the pass waits, inside its write transaction, for the count to reach zero.
- **Disaster recovery** (`db/recovery.rs::reproject_blocks_from_engine`) clears the marker when it rebuilds SQL from the snapshots.

No schema change. The marker is a row in a table that exists.

## Decisions, and what the build added to the design note

- **Why a marker.** A vault from a build before stage A and one from stage A show the same cursor and stamps; only the first lacks rows for its ops past the stamp. Inferring it from "no rows, and ops past the stamp" reads a replay boot killed part-way as finished.
- **Rows that leave changes pending send boot through the replay**, they do not stop it. The replay loses what the older boot lost and nothing more, because the pass still stamps its rows as before. A row that will not import does stop boot, as an unreadable snapshot does.
- **Found while building: draft recovery writes in two steps.** A draft's op and SQL row commit in one transaction, and its engine apply runs later through the foreground queue. A kill in between left an op in the log that only the replay would apply. So the marker is cleared before a draft is written back and set again once the queue has drained. A draft that fails before its op commits does not hold the marker back: an over-long draft fails that way at every boot for as long as its row stays. Nothing else in production appends an op and applies it later.
- **Found while building: a pass moves the stamp of rows it does not write.** An engine built from a row plus deltas is clean after `install_engine`, so the next pass would have moved its stamp over ops only a delta held, and a later replay boot would skip them. Hence the dirty mark.
- **Found while building: an op parked in the retry queue is in no engine.** The older boot also reached it through the heal's rewind. While one is parked the marker stays absent.
- **The pass's rewind check counts open checkpoints instead of ordering on the lock release**, because the materializer's apply paths drop their transaction before they rewind, and a failed commit releases the lock before anyone knows it failed.

## The independent read

A second model read the diff before the last full run, without building. Acted on:

- **Rows were deleted before the snapshots were known to import.** With rows that leave changes pending in one space and an unreadable snapshot in another, boot discarded every row and then stopped. The snapshots are now imported first.
- **A rollback can rewind an engine past a sync import** (item C of stage A's notes, with a consequence it did not list). The import writes the engine outside the write lock and saves its row later. If the import appended ops of this device's own (the kept-text moves of #6561, the sibling-order migration), those ops sit on top of the rolled-back write; the rewind drops them, their row is saved all the same, and the next commits reuse the op ids they were built on. A boot from those rows would apply them to another history. The rewind now notes when it dropped another peer's ops, and the next commit clears the marker, so that boot replays.
- A misplaced doc comment, a second read of the drafts, and a branch that could not be taken.

Confirmed and not fixed here: the cascade window below. The read's judgement is that it will be met in practice, more often than the design note allowed.

## Traps

- `LoroDoc::import_batch` reports what is pending for the whole doc only when given two or more blobs; with one it returns that blob's own status. Both are right here, since the snapshot leaves nothing pending.
- A row can depend on a later row: a sync import writes the engine before its projection saves its delta, and a local write made on top can commit first. Judging "pending" row by row calls that a gap (`a_row_that_depends_on_a_later_row_builds_the_engine_6521`).
- The two-device harness (`spaces/session_save_tests.rs`) never booted a device before using it, so every `kill_and_boot` was a first boot and went through the replay. It now boots each device as the app does, and each kill-and-boot scenario runs under both boots.
- Comparing the two boots by engine version is wrong: the replay mints op ids of its own. The oracle tests compare what the engines hold (every block's text, place, tombstone, tags, properties) and SQL.
- The replay boot ranks again every sibling group it touched, where a session leaves a gap in SQL `position` after a purge. The oracle's SQL comparison leaves the ranks out; the saved-rows boot's SQL is compared whole.
- Purging a whole space through `purge_block_inner` leaves that space's engine, snapshot and rows in place; only the apply path (`apply_purge_block_via_loro`) evicts them. The replay boot happened to drop the engine when no pass had saved it. Not changed here.

## Existing tests edited

- `a_pass_that_saved_a_write_which_then_rolled_back_is_saved_over_6521`, renamed `a_pass_writes_nothing_when_a_write_it_exported_rolled_back_6521`: it asserted that a pass saved the uncommitted write and the next pass saved over it. A pass now writes nothing in that case.
- `spaces/session_save_tests.rs`: ten kill-and-boot tests take the boot as a parameter and run under both; their assertions are unchanged. The fixture `a_child_stranded_under_a_peers_page` boots through the replay, because the state it builds (an import lost from the engine by a kill) is one only the older boot leaves.

## Measurements

`boot_cost_6521` (`agaric-sync/src/recovery/tests.rs`, ignored; its doc comment has the command) boots copies of one database both ways, interleaved, five samples each: `rehydrate_registry` then `recover_at_boot`, over one space a pass saved and 1000 edits committed after it with their deltas. Release build without LTO, a 4-core cloud container, two runs. Each cell is the two runs' medians, then the lowest and highest sample of either run.

| | 10K blocks | 100K blocks |
|---|---|---|
| Boot from saved rows | 124–125 ms [116–159] | 802–876 ms [789–906] |
| Boot replaying the op log | 428–429 ms [367–1154] | 1074–1177 ms [1045–1395] |

Direction: the boot from saved rows is the faster one at both sizes, and the two boots' ranges do not overlap in either run. The gap is the replay of the 1000 edits against the import of their deltas; what both boots share (the snapshot import, the index rebuild, the fan-out) grows with the space.

Engine only (`durability_cost`, one run, same build), the snapshot plus 1000 deltas imported as boot now does it against the snapshot plus 1000 edits re-applied to the engine alone:

| | 10K blocks, no history | 10K, ten edits a block | 100K, no history | 100K, ten edits a block |
|---|---|---|---|---|
| Snapshot + 1000 deltas | 128 ms [127–150] | 141 ms [134–156] | 1168 ms [994–1471] | 1019 ms [947–1219] |
| Snapshot + 1000 edits, engine only | 80 ms [79–123] | 128 ms [89–134] | 1139 ms [982–1272] | 967 ms [920–1040] |

At 10K blocks with no history the delta import is the slower of the two; in the other three cases the ranges overlap. The engine half of a replay was never the expensive half: the gap in the first table is the SQL half, which a boot from saved rows does not run.

Not measured: a real vault through `scripts/measure-boot.mjs` (it needs two release app binaries and a copy of a large vault; none is committed), memory, and anything on Android.

## What ran

On the finished tree, merged with `main` at `f57013f` (#6771 and #6772):

- `cargo nextest run --workspace` in two halves: 4106 and 4100 tests pass.
- `cargo test --doc --workspace`; `cargo clippy --workspace --all-targets -- -D warnings`; `just gen-sqlx`, then `SQLX_OFFLINE=true cargo check --workspace --all-targets`; `prek run --hook-stage manual --all-files`.
- Each new test was shown red by one mutation of the code it covers, in one command that restored the file on exit. `an_unreadable_snapshot_stops_boot_before_any_row_is_discarded_6521` stayed green under its mutation at first: its unreadable snapshot was imported first, so boot stopped before the order mattered. The fixture was fixed and the mutation then killed.
- `snapshot_all_engines_during_concurrent_writes_2205` times out when the engine crate's tests are run alone in this container and passes inside the whole suite, as session 4127 found on `main`.

Not run: vitest, Playwright, WebdriverIO (no frontend or command-surface change; CI runs those lanes), and no bench lane.

## Left for stage C and after

- The replay code is still in the binary: it is the first boot after the update and the fallback for rows that cannot be used.
- Window 5 (a kill between a delete, restore or purge and its cascade) is open, and under this boot a kill in the gap loses the cascade whether or not a pass ran in it.
- The session-end save and compaction on size are stage C.
