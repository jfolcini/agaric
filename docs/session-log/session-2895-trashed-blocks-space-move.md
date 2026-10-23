# Session 2895 — a trashed block moves with its page to another space

#6080: a page moved to another space lost its trashed blocks. The SQL move stamps every row of the page into the new space (`id = ? OR page_id = ?`, trashed rows included). But the engine side pruned the whole subtree from the old doc and seeded only live rows into the new one. A peer then saw the trashed rows in neither doc, and `sweep_deferred_purges` hard-deleted them. On the moving device, a restore after the move reached no doc, so it never synced.

**Fix:** `hydrate_page_subtree_into_engine` now walks trashed rows too, and seeds each one as a tombstone at its own `deleted_at`. The engine's `apply_delete_block` stamps one node, so a trashed cohort keeps its timestamps and a restore still finds it.
- **Live move:** every trashed row becomes a tombstone.
- **Boot replay:** a row trashed at or before the move becomes a tombstone. A row trashed after it is seeded live, and its delete's replay tombstones it again (#5647).
- **The tie counts as before.** A row trashed in the move's own millisecond must become a tombstone. When its delete replays before the move, which is the case for a delete the snapshot watermark withheld, nothing would tombstone it again.

The same function serves undo of a move, the first space assignment of a page created before its space (#2249), and both repairs, so they all carry trashed rows now.

**Proptest:** `proptest_db_harness.rs` had a guard that blocked space ops while anything was trashed, because the hydrate was live-only. It is deleted.
- With the old live-only filter put back, B5 and B6 then find the bug within a few thousand cases. The minimal input is create, create, delete, set space, restore, move, which takes the SQL-only fallback.
- On the fix they ran clean at 22,000 / 20,000 / 18,000 / 12,000 cases (B5, B6, B2, B1).

**Shown red:**
- Restoring the live-only filter: both two-device tests fail, B's row missing from the trash and the new doc not holding the restored block. The conformance parity guard reports `SQL=true, Loro=false`, and both `crash_tail_space_move` variants fail.
- Seeding live instead of tombstoned: the new assertion that A's new doc holds the rows tombstoned fails.
- Comparing the tie with `<`: the same-millisecond replay test fails.

**Not here:**
- Vaults already hit keep their trashed rows in no doc until the page moves again. A repair is the maintainer's call.
- Property ops on a trashed row still never reach the doc.
- The move/sync proptest has no trash or restore op.

**Suites:**
- the whole workspace in partitions;
- clippy, and `SQLX_OFFLINE` check;
- vitest over the mock (the S0.6 fixture now trashes before the move);
- typos and fmt.
