# Session 4205 — Engine state: compact on size, no save at a session's end (#6521, stage C)

Stage C of #6521, the last. Stage A (#6767) saves a `loro_doc_delta` row with every engine write in its own transaction; stage B (#6777) builds each engine at boot from its snapshot and those rows and replays no op; #6785 moved the delete, restore, purge and move cascades into the op's transaction; #6793 drops a purged space's engine and rows. What was left: stop the session-end save, compact on size, decide the inbox replay.

## The save paths, each decided

| Path | Before | Now |
|---|---|---|
| A sync session's end (`SpacePlacementSink`, #6525) | a snapshot pass after every session that changed something, and after an `Error` or a converged session while an engine was dirty | deleted: an import's delta commits with its projection |
| The backgrounded maintenance job `loro_snapshot_if_dirty` | a pass every 60 s while backgrounded and dirty | deleted: a second copy of the periodic tick |
| The periodic task (`spawn_periodic_compaction`, five minutes) | a pass | `compact_when_due` |
| OS suspend (mobile) | a pass | `compact_when_due`: Android freezes the process, often before the tick |
| App exit | a pass | `compact_when_due`: a session shorter than the tick still compacts |
| `Headless::shutdown` | the suspend pass | `compact_when_due`, as suspend |
| Op-log compaction (`save_engines_then_compact`, #6518) | a pass first | kept: the purge deletes ops the replay fallback restores engines from |
| The one-time hydration repair, mirrored tombstones, blocks kept from a purge | `save_all_engines` | kept: none of these writes is in the op log, so only a snapshot keeps it across the replay fallback, which deletes the rows |

`compact_when_due` runs a snapshot pass once one space's delta rows reach `DELTA_COMPACTION_BYTES`. The pass writes every dirty space, not only that one: `write_pass` moves the stamp of every row it does not write, which holds only for a clean engine, and the replay fallback reads those stamps. Below the threshold it reads the op-log head, drains the background queue and moves the apply cursor, so the next boot does not fan the index work out again (#3298). That is safe for the fallback: a replay boot rewinds a cursor above the lowest row stamp before it applies anything (`heal_orphaned_apply_cursor`).

## The threshold

`durability_cost_tests::boot_by_tail_size` (new case in the committed harness; command in its module doc) boots a space from its snapshot plus a delta tail of 0, 1000, 4000 and 16000 typed words, one row each, and times the export a compaction then runs. Release build without LTO, a 4-core cloud container, one run; each cell is the median of five, then the range.

| Tail | 10K blocks, no history | 10K, ten edits a block | 100K, no history | 100K, ten edits a block |
|---|---|---|---|---|
| none | 69 ms [65–97] | 71 ms [67–72] | 889 ms [857–1089] | 890 ms [851–1284] |
| 1000 deltas (90 KB) | 102 ms [97–124] | 117 ms [104–161] | 936 ms [899–1088] | 1074 ms [987–1298] |
| 4000 deltas (360 KB) | 186 ms [178–215] | 210 ms [206–212] | 1077 ms [1014–1273] | 1187 ms [1155–1310] |
| 16000 deltas (1.4 MB) | 465 ms [453–519] | 554 ms [527–729] | 1704 ms [1466–2547] | 1682 ms [1634–1804] |
| Compaction export after the longest tail | 54 ms [46–141] | 68 ms [63–255] | 370 ms [359–1272] | 470 ms [450–1099] |

Direction: the cost grows with the tail at both sizes. On a 100K-block space a tail of 4000 deltas is still inside the range of the boot with none, and one of 16000 is outside it in both cases. On a 10K-block space every tail is outside the no-tail range, but the absolute cost stays below a snapshot export of the large space. `DELTA_COMPACTION_BYTES` is 256 KiB, below the 4000-delta tail: about 2800 typed words between two exports of a space, where the old schedule exported every dirty space every five minutes and at every session's end.

A cascade over every block of a 100K-block space writes one row of about 1 MB (the existing `cascade_in_its_transaction` case), so one such delete is followed by a compaction at the next check.

## The inbox replay stays

A sync import reaches the engine after its write-ahead `loro_sync_inbox` slot and before its projection commits. A compaction in that gap saves the import in the snapshot; a kill before the projection then boots with the import in the engine and not in SQL, and the peer does not send it again, because this device's version vector holds it. Only the slot's replay at boot projects it: `a_compaction_between_an_import_and_its_projection_is_healed_by_the_inbox_6521`. The replay is also how a projection that failed is retried at the next start, and how a slot that keeps failing reaches the quarantine and its *Retry* (#6057, #3226).

## Interactions checked

- **Sync export (`prepare_outgoing`)** saves its stamp and mirrored tombstones as delta rows after the engine write. A pass reads `delta_head` before it collects any engine and deletes only the rows at or below it, so a row saved during a pass outlives it: `a_delta_written_during_a_compaction_outlives_it_6521`.
- **The dirty mark** is unchanged: a compaction clears only what it exported, under the stamp it collected.
- **`space_move`** commits through `CommandTx`, so its two spaces' deltas commit with it, and a pass during it either holds the move or, if the move rolls back, writes nothing (the rewind check).
- The lock order is unchanged: `write_engines` takes the write lock before it opens a checkpoint, and a pass's write transaction is the last thing it takes.

## What the fallback loses now

Decision 2 stands: saved rows that leave changes pending send boot through the replay, with an error in the log. That boot deletes the rows and builds from the snapshots, so it loses from the engines what a peer sent since the last pass, until the next sync delivers it again. Before this change the last pass was at most one session's end away; now it is the last compaction. The `replaying_the_op_log` twins of the session-end tests asserted the old window and now run under the saved-rows boot only (listed in the PR).

What would let the replay code go: no vault from before stage B left to open (its first boot needs the replay), and no remaining source of unusable rows. The sources left are a failed save of the tombstones a sync projection swept, an import whose own save failed, and a kill during an import's projection after a local write on the same space; the third could be closed by importing a space's inbox blobs with its rows at boot.

## What ran

Filled in below once the gates have run.
