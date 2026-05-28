## Session 840 — PEND-80 Phase 2: real `deleted_at` + inbound delete/restore re-projection (2026-05-25)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-25 |
| **Subagents** | orchestrator-only (a tightly-coupled vertical slice: engine signature → all callers → projection → `apply_remote`; splitting would break compilation mid-way) |
| **Items closed** | PEND-80 Phase 2 (real `deleted_at` + restore); unblocks PEND-81 §2A #3 (soft-delete/restore propagation over sync) |
| **Items modified** | PEND-80 (Phase-2 shipped banner + §3 bullet) |
| **Tests added** | +5 (backend: 2 engine `read_deleted_at` round-trip/absent, 3 `apply_remote` — remote subtree delete cascade, remote subtree restore, re-import no-resurrection); 1 existing test updated (`apply_remote_does_not_wipe_existing_block_derived_state` — F1 witness moved from `deleted_at` to `page_id` since `deleted_at` is now re-projected) |
| **Files touched** | 9 |

**Summary:** The Loro engine now stores the **real** `deleted_at` timestamp on the
delete seed (`apply_delete_block(block_id, deleted_at)`; was a fixed marker that
collapsed every delete onto one timestamp, breaking cross-peer cohort identity) and
exposes it via `LoroEngine::read_deleted_at`. The originating op's `created_at` is
threaded through `merge::engine_apply` (new `op_created_at` param) so all local
seed-apply paths agree on the cohort timestamp. Inbound sync re-projects it:
`apply_remote` gains a Pass C that calls the new
`reproject_block_deleted_at_from_engine`, which re-derives the SQL descendant cascade
from the seed timestamp — `Some(ts)` ⇒ cascade soft-delete (active-CTE); `None` ⇒
restore the cohort **only** for a genuine seed (an ancestor check keeps a descendant
of a still-deleted subtree soft-deleted, so a snapshot re-import never resurrects it).
The descendant cascade stays an SQL/app derivation per the PEND-80 §0 boundary (engine
holds the seed timestamp only). Closes the PEND-76 F1 delete/restore residual.

**REVIEW-LATER impact:**
- **Top-level open count:** unchanged (PEND-80 Phase 2 is a `pending/` workplan item, not a REVIEW-LATER row).
- **Previously resolved:** 1348+ (unchanged — no REVIEW-LATER item closed this session).

**Files touched (this session):**
- `src-tauri/src/loro/engine.rs` (`apply_delete_block` takes real ts; new `read_deleted_at`; +2 tests; docstrings)
- `src-tauri/src/loro/engine_proptest.rs` (delete arm passes a timestamp)
- `src-tauri/src/merge/mod.rs` (`engine_apply` gains `op_created_at`; DeleteBlock arm uses it)
- `src-tauri/src/merge/apply.rs` (`dispatch_for_record` + test call sites pass `created_at`)
- `src-tauri/src/materializer/handlers.rs` (3 call sites thread `created_at`/`now`; stale docstring fixed)
- `src-tauri/src/loro/projection.rs` (new `reproject_block_deleted_at_from_engine`)
- `src-tauri/src/sync_protocol/loro_sync.rs` (apply_remote Pass C; +3 tests; F1 witness moved to `page_id`)
- `pending/PEND-80-extend-loro-engine-model.md` (Phase-2 shipped)
- `SESSION-LOG.md` (this entry)

**Verification:**
- `cd src-tauri && cargo nextest run` — 4010 tests run, 4010 passed, 6 skipped.
- `prek run --all-files` — all hooks pass.

**Process notes:** New SQL uses runtime `sqlx::query`/`query_scalar` (no `.sqlx` cache
regen) and no Tauri command types changed (no `bindings.ts` regen). The local
descendant fanout (`dispatch_delete_descendants`) still mirrors the cohort onto the
engine for parity, but inbound sync no longer depends on it — the re-projection
re-derives the cascade in SQL from the seed timestamp alone, which is robust to the
engine-rebuild paths (op-log replay over already-materialised SQL would otherwise
fan out a seed-only cohort).

**Lessons learned (for future sessions):** PEND-80 Phase 2 made `deleted_at` an
inbound-re-projected column. Any future test that used a pre-seeded `deleted_at` as a
"no re-projection rebuilds this" witness (the old F1 cascade-wipe guard) must move to
a still-un-re-projected column (`page_id`).

**Commit plan:** single commit (not pushed unless asked).
