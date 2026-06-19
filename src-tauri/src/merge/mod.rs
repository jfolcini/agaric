//! Engine dispatch surface into the per-space `LoroEngine`.
//!
//! Public helpers:
//! - `engine_apply` — engine dispatcher; per-op-type match arms call
//!   `LoroEngine::apply_*`, errors trace-log and skip.
//!
//! Every op type is engine-applied INSIDE the materializer apply
//! transaction (`materializer::handlers::apply_op_tx` →
//! `apply_*_via_loro`), so there is no per-op post-commit re-dispatch
//! (#603 — the old `dispatch_for_record` re-apply ignored the
//! new-scheme `index`/`new_index` routing and converged engine sibling
//! order toward ULID order). `engine_apply` remains the shared
//! dispatcher for the post-commit Restore/Delete descendant-cohort
//! fanout (`dispatch_restore_descendants` /
//! `dispatch_delete_descendants` in `materializer::handlers`), which
//! synthesises per-descendant payloads the engine applies one block id
//! at a time.

mod apply;
pub(crate) mod divergence;

// ---------------------------------------------------------------------------
// engine_apply — the call site that runs every applied op through the
// per-space Loro `LoroEngine`. Look up the engine, dispatch on
// op_type, log on failure.
// ---------------------------------------------------------------------------

/// Engine dispatch entry point.
///
/// `op_id` is a caller-supplied identity (production passes the
/// op_log row's `(device_id, seq)` composite formatted as
/// `"DEV/SEQ"`).  `op` is the typed payload; the dispatcher mirrors
/// it onto the per-space `LoroEngine`.
///
/// `space_id` is the engine partition key — every op carries an
/// implicit space (its block's owning page resolves to one space)
/// and the registry holds one engine per space.
///
/// `device_id` is the production UUID-v4 device id.  It's threaded
/// through to [`LoroEngine::with_peer_id`] so the engine's Loro
/// peer id is stable across the process lifetime.
///
/// `op_created_at` is the originating op's `created_at` as an epoch-ms
/// decimal string (what production writes via `created_at.to_string()`;
/// #668 — NOT RFC-3339). It is the real `deleted_at` timestamp the
/// `DeleteBlock` arm writes onto the engine seed (PEND-80 Phase 2) so
/// the value is lossless across sync — see
/// [`LoroEngine::apply_delete_block`]. All other arms ignore it (their
/// ops carry no timestamp the engine stores).
///
/// Returns nothing.  Errors `tracing::warn!` and never propagate —
/// the engine dispatch must not break the materializer hot path.
pub(crate) fn engine_apply(
    op_id: &str,
    op: &crate::op::OpPayload,
    device_id: &str,
    space_id: &crate::space::SpaceId,
    op_created_at: &str,
    state: &crate::loro::shared::LoroState,
) {
    let crate::loro::shared::LoroState { registry } = state;

    let mut guard = match registry.for_space(space_id, device_id) {
        Ok(g) => g,
        Err(e) => {
            tracing::warn!(
                space_id = %space_id,
                device_id,
                error = %e,
                "engine_apply: registry.for_space failed; skipping",
            );
            // #1571: the SQL apply tx already committed; failing to reach
            // the engine here silently diverges the LoroDoc mirror from
            // the SQL source of truth. Emit the dedicated, durable signal.
            divergence::record(
                op_id,
                op.op_type_str(),
                &format!("registry.for_space failed: {e}"),
            );
            return;
        }
    };
    let engine = guard.engine_mut();

    // Dispatch on op_type. Covers ten op types (CreateBlock /
    // EditBlock / DeleteBlock / MoveBlock / SetProperty / AddTag /
    // RemoveTag / RestoreBlock / PurgeBlock / DeleteProperty).
    // AddAttachment / DeleteAttachment log+skip — those are file-blob
    // ops and the file lives outside the CRDT state.
    let dispatch_result: Result<(), crate::error::AppError> = match op {
        crate::op::OpPayload::CreateBlock(p) => {
            let parent = p.parent_id.as_ref().map(crate::ulid::BlockId::as_str);
            // #400/#603 routing — MUST mirror
            // `materializer::handlers::apply_create_block_via_loro` exactly:
            // new-scheme ops carry a 0-based `index` (slot-based apply);
            // pre-#400 ops carry the legacy sparse `position`; neither ⇒
            // append at the end. Routing a new-scheme op through the legacy
            // position path converges engine sibling order toward ULID order
            // on re-apply (#603).
            match p.index {
                Some(index) => engine
                    .apply_create_block_at(
                        p.block_id.as_str(),
                        &p.block_type,
                        &p.content,
                        parent,
                        usize::try_from(index.max(0)).unwrap_or(usize::MAX),
                    )
                    .map(|_| ()),
                None => engine
                    .apply_create_block(
                        p.block_id.as_str(),
                        &p.block_type,
                        &p.content,
                        parent,
                        p.position.unwrap_or(i64::MAX), // None ⇒ sort last (append)
                    )
                    .map(|_| ()),
            }
        }
        crate::op::OpPayload::EditBlock(p) => engine
            .apply_edit_via_diff_splice(p.block_id.as_str(), &p.to_text)
            .map(|_| ()),
        crate::op::OpPayload::DeleteBlock(p) => engine
            .apply_delete_block(p.block_id.as_str(), op_created_at)
            .map(|_| ()),
        crate::op::OpPayload::MoveBlock(p) => {
            let parent = p.new_parent_id.as_ref().map(crate::ulid::BlockId::as_str);
            // #400/#603 routing — MUST mirror
            // `materializer::handlers::apply_move_block_via_loro` exactly:
            // route on `new_index` when present (new-scheme op), else the
            // legacy sparse `new_position`.
            match p.new_index {
                Some(index) => engine
                    .apply_move_block_to(
                        p.block_id.as_str(),
                        parent,
                        usize::try_from(index.max(0)).unwrap_or(usize::MAX),
                    )
                    .map(|_| ()),
                None => engine
                    .apply_move_block(p.block_id.as_str(), parent, p.new_position)
                    .map(|_| ()),
            }
        }
        crate::op::OpPayload::SetProperty(p) => {
            // PEND-80 §2.1: store the value with its NATIVE type so the
            // engine is type-lossless. This must mirror
            // `materializer::handlers::apply_set_property_via_loro` exactly
            // (#603 — the in-tx via-loro path is the production apply; any
            // payload routed through this dispatcher must produce the same
            // engine mutation). A divergent (e.g. stringified) encoding here
            // would silently overwrite the native value, defeating the
            // lossless engine→SQL re-projection (Phase 4).
            // `value_num`→`Num`, `value_bool`→`Bool`; text/date/ref are
            // strings (disambiguated at projection by
            // `property_definitions.value_type`); no field set ⇒ explicit
            // clear (`Null`).
            use crate::loro::engine::PropertyValue;
            let value = if let Some(v) = &p.value_text {
                PropertyValue::Str(v.clone())
            } else if let Some(v) = p.value_num {
                PropertyValue::Num(v)
            } else if let Some(v) = &p.value_date {
                PropertyValue::Str(v.clone())
            } else if let Some(v) = &p.value_ref {
                PropertyValue::Str(v.as_str().to_owned())
            } else if let Some(b) = p.value_bool {
                PropertyValue::Bool(b)
            } else {
                PropertyValue::Null
            };
            engine
                .apply_set_property_typed(p.block_id.as_str(), &p.key, &value)
                .map(|_| ())
        }
        crate::op::OpPayload::AddTag(p) => engine
            .apply_add_tag(p.block_id.as_str(), p.tag_id.as_str())
            .map(|_| ()),
        crate::op::OpPayload::RemoveTag(p) => engine
            .apply_remove_tag(p.block_id.as_str(), p.tag_id.as_str())
            .map(|_| ()),
        crate::op::OpPayload::RestoreBlock(p) => {
            engine.apply_restore_block(p.block_id.as_str()).map(|_| ())
        }
        crate::op::OpPayload::PurgeBlock(p) => {
            engine.apply_purge_block(p.block_id.as_str()).map(|_| ())
        }
        crate::op::OpPayload::DeleteProperty(p) => engine
            .apply_delete_property(p.block_id.as_str(), &p.key)
            .map(|_| ()),
        // AddAttachment / DeleteAttachment are out of scope:
        // attachments are file-blobs that live outside CRDT state —
        // the file body sits on disk under `app_data_dir`, not inside
        // the per-space LoroDoc.
        other => {
            tracing::debug!(
                op_id,
                op_type = %other.op_type_str(),
                "engine_apply: op type out of scope (attachment file-blob); skipping",
            );
            return;
        }
    };

    if let Err(e) = dispatch_result {
        tracing::warn!(
            op_id,
            op_type = %op.op_type_str(),
            error = %e,
            "engine_apply: engine apply failed; skipping",
        );
        // #1571: the SQL apply tx already committed by the time the
        // post-commit cohort fan-out reaches here, so a swallowed engine
        // apply failure leaves the per-space LoroDoc diverged from the
        // op-log / SQL source of truth with no rollback possible. Emit a
        // durable, machine-detectable signal (counter + stable marker) so
        // a health check can observe the drift, not just a free-text warn.
        divergence::record(op_id, op.op_type_str(), &e.to_string());
    }
}
