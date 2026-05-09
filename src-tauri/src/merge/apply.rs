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

    // PEND-09 Phase 2 day-9.5 — fix latent JSON-parse bug.
    //
    // `OpPayload` is `#[serde(tag = "op_type")]` (internally tagged), but
    // `op_log::serialize_inner_payload` strips the tag (it lives in the
    // `op_log.op_type` column, not the JSON blob).  So a direct
    // `from_str::<OpPayload>(&record.payload)` ALWAYS fails on production
    // payloads — the parse demands the tag, but the JSON doesn't have it.
    //
    // Effect (Phase 1 day-2 .. day-9.5): every op flowing through this
    // helper silently logged a warn and returned, NO ops reached the
    // engine via this path.  Day-9 worked around it for `restore_block`
    // by parsing the inner struct directly inside
    // `dispatch_restore_descendants_shadow`; this fix unblocks every
    // other op type.
    //
    // Pattern mirrors `materializer::handlers::apply_op_tx` — branch on
    // `record.op_type` (the dedicated `op_log` column), parse the
    // corresponding inner-only struct, then re-wrap as `OpPayload` so
    // the rest of the function (block-id extraction, space resolve,
    // `shadow_apply` call) is untouched.
    let payload: OpPayload = match record.op_type.as_str() {
        "create_block" => {
            match serde_json::from_str::<crate::op::CreateBlockPayload>(&record.payload) {
                Ok(p) => OpPayload::CreateBlock(p),
                Err(e) => return shadow_dispatch_log_parse_err(record, &e),
            }
        }
        "edit_block" => {
            match serde_json::from_str::<crate::op::EditBlockPayload>(&record.payload) {
                Ok(p) => OpPayload::EditBlock(p),
                Err(e) => return shadow_dispatch_log_parse_err(record, &e),
            }
        }
        "delete_block" => {
            match serde_json::from_str::<crate::op::DeleteBlockPayload>(&record.payload) {
                Ok(p) => OpPayload::DeleteBlock(p),
                Err(e) => return shadow_dispatch_log_parse_err(record, &e),
            }
        }
        "restore_block" => {
            match serde_json::from_str::<crate::op::RestoreBlockPayload>(&record.payload) {
                Ok(p) => OpPayload::RestoreBlock(p),
                Err(e) => return shadow_dispatch_log_parse_err(record, &e),
            }
        }
        "purge_block" => {
            match serde_json::from_str::<crate::op::PurgeBlockPayload>(&record.payload) {
                Ok(p) => OpPayload::PurgeBlock(p),
                Err(e) => return shadow_dispatch_log_parse_err(record, &e),
            }
        }
        "move_block" => {
            match serde_json::from_str::<crate::op::MoveBlockPayload>(&record.payload) {
                Ok(p) => OpPayload::MoveBlock(p),
                Err(e) => return shadow_dispatch_log_parse_err(record, &e),
            }
        }
        "add_tag" => match serde_json::from_str::<crate::op::AddTagPayload>(&record.payload) {
            Ok(p) => OpPayload::AddTag(p),
            Err(e) => return shadow_dispatch_log_parse_err(record, &e),
        },
        "remove_tag" => {
            match serde_json::from_str::<crate::op::RemoveTagPayload>(&record.payload) {
                Ok(p) => OpPayload::RemoveTag(p),
                Err(e) => return shadow_dispatch_log_parse_err(record, &e),
            }
        }
        "set_property" => {
            match serde_json::from_str::<crate::op::SetPropertyPayload>(&record.payload) {
                Ok(p) => OpPayload::SetProperty(p),
                Err(e) => return shadow_dispatch_log_parse_err(record, &e),
            }
        }
        "delete_property" => {
            match serde_json::from_str::<crate::op::DeletePropertyPayload>(&record.payload) {
                Ok(p) => OpPayload::DeleteProperty(p),
                Err(e) => return shadow_dispatch_log_parse_err(record, &e),
            }
        }
        "add_attachment" => {
            match serde_json::from_str::<crate::op::AddAttachmentPayload>(&record.payload) {
                Ok(p) => OpPayload::AddAttachment(p),
                Err(e) => return shadow_dispatch_log_parse_err(record, &e),
            }
        }
        "delete_attachment" => {
            match serde_json::from_str::<crate::op::DeleteAttachmentPayload>(&record.payload) {
                Ok(p) => OpPayload::DeleteAttachment(p),
                Err(e) => return shadow_dispatch_log_parse_err(record, &e),
            }
        }
        other => {
            // Unknown op_type — matches the pre-fix "unsupported" path
            // (log + return, never break the diffy authoritative path).
            tracing::warn!(
                device_id = %record.device_id,
                seq = record.seq,
                op_type = %other,
                "shadow_dispatch: unknown op_type; skipping",
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

/// PEND-09 Phase 2 day-9.5 — shared warn-and-return helper for the
/// per-variant inner-payload parse arms in `shadow_dispatch_for_record`.
/// Pulling the warn into a single function keeps the dispatcher's match
/// arms uniform and the per-arm boilerplate to one line.
#[cfg(feature = "loro-shadow")]
fn shadow_dispatch_log_parse_err(record: &OpRecord, err: &serde_json::Error) {
    tracing::warn!(
        device_id = %record.device_id,
        seq = record.seq,
        op_type = %record.op_type,
        error = %err,
        "shadow_dispatch: failed to parse inner payload; skipping",
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
        AddAttachmentPayload, AddTagPayload, CreateBlockPayload, DeleteAttachmentPayload,
        DeleteBlockPayload, DeletePropertyPayload, EditBlockPayload, MoveBlockPayload, OpPayload,
        PurgeBlockPayload, RemoveTagPayload, RestoreBlockPayload, SetPropertyPayload,
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

    // ---------------------------------------------------------------------
    // Phase-2 day-8.5 — dispatcher coverage for the five newly-mirrored
    // op types (AddTag / RemoveTag / RestoreBlock / PurgeBlock /
    // DeleteProperty).  Each test seeds the engine with a CreateBlock,
    // dispatches the new op via `shadow_apply`, and asserts the engine
    // reflects the mutation (mutation-test of the dispatcher arm).
    // ---------------------------------------------------------------------

    /// Valid ULID fixture for the tag-id position.  Distinct from
    /// `BLOCK_1` / `BLOCK_2` so a swapped (block_id, tag_id) bug
    /// surfaces as a wrong-id assertion.
    const TAG_ULID: &str = "01HZ00000000000000000000T1";

    fn add_tag_op(block_id: &str, tag_id: &str) -> OpPayload {
        OpPayload::AddTag(AddTagPayload {
            block_id: BlockId::from_trusted(block_id),
            tag_id: BlockId::from_trusted(tag_id),
        })
    }

    fn remove_tag_op(block_id: &str, tag_id: &str) -> OpPayload {
        OpPayload::RemoveTag(RemoveTagPayload {
            block_id: BlockId::from_trusted(block_id),
            tag_id: BlockId::from_trusted(tag_id),
        })
    }

    fn restore_op(block_id: &str) -> OpPayload {
        OpPayload::RestoreBlock(RestoreBlockPayload {
            block_id: BlockId::from_trusted(block_id),
            // `deleted_at_ref` is not consulted by the engine (LWW
            // happens at the LoroValue level); supply a placeholder.
            deleted_at_ref: "2025-01-15T12:00:00Z".into(),
        })
    }

    fn purge_op(block_id: &str) -> OpPayload {
        OpPayload::PurgeBlock(PurgeBlockPayload {
            block_id: BlockId::from_trusted(block_id),
        })
    }

    fn delete_prop_op(block_id: &str, key: &str) -> OpPayload {
        OpPayload::DeleteProperty(DeletePropertyPayload {
            block_id: BlockId::from_trusted(block_id),
            key: key.into(),
        })
    }

    /// Helper: drive an op through `shadow_apply` using the dispatcher's
    /// own diffy_summary as the diffy side (so the parity event is a
    /// match).  Mirrors the pattern from the existing tests.
    fn dispatch(state: &ShadowState, space: &SpaceId, op_id: &str, op: &OpPayload) {
        let summary = super::super::diffy_summary_for(op);
        shadow_apply(op_id, op, DEVICE_ID, space, summary, state);
    }

    #[test]
    fn shadow_apply_dispatches_add_tag() {
        let state = fresh_state();
        let space = SpaceId::from_trusted(SPACE_A);
        // Seed: block must exist before tags are applied.
        dispatch(&state, &space, "DEV/1", &create_op(BLOCK_1, "seed"));
        dispatch(&state, &space, "DEV/2", &add_tag_op(BLOCK_1, TAG_ULID));

        let mut guard = state
            .registry
            .for_space(&space, DEVICE_ID)
            .expect("for_space");
        let tags = guard.engine_mut().read_tags(BLOCK_1).expect("read_tags");
        assert_eq!(
            tags,
            vec![BlockId::from_trusted(TAG_ULID).as_str().to_string()]
        );
    }

    #[test]
    fn shadow_apply_dispatches_remove_tag() {
        let state = fresh_state();
        let space = SpaceId::from_trusted(SPACE_A);
        dispatch(&state, &space, "DEV/1", &create_op(BLOCK_1, "seed"));
        dispatch(&state, &space, "DEV/2", &add_tag_op(BLOCK_1, TAG_ULID));
        dispatch(&state, &space, "DEV/3", &remove_tag_op(BLOCK_1, TAG_ULID));

        let mut guard = state
            .registry
            .for_space(&space, DEVICE_ID)
            .expect("for_space");
        let tags = guard.engine_mut().read_tags(BLOCK_1).expect("read_tags");
        assert!(tags.is_empty(), "tag must be removed");
    }

    #[test]
    fn shadow_apply_dispatches_restore_block() {
        let state = fresh_state();
        let space = SpaceId::from_trusted(SPACE_A);
        dispatch(&state, &space, "DEV/1", &create_op(BLOCK_1, "seed"));
        dispatch(&state, &space, "DEV/2", &delete_op(BLOCK_1));
        dispatch(&state, &space, "DEV/3", &restore_op(BLOCK_1));

        let mut guard = state
            .registry
            .for_space(&space, DEVICE_ID)
            .expect("for_space");
        assert!(
            !guard
                .engine_mut()
                .read_deleted(BLOCK_1)
                .expect("read_deleted"),
            "post-restore must not be flagged deleted"
        );
    }

    #[test]
    fn shadow_apply_dispatches_purge_block() {
        let state = fresh_state();
        let space = SpaceId::from_trusted(SPACE_A);
        dispatch(&state, &space, "DEV/1", &create_op(BLOCK_1, "seed"));
        dispatch(&state, &space, "DEV/2", &purge_op(BLOCK_1));

        let mut guard = state
            .registry
            .for_space(&space, DEVICE_ID)
            .expect("for_space");
        assert!(
            guard.engine_mut().read_block(BLOCK_1).unwrap().is_none(),
            "purged block must be absent from engine"
        );
    }

    #[test]
    fn shadow_apply_dispatches_delete_property() {
        let state = fresh_state();
        let space = SpaceId::from_trusted(SPACE_A);
        dispatch(&state, &space, "DEV/1", &create_op(BLOCK_1, "seed"));
        dispatch(&state, &space, "DEV/2", &set_prop_op(BLOCK_1, "k", "v"));
        dispatch(&state, &space, "DEV/3", &delete_prop_op(BLOCK_1, "k"));

        let mut guard = state
            .registry
            .for_space(&space, DEVICE_ID)
            .expect("for_space");
        assert_eq!(
            guard.engine_mut().read_property(BLOCK_1, "k").unwrap(),
            None,
            "delete_property must remove the key entirely"
        );
    }

    /// All five new dispatch arms produce a parity event whose
    /// diffy_summary matches the loro_summary exactly (same shape as
    /// the existing five-op test).
    #[test]
    fn shadow_apply_records_match_for_new_op_types() {
        let state = fresh_state();
        let space = SpaceId::from_trusted(SPACE_A);

        // Seed sequence so each op has a valid target.
        let seed = vec![
            ("DEV/0", create_op(BLOCK_1, "seed")),
            ("DEV/1", set_prop_op(BLOCK_1, "k", "v")),
        ];
        for (id, op) in &seed {
            dispatch(&state, &space, id, op);
        }
        let baseline = state.sampler.total_pushed();

        let new_ops = vec![
            ("DEV/2", add_tag_op(BLOCK_1, TAG_ULID)),
            ("DEV/3", remove_tag_op(BLOCK_1, TAG_ULID)),
            ("DEV/4", delete_prop_op(BLOCK_1, "k")),
            ("DEV/5", delete_op(BLOCK_1)),
            ("DEV/6", restore_op(BLOCK_1)),
            ("DEV/7", purge_op(BLOCK_1)),
        ];
        for (id, op) in &new_ops {
            dispatch(&state, &space, id, op);
        }

        // One parity event per dispatch (no skipped arms).
        assert_eq!(
            state.sampler.total_pushed(),
            baseline + new_ops.len() as u64,
            "every new op type must produce exactly one parity event"
        );

        // Every event for the new ops must have matched (we passed
        // the diffy_summary the dispatcher itself produces).
        let snap = state.sampler.snapshot();
        for ev in &snap[snap.len() - new_ops.len()..] {
            assert!(
                ev.r#match,
                "new-op self-summary must match: op_type={} diffy={} loro={}",
                ev.op_type, ev.diffy_result, ev.loro_result,
            );
        }
        assert_eq!(state.sampler.total_diverged(), 0);
    }

    /// Attachment ops are intentionally out of scope per Phase-2
    /// day-8.5 (file-blob ops live outside CRDT state).  The
    /// dispatcher must skip them — no parity event recorded, no
    /// engine mutation.
    #[test]
    fn shadow_apply_skips_attachment_ops() {
        let state = fresh_state();
        let space = SpaceId::from_trusted(SPACE_A);
        dispatch(&state, &space, "DEV/1", &create_op(BLOCK_1, "seed"));
        let baseline = state.sampler.total_pushed();

        let add_att = OpPayload::AddAttachment(AddAttachmentPayload {
            attachment_id: BlockId::test_id("A1"),
            block_id: BlockId::from_trusted(BLOCK_1),
            mime_type: "image/png".into(),
            filename: "p.png".into(),
            size_bytes: 1,
            fs_path: "/tmp/p.png".into(),
        });
        let del_att = OpPayload::DeleteAttachment(DeleteAttachmentPayload {
            attachment_id: BlockId::test_id("A1"),
            fs_path: "/tmp/p.png".into(),
        });
        dispatch(&state, &space, "DEV/2", &add_att);
        dispatch(&state, &space, "DEV/3", &del_att);

        // Both attachment ops must have been skipped — no new parity
        // events past the baseline.
        assert_eq!(
            state.sampler.total_pushed(),
            baseline,
            "attachment ops must be log-and-skip (no parity event)"
        );
    }
}

// ---------------------------------------------------------------------------
// PEND-09 Phase 2 day-9.5 — regression coverage for the latent JSON-parse
// bug in `shadow_dispatch_for_record`.
//
// Background: from Phase 1 day-2 (commit `dcfc3637`) until day-9.5, the
// dispatcher attempted `serde_json::from_str::<OpPayload>(&record.payload)`,
// but `op_log::serialize_inner_payload` strips the `op_type` tag (it lives
// in the dedicated column).  `OpPayload` is internally tagged, so the
// parse ALWAYS failed — every op silently logged a warn and returned.
//
// Day-9 worked around it for `restore_block` inside
// `dispatch_restore_descendants_shadow` (parsing the inner struct
// directly).  Day-9.5 fixes the upstream dispatcher so EVERY op type
// flows through.
//
// These tests build real `OpRecord`s via `op_log::append_local_op`
// (which exercises the same `serialize_inner_payload` path that
// production uses) and assert the engine state is mutated by
// `shadow_dispatch_for_record`.  A future change that regresses the
// dispatcher (e.g. switches back to the tagged parse, or drops a
// match arm) will fail these tests.
// ---------------------------------------------------------------------------

#[cfg(all(test, feature = "loro-shadow"))]
mod shadow_dispatch_for_record_regression {
    use super::shadow_dispatch_for_record;
    use crate::db::init_pool;
    use crate::loro::shared::{install_for_test, ShadowState};
    use crate::op::{CreateBlockPayload, EditBlockPayload, OpPayload, SetPropertyPayload};
    use crate::op_log::append_local_op;
    use crate::space::SpaceId;
    use crate::ulid::BlockId;
    use sqlx::SqlitePool;
    use tempfile::TempDir;

    const SPACE_ULID: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const BLOCK_ULID: &str = "01HZ00000000000000000000AB";
    const DEVICE_ID: &str = "device-shadow-regression";

    async fn fresh_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().expect("tempdir");
        let db_path = dir.path().join("shadow_dispatch.db");
        let pool = init_pool(&db_path).await.expect("init_pool");
        (pool, dir)
    }

    /// Seed the SQL minimum that lets `resolve_block_space` resolve
    /// `BLOCK_ULID` to `SPACE_ULID`:
    ///   * a `blocks` row for the space (so the FK on
    ///     `block_properties.value_ref` is satisfied)
    ///   * a `blocks` row for the target block (so the
    ///     `JOIN blocks tgt` in `resolve_block_space` returns a hit)
    ///   * a `block_properties (key='space', value_ref=SPACE)` row on
    ///     the target block (so the property lookup itself succeeds).
    async fn seed_space_membership(pool: &SqlitePool) {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, is_conflict) \
             VALUES (?, 'tag', 'space', NULL, 0, 0)",
        )
        .bind(SPACE_ULID)
        .execute(pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, \
                                 is_conflict) \
             VALUES (?, 'content', '', NULL, 0, ?, 0)",
        )
        .bind(BLOCK_ULID)
        .bind(BLOCK_ULID)
        .execute(pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO block_properties (block_id, key, value_ref) VALUES (?, 'space', ?)",
        )
        .bind(BLOCK_ULID)
        .bind(SPACE_ULID)
        .execute(pool)
        .await
        .unwrap();
    }

    /// Read the engine snapshot for `BLOCK_ULID` in `SPACE_ULID`.
    fn engine_block_content(state: &ShadowState) -> Option<String> {
        let space = SpaceId::from_trusted(SPACE_ULID);
        let mut guard = state
            .registry
            .for_space(&space, DEVICE_ID)
            .expect("for_space");
        guard
            .engine_mut()
            .read_block(BLOCK_ULID)
            .expect("read_block")
            .map(|s| s.content)
    }

    /// Engine-side property lookup, flattened to `Option<String>`:
    ///   * `Ok(None)`        → key never set            → returns `None`
    ///   * `Ok(Some(None))`  → key explicitly cleared   → returns `None`
    ///   * `Ok(Some(Some(s)))` → key holds string `s`   → returns `Some(s)`
    fn engine_property(state: &ShadowState, key: &str) -> Option<String> {
        let space = SpaceId::from_trusted(SPACE_ULID);
        let mut guard = state
            .registry
            .for_space(&space, DEVICE_ID)
            .expect("for_space");
        guard
            .engine_mut()
            .read_property(BLOCK_ULID, key)
            .expect("read_property")
            .flatten()
    }

    /// PEND-09 Phase 2 day-9.5 — `CreateBlock` must reach the engine
    /// when threaded through `shadow_dispatch_for_record`.
    ///
    /// Pre-fix this test failed: the JSON parse logged a warn and
    /// returned without touching the engine, so `engine_block_content`
    /// was `None`.
    #[tokio::test]
    async fn shadow_dispatch_for_record_applies_create_block() {
        let (pool, _dir) = fresh_pool().await;
        seed_space_membership(&pool).await;
        let state = install_for_test();

        // Build a real OpRecord via the production write path so the
        // payload column matches `serialize_inner_payload`'s shape
        // exactly (no `op_type` tag).
        let payload = OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::from_trusted(BLOCK_ULID),
            block_type: "content".into(),
            parent_id: None,
            position: Some(0),
            content: "hello-from-record".into(),
        });
        let record = append_local_op(&pool, DEVICE_ID, payload)
            .await
            .expect("append");

        // Sanity: the persisted payload must NOT carry the `op_type`
        // tag (this is the precondition the day-9.5 fix targets — if a
        // future change starts including the tag, the dispatcher's
        // inner-only parse needs to be revisited).
        assert!(
            !record.payload.contains("\"op_type\""),
            "op_log payload must not embed the op_type tag (regression: \
             serialize_inner_payload changed shape, dispatcher parse needs review)"
        );

        // Drive the dispatcher.
        shadow_dispatch_for_record(&pool, &record).await;

        // Engine must now hold the block with the content from the
        // payload.  This is the load-bearing assertion.
        assert_eq!(
            engine_block_content(state).as_deref(),
            Some("hello-from-record"),
            "shadow_dispatch_for_record must apply CreateBlock to the engine \
             (regression: latent JSON-parse bug returned without applying)"
        );
    }

    /// PEND-09 Phase 2 day-9.5 — `EditBlock` and `SetProperty` must
    /// also reach the engine.  Two variants in one test to give the
    /// regression net more breadth without spinning up two pools.
    #[tokio::test]
    async fn shadow_dispatch_for_record_applies_edit_and_set_property() {
        let (pool, _dir) = fresh_pool().await;
        seed_space_membership(&pool).await;
        let state = install_for_test();

        // Seed the engine with the block (via the dispatcher, so we
        // also cover CreateBlock as a side effect).
        let create_payload = OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::from_trusted(BLOCK_ULID),
            block_type: "content".into(),
            parent_id: None,
            position: Some(0),
            content: "v1".into(),
        });
        let r1 = append_local_op(&pool, DEVICE_ID, create_payload)
            .await
            .expect("append create");
        shadow_dispatch_for_record(&pool, &r1).await;
        assert_eq!(
            engine_block_content(state).as_deref(),
            Some("v1"),
            "seed CreateBlock must reach the engine"
        );

        // EditBlock — content must update.
        let edit_payload = OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::from_trusted(BLOCK_ULID),
            to_text: "v2".into(),
            prev_edit: None,
        });
        let r2 = append_local_op(&pool, DEVICE_ID, edit_payload)
            .await
            .expect("append edit");
        shadow_dispatch_for_record(&pool, &r2).await;
        assert_eq!(
            engine_block_content(state).as_deref(),
            Some("v2"),
            "shadow_dispatch_for_record must apply EditBlock to the engine"
        );

        // SetProperty — property must appear.
        let set_payload = OpPayload::SetProperty(SetPropertyPayload {
            block_id: BlockId::from_trusted(BLOCK_ULID),
            key: "priority".into(),
            value_text: Some("high".into()),
            value_num: None,
            value_date: None,
            value_ref: None,
            value_bool: None,
        });
        let r3 = append_local_op(&pool, DEVICE_ID, set_payload)
            .await
            .expect("append set");
        shadow_dispatch_for_record(&pool, &r3).await;
        assert_eq!(
            engine_property(state, "priority").as_deref(),
            Some("high"),
            "shadow_dispatch_for_record must apply SetProperty to the engine"
        );
    }
}
