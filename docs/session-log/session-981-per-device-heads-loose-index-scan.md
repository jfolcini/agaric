## Session 981 — per-device heads via loose-index-scan, not a full op_log scan (#430) (2026-06-05)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-06-05 |
| **Items closed** | `#430` |
| **Tests added** | +1 (EXPLAIN-plan regression: seeks, not a MAX-per-group scan) |
| **Files touched** | 1 |
| **Schema / wire-format** | none (runtime `query_as`, no `.sqlx` change) |

**Summary:** `get_local_heads` computed the per-device head via
`(device_id, seq) IN (SELECT device_id, MAX(seq) FROM op_log GROUP BY
device_id)`. SQLite cannot index-skip a `MAX`-per-group over the
`(device_id, seq)` PK, so this was a full covering-index **SCAN** of `op_log`
(+ a temp B-tree + bloom filter) on **every** sync session (orchestrator.rs
195/474/685) and the reset path — `O(op_log)`, which grows with vault size
between compactions.

Rewrote as the classic **loose-index-scan emulation**: a recursive CTE walks
the *distinct* `device_id`s by index seek (`device_id > ? ORDER BY device_id
LIMIT 1`, terminating on the NULL when none is greater), and each device's head
is read with a correlated PK-range seek (`WHERE device_id = ? ORDER BY seq DESC
LIMIT 1`). `O(devices · log n)` index seeks instead of an `O(op_log)` scan;
device count is small. Identical results (`seq` is unique per device under the
PK). No new table/migration — pure query rewrite (a Pareto improvement, so no
threshold to measure).

**Two iterations to get the plan right (verified via EXPLAIN QUERY PLAN):**
1. A `JOIN op_log h ON h.device_id = d.device_id AND h.seq = (MAX …)` let the
   planner drive from `op_log h` (`SCAN h USING INDEX` — still a full scan).
2. Switched to **correlated subqueries** for `seq`/`hash` so the planner drives
   from the tiny `devices` CTE (`SCAN devices`) and only *seeks* `op_log`
   (`SEARCH ol … (device_id=?)`). The only residual `SCAN op_log` is the O(1)
   anchor `… ORDER BY device_id LIMIT 1`; the bloom filter / GROUP-BY temp
   B-tree are gone.

**Files touched:**
- `sync_protocol/operations.rs` — `get_local_heads` query rewrite + rationale doc.
- `sync_protocol/tests.rs` — `get_local_heads_plan_uses_index_seeks` (EXPLAIN plan asserts `SCAN devices` driver + `(device_id=?)` seeks + no `BLOOM FILTER`).

**Verification:**
- Existing `get_local_heads_{empty_db,single_device,multiple_devices}` still pass (identical results); new plan test pins the seek-based plan.
- `cargo nextest run sync_protocol::` → **75 passed**. clippy + rustfmt clean.

**Commit plan:** single commit; branched off `main`; PR against `main`.
