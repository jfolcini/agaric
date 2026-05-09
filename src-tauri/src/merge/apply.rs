use sqlx::SqlitePool;

use crate::dag;
use crate::error::AppError;
use crate::op::*;
use crate::ulid::BlockId;

use super::detect::merge_text;
use super::resolve::create_conflict_copy_with_reindex;
use super::types::{MergeOutcome, MergeResult};

// PEND-09 Phase 1 day-2 — feature-gated import of the OpRecord type
// used by `shadow_dispatch_for_record` below.  Outside the feature
// gate the helper does not exist and this `use` would be unused.
#[cfg(feature = "loro-shadow")]
use crate::op_log::OpRecord;

/// Three-way **text-only** merge orchestrator for a single block's
/// `edit_block` history.
///
/// **Scope (what this function does):**
/// 1. If heads are identical, returns `AlreadyUpToDate`.
/// 2. Calls `merge_text()` for three-way text merge of block content.
/// 3. On clean merge: creates an `edit_block` op via `dag::append_merge_op`.
/// 4. On conflict: creates a conflict copy with "theirs" content, then
///    creates a merge op on the original to unify the DAG and preserve
///    the local ("ours") content in-place (user's edits are retained).
///
/// **Limitations (what this function does NOT do):**
/// - **Property conflicts** (`set_property` LWW) are NOT resolved here.
///   `resolve_property_conflict` must be invoked separately by the caller
///   for each concurrent `(block_id, key)` pair. See
///   `sync_protocol::operations::merge_diverged_blocks` for the
///   property-LWW pass that complements this function.
/// - **Move conflicts** (concurrent `move_block` on the same block) are
///   NOT resolved here. The caller must apply move LWW separately.
/// - **Delete vs. edit** resurrection (one device deleted while the other
///   edited) is NOT handled here. The caller must detect and emit a
///   `restore_block` op separately.
///
/// A future caller that treats this as a complete three-way merge will
/// silently drop property/move/delete conflicts. The name
/// `merge_block_text_only` is deliberate: any caller wiring up a new
/// merge entry point must explicitly compose the text pass with the
/// property/move/delete-resurrect passes (see `merge_diverged_blocks`
/// for the canonical composition).
pub async fn merge_block_text_only(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &crate::materializer::Materializer,
    block_id: &str,
    our_head: &(String, i64),
    their_head: &(String, i64),
) -> Result<MergeOutcome, AppError> {
    tracing::debug!(block_id, "merge_block_text_only invoked");

    // 1. Already up to date?
    if our_head == their_head {
        return Ok(MergeOutcome::AlreadyUpToDate);
    }

    // 2. Three-way merge
    let result = merge_text(pool, block_id, our_head, their_head).await?;

    match result {
        MergeResult::Clean(merged) => {
            // 3. Create edit_block op with merged text
            let merge_payload = OpPayload::EditBlock(EditBlockPayload {
                block_id: BlockId::from_trusted(block_id),
                to_text: merged,
                prev_edit: Some(our_head.clone()),
            });
            let parent_entries = vec![our_head.clone(), their_head.clone()];
            let record =
                dag::append_merge_op(pool, device_id, merge_payload, parent_entries).await?;

            // Shadow dispatch for the clean-merge record happens in the
            // materializer (`materializer::handlers::apply_op`) once the
            // caller enqueues `MaterializeTask::ApplyOp(record)`.  Doing
            // it there avoids double-dispatch and ensures Loro only sees
            // ops whose enclosing tx has committed.

            tracing::info!(block_id, "merge completed — clean merge applied");
            Ok(MergeOutcome::Merged(record))
        }
        MergeResult::Conflict {
            ours,
            theirs,
            ancestor: _,
        } => {
            // 4. Create conflict copy with "theirs" content. Uses the
            //    `_with_reindex` variant (M-74) so the new block's
            //    `[[ULID]]` / `#[ULID]` references are picked up by the
            //    backlinks/tags caches without waiting for the
            //    materializer's periodic re-index cycle.
            let conflict_op = create_conflict_copy_with_reindex(
                pool,
                device_id,
                materializer,
                block_id,
                &theirs,
                "Text",
            )
            .await?;

            // 5. Create a merge op on the ORIGINAL block to unify the two
            //    divergent heads in the DAG.  The original block retains the
            //    local ("ours") content so the user's own edits are preserved
            //    in-place.  Without this merge op the two heads would remain
            //    unresolved and `get_block_edit_heads` would re-detect
            //    divergence on the next sync, potentially creating duplicate
            //    conflict copies.                             (fixes F01+F02)
            let merge_payload = OpPayload::EditBlock(EditBlockPayload {
                block_id: BlockId::from_trusted(block_id),
                to_text: ours,
                prev_edit: Some(our_head.clone()),
            });
            let parent_entries = vec![our_head.clone(), their_head.clone()];
            let _merge_record =
                dag::append_merge_op(pool, device_id, merge_payload, parent_entries).await?;

            // Shadow dispatch for `conflict_op` happens in the
            // materializer once the caller enqueues
            // `MaterializeTask::ApplyOp(conflict_block_op)`.  The
            // merge-on-original record is NEVER enqueued — it lives
            // only in `op_log` to unify the divergent heads — so we
            // dispatch it here directly.  No-op when `loro-shadow`
            // is off (compile-time elided).
            #[cfg(feature = "loro-shadow")]
            {
                shadow_dispatch_for_record(pool, &_merge_record).await;
            }

            tracing::warn!(block_id, "merge completed — conflict copy created");
            Ok(MergeOutcome::ConflictCopy {
                conflict_block_op: conflict_op,
            })
        }
    }
}

// ---------------------------------------------------------------------------
// PEND-09 Phase 1 day-2 — shadow-mode dispatch helper.
//
// Threads an op_log `OpRecord` (the diffy authoritative output) into
// `merge::shadow_apply`.  Resolves the block's owning space via
// `crate::space::resolve_block_space` and walks the global shadow state
// installed at bootstrap.  Failures are logged-and-skipped so the
// shadow path can never break the diffy authoritative path.
//
// `loro-shadow` is a Phase-1 opt-in build flag — when it's off this
// helper does not compile and the only call sites that reference it
// are themselves `#[cfg]`-gated above.
// ---------------------------------------------------------------------------

#[cfg(feature = "loro-shadow")]
pub(crate) async fn shadow_dispatch_for_record(pool: &SqlitePool, record: &OpRecord) {
    let Some(state) = crate::loro::shared::get() else {
        // Shadow state not initialised (e.g. unit-test environments
        // that exercise `merge_block_text_only` without going through
        // `crate::run`).  Skip silently — the diffy path is already
        // authoritative.
        return;
    };

    let payload: OpPayload = match serde_json::from_str(&record.payload) {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!(
                device_id = %record.device_id,
                seq = record.seq,
                error = %e,
                "shadow_dispatch: failed to parse op payload; skipping",
            );
            return;
        }
    };

    let block_id_str = match payload.block_id() {
        Some(id) => id,
        None => {
            // Op types without a `block_id` (today only DeleteAttachment)
            // can't be assigned to a space; skip.
            return;
        }
    };
    let block_id = BlockId::from_trusted(block_id_str);

    let space_id = match crate::space::resolve_block_space(pool, &block_id).await {
        Ok(Some(s)) => s,
        Ok(None) => {
            // No `space` ref on the owning page — pre-FEAT-3 data, or
            // a block created before space membership was assigned.
            // Skip: there's no canonical engine to mirror onto.  Day-3
            // may revisit by routing such ops to a "default" space.
            tracing::trace!(
                block_id = block_id_str,
                "shadow_dispatch: no space found for block; skipping",
            );
            return;
        }
        Err(e) => {
            tracing::warn!(
                block_id = block_id_str,
                error = %e,
                "shadow_dispatch: resolve_block_space failed; skipping",
            );
            return;
        }
    };

    let op_id = format!("{}/{}", record.device_id, record.seq);
    let diffy_summary = super::diffy_summary_for(&payload);

    super::shadow_apply(
        &op_id,
        &payload,
        &record.device_id,
        &space_id,
        diffy_summary,
        state,
    );
}

// ---------------------------------------------------------------------------
// PEND-09 Phase 1 day-2 — shadow-mode unit tests.
//
// Gated on `cfg(all(test, feature = "loro-shadow"))` so the default
// `cargo nextest run -p agaric` test count is unchanged (the day-1
// baseline of 3 734 stays at 3 734).  These exercise `shadow_apply`
// directly — the wiring through `merge_block_text_only` is exercised
// in higher-level integration paths once the dispatcher matures.
// ---------------------------------------------------------------------------

#[cfg(all(test, feature = "loro-shadow"))]
mod shadow_apply_unit_tests {
    use crate::loro::registry::LoroEngineRegistry;
    use crate::loro::shared::ShadowState;
    use crate::merge::shadow_apply;
    use crate::op::{
        CreateBlockPayload, DeleteBlockPayload, EditBlockPayload, MoveBlockPayload, OpPayload,
        SetPropertyPayload,
    };
    use crate::space::SpaceId;
    use crate::ulid::BlockId;

    /// Two valid ULIDs reused across these tests.
    const SPACE_A: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const SPACE_B: &str = "01BX5ZZKBKACTAV9WEVGEMMVRZ";
    const BLOCK_1: &str = "01HZ00000000000000000000AB";
    const BLOCK_2: &str = "01HZ00000000000000000000CD";
    const DEVICE_ID: &str = "device-shadow-test";

    fn fresh_state() -> ShadowState {
        ShadowState {
            registry: LoroEngineRegistry::new(),
            sampler: crate::loro::parity::ShadowParitySampler::new(),
        }
    }

    fn create_op(block_id: &str, content: &str) -> OpPayload {
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::from_trusted(block_id),
            block_type: "content".into(),
            parent_id: None,
            position: Some(0),
            content: content.into(),
        })
    }

    fn edit_op(block_id: &str, to_text: &str) -> OpPayload {
        OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::from_trusted(block_id),
            to_text: to_text.into(),
            prev_edit: None,
        })
    }

    fn delete_op(block_id: &str) -> OpPayload {
        OpPayload::DeleteBlock(DeleteBlockPayload {
            block_id: BlockId::from_trusted(block_id),
        })
    }

    fn move_op(block_id: &str, position: i64) -> OpPayload {
        OpPayload::MoveBlock(MoveBlockPayload {
            block_id: BlockId::from_trusted(block_id),
            new_parent_id: None,
            new_position: position,
        })
    }

    fn set_prop_op(block_id: &str, key: &str, value_text: &str) -> OpPayload {
        OpPayload::SetProperty(SetPropertyPayload {
            block_id: BlockId::from_trusted(block_id),
            key: key.into(),
            value_text: Some(value_text.into()),
            value_num: None,
            value_date: None,
            value_ref: None,
            value_bool: None,
        })
    }

    /// Dispatching a `CreateBlock` op via shadow_apply must populate
    /// the per-space engine.
    #[test]
    fn dispatch_create_block_populates_engine() {
        let state = fresh_state();
        let space = SpaceId::from_trusted(SPACE_A);
        let op = create_op(BLOCK_1, "hello");

        shadow_apply(
            "DEV/1",
            &op,
            DEVICE_ID,
            &space,
            super::super::diffy_summary_for(&op),
            &state,
        );

        // The engine for SPACE_A must hold BLOCK_1 with content "hello".
        // Scope the guard so the registry mutex is released before
        // `state.registry.len()` re-locks it (the registry uses a
        // single coarse Mutex; `for_space` + `len` share it).
        {
            let mut guard = state
                .registry
                .for_space(&space, DEVICE_ID)
                .expect("for_space");
            let snap = guard
                .engine_mut()
                .read_block(BLOCK_1)
                .expect("read")
                .expect("block exists");
            assert_eq!(snap.content, "hello");
            assert_eq!(snap.block_type, "content");
        }
        assert_eq!(state.registry.len(), 1);
    }

    /// A Create + Edit + Delete sequence on the same engine must
    /// reflect each step in the engine's state.
    #[test]
    fn dispatch_create_edit_delete_sequence_matches_engine_state() {
        let state = fresh_state();
        let space = SpaceId::from_trusted(SPACE_A);

        for op in [
            create_op(BLOCK_1, "alpha"),
            edit_op(BLOCK_1, "alpha-beta"),
            delete_op(BLOCK_1),
        ] {
            let summary = super::super::diffy_summary_for(&op);
            shadow_apply("DEV/x", &op, DEVICE_ID, &space, summary, &state);
        }

        let mut guard = state
            .registry
            .for_space(&space, DEVICE_ID)
            .expect("for_space");
        let engine = guard.engine_mut();
        let snap = engine.read_block(BLOCK_1).expect("read").expect("present");
        assert_eq!(snap.content, "alpha-beta", "edit must have applied");
        assert!(
            engine.read_deleted(BLOCK_1).expect("read_deleted"),
            "delete must have applied"
        );
    }

    /// CreateBlocks for two different spaces must produce two engines
    /// in the registry that don't share state.
    #[test]
    fn dispatch_two_spaces_yields_two_isolated_engines() {
        let state = fresh_state();
        let space_a = SpaceId::from_trusted(SPACE_A);
        let space_b = SpaceId::from_trusted(SPACE_B);

        let op_a = create_op(BLOCK_1, "in A");
        shadow_apply(
            "DEV/1",
            &op_a,
            DEVICE_ID,
            &space_a,
            super::super::diffy_summary_for(&op_a),
            &state,
        );
        let op_b = create_op(BLOCK_2, "in B");
        shadow_apply(
            "DEV/2",
            &op_b,
            DEVICE_ID,
            &space_b,
            super::super::diffy_summary_for(&op_b),
            &state,
        );

        assert_eq!(state.registry.len(), 2, "must hold two distinct engines");

        // Engine A must NOT have BLOCK_2 and engine B must NOT have BLOCK_1.
        {
            let mut g = state.registry.for_space(&space_a, DEVICE_ID).expect("a");
            assert!(g.engine_mut().read_block(BLOCK_2).unwrap().is_none());
            assert!(g.engine_mut().read_block(BLOCK_1).unwrap().is_some());
        }
        {
            let mut g = state.registry.for_space(&space_b, DEVICE_ID).expect("b");
            assert!(g.engine_mut().read_block(BLOCK_1).unwrap().is_none());
            assert!(g.engine_mut().read_block(BLOCK_2).unwrap().is_some());
        }
    }

    /// The parity sampler ring must accumulate exactly one event per
    /// `shadow_apply` call.
    #[test]
    fn parity_sampler_records_one_event_per_call() {
        let state = fresh_state();
        let space = SpaceId::from_trusted(SPACE_A);

        // Mix all five supported op types.  CreateBlock first so the
        // subsequent ops have a target.
        let ops = vec![
            create_op(BLOCK_1, "seed"),
            edit_op(BLOCK_1, "edited"),
            move_op(BLOCK_1, 7),
            set_prop_op(BLOCK_1, "priority", "high"),
            delete_op(BLOCK_1),
        ];
        let n = ops.len() as u64;

        for (idx, op) in ops.into_iter().enumerate() {
            let summary = super::super::diffy_summary_for(&op);
            shadow_apply(
                &format!("DEV/{idx}"),
                &op,
                DEVICE_ID,
                &space,
                summary,
                &state,
            );
        }

        assert_eq!(
            state.sampler.total_pushed(),
            n,
            "exactly one parity event per shadow_apply call",
        );

        // All five events must report a match because we passed the
        // exact same summary string the dispatcher produces.
        let snap = state.sampler.snapshot();
        assert_eq!(snap.len(), n as usize);
        for ev in &snap {
            assert!(
                ev.r#match,
                "self-summary should always match: op_id={} diffy={} loro={}",
                ev.op_id, ev.diffy_result, ev.loro_result
            );
        }
        assert_eq!(state.sampler.total_diverged(), 0);
    }
}
