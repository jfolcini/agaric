## Session 850 — DAG parent existence: batch per-parent loop into one `(device_id, seq) IN (json_each(?))` query (issue #112 sub-item 3 only) (2026-05-28)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-28 |
| **Subagents** | orchestrator-only + 1 review subagent (technical) |
| **Items closed** | — (issue #112 partially shipped; sub-items 1, 2, 4 still outstanding) |
| **Items modified** | #112 (sub-item 3 of 4 shipped) |
| **Tests added** | +1 backend (`insert_remote_op_accepts_multiple_resolved_parent_seqs` — 2-parent happy path) |
| **Files touched** | 2 |

**Summary:** Closed sub-item 3 (B-C4) of issue #112. `dag::insert_remote_op`'s per-parent existence check (`for (dev, seq) in parents { SELECT COUNT(*) WHERE device_id = ? AND seq = ? }`) collapsed into one query using SQLite row-value `IN` against `json_each`:

```sql
SELECT COUNT(*) FROM op_log
WHERE (device_id, seq) IN (
    SELECT json_extract(value, '$[0]'),
           CAST(json_extract(value, '$[1]') AS INTEGER)
    FROM json_each(?)
)
```

Then compares the count vs the deduped `parents.len()` in Rust. The `CAST … AS INTEGER` is the bulletproofing against JSON-numeric-affinity weirdness — `op_log.seq` is declared INTEGER (migration 0001), so even though SQLite's implicit conversion would usually work, the explicit cast eliminates any chance of a peer writing `1.0` and silently mismatching. The dedup-via-`HashSet` step preserves the old loop's tolerance of duplicate parent refs (set-IN collapses dups on the SQL side, so `parents.len()` would over-count without the dedup).

Today the loop runs at most once (N=1, phase 1 of the DAG), so the round-trip win is small. The shape future-proofs phase-4 multi-parent merges and is materially easier to reason about.

**Sub-items 1, 2, 4 deferred:** sub-item 1 (sort-after-fetch → SQL `ORDER BY … NULLS LAST`) and sub-item 2 (`apply_sort_merge_rebuild` → ON-CONFLICT-WHERE-changed) are larger refactors; sub-item 2 needs a parity test for the skip-unchanged-`updated_at` semantic. Sub-item 4 (`find_missing_attachments` → `buffer_unordered(N)`) has an unresolved Open Q on the concurrency-level constant. Each can ship as its own follow-up PR.

**REVIEW-LATER impact:**
- **Top-level open count:** unchanged (work was a `plan`-labelled GitHub issue, not REVIEW-LATER).
- **Previously resolved:** 1350+ → 1350+ across 849 → 850 sessions.

**Files touched (this session):**
- `src-tauri/src/dag.rs` (+~25, -~13 — collapse per-parent loop into one query at lines 387-417)
- `src-tauri/src/dag/tests.rs` (+~42 — new 2-parent happy-path test)
- `src-tauri/src/loro/projection.rs` (+1, -1 — clippy drive-by: `effort` test fixture `3.14` → `2.5` to escape `clippy::approx_constant` PI lint that started failing during this session's commit hook)
- `src-tauri/src/sync_protocol/loro_sync.rs` (+1, -1 — same clippy drive-by, mirror site in the sync round-trip test)

**Verification:**
- `cd src-tauri && cargo nextest run` — 4012 / 4012 pass.
- Targeted: `cargo nextest run insert_remote_op` — 7 / 7 pass (6 existing + 1 new).
- Technical review subagent — APPROVE. Verified dedup contract preserved, CAST-AS-INTEGER affinity correct (`op_log.seq INTEGER NOT NULL` in migration 0001), and the partial-unresolved regression test still rejects correctly.

**Commit plan:** single commit on topic branch `issue-112-sub3-dag-parent-existence-batch`; PR against `main`. Does NOT close #112 — leaves it open with a status comment noting sub-item 3 shipped and 1/2/4 still owed.
