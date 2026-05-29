## Session 893 — #110 batch 3: soft_delete 8-task realign (2026-05-29)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-29 |
| **Subagents** | 1 build + 1 review |
| **Items closed** | — |
| **Items modified** | `#110` |
| **Tests added** | +2 (RebuildPageLinkCache coverage for restore + cascade) |
| **Files touched** | 3 |

**Summary:** Third #110 (finish MAINT-112) sub-batch, maintainer decision group-2 **(b)**.
`restore_block` and `cascade_soft_delete` previously committed via raw `BEGIN IMMEDIATE` and
dispatched a **hardcoded 7-task** cache fan-out that had drifted out of sync with the now-8-entry
`FULL_CACHE_REBUILD_TASKS` — **missing `RebuildPageLinkCache`**, so the page-link cache went stale
after a restore/soft-delete. Fixed both: converted to `CommandTx::begin_immediate`, and replaced
the hardcoded fan-out by synthesizing a minimal `OpRecord` (op_type `restore_block`/`delete_block`
+ block_id) routed through `tx.enqueue_background(record)` + `tx.commit_and_dispatch(materializer)`,
which goes through the canonical `invalidations_for_op` → full 8-task set (incl `RebuildPageLinkCache`)
+ the correct FTS task (`UpdateFtsBlock` for restore, `RemoveFtsBlock` for delete). The hardcoded
`dispatch_cache_rebuild_after_*` helpers are deleted, so the set can never drift again.

**Why option (b) (synthesized OpRecord) is safe (reviewed):** `invalidations_for_op`'s
`restore_block`/`delete_block` arms read ONLY `record.op_type` and `record.block_id` — never
`seq`/`hash`/`device_id`/`payload` — so a minimal record keys correctly. The record is used purely
to compute the task vec; it is never written to op_log, hashed, or serialized.

**Files touched:** `soft_delete/restore.rs`, `soft_delete/trash.rs`, `soft_delete/mod.rs` (tests).

**Verification:**
- `cargo nextest run soft_delete` (55), `restore_block`/`cascade_soft_delete` (48) pass; `cargo check --tests` clean; no new clippy warnings.
- New tests plant a stale `page_link_cache` edge (no backing `block_links`) and assert it's gone after the op — tight, task-specific proof `RebuildPageLinkCache` ran (full DELETE + re-INSERT from `block_links`).
- Review subagent (≠ builder) — APPROVE; confirmed correct keying, exact task set, no spurious dispatch, no record leak.

**Process notes:** Built + pushed from the MAIN checkout (Rust branches can't push from a bare
worktree — pre-push needs `node_modules`/`DATABASE_URL`; session-892 lesson). **Remaining #110:**
just the prek lint hook (Q3) guarding new raw `begin_with` outside the allowlist.

**Commit plan:** single commit, pushed, PR opened (Refs #110 — partial; lint hook remains).
