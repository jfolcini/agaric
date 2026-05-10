// Pre-existing clippy patterns surfaced when Phase 3 day-9 dropped the
// `loro-shadow` cfg gates around this module's body. Day-13+ mechanical
// cleanup territory.
#![allow(
    clippy::redundant_closure,
    clippy::redundant_closure_for_method_calls,
    clippy::cast_possible_truncation,
    clippy::needless_pass_by_value
)]

//! Engine dispatch surface into the per-space `LoroEngine`.
//!
//! ## History (delete-trail)
//!
//! - Phase 3 day-6 deleted `merge_block_text_only` (the diffy
//!   three-way text-merge entry point); its only caller
//!   (`sync_protocol::operations::merge_diverged_blocks`) was deleted
//!   the same day.
//! - Phase 3 day-7 deleted `merge::detect`
//!   (`merge_text` + `walk_to_create_block_root`) and `merge::resolve`
//!   (`create_conflict_copy`, `create_conflict_copy_with_reindex`,
//!   `resolve_property_conflict`) along with the now-empty
//!   `merge::types` module.
//! - Phase 3 day-9 retired the `loro-shadow` feature gate; the helpers
//!   in this module compile unconditionally.
//! - Phase 3 day-10 deleted the parity sink (ring buffer + SQLite
//!   table + classifier + flush task).  `shadow_apply` no longer
//!   records a `ParityEvent`; it just dispatches the op onto the
//!   per-space `LoroEngine`.  The `diffy_result_summary` parameter is
//!   preserved at the call site (the materializer cohort-fanout
//!   helpers still build a summary string for log output) but the
//!   parity-record sink is gone.  `diffy_summary_for` similarly
//!   collapsed to a logging-only helper and is kept for the
//!   handful of debug log lines that still reference it.
//!
//! What remains in this module:
//! - `shadow_apply` — engine dispatcher; per-op-type match arms call
//!   `LoroEngine::apply_*`, errors trace-log and skip.
//! - `shadow_dispatch_for_record` — `OpRecord` → `OpPayload` dispatch
//!   helper used by the materializer.
//! - `diffy_summary_for` — vestigial human-readable summary builder
//!   (logging only post-day-10).

mod apply;

// PEND-09 Phase 1 day-3 — re-export the engine dispatcher so the
// materializer (`materializer::handlers::apply_op`) and any other
// per-op call sites can reach it without depending on the
// `merge::apply` private module path.
pub(crate) use apply::shadow_dispatch_for_record;

// ---------------------------------------------------------------------------
// PEND-09 Phase 1 day-2 — engine dispatch hook.
//
// `shadow_apply` is the call site that runs every applied op through
// the per-space Loro `LoroEngine`.  Phase 3 day-10 collapsed it to a
// pure dispatcher: pre-day-10 it also recorded a `ParityEvent` into
// the in-memory sampler; the sampler + sink are gone, so the helper
// is now just "look up the engine, dispatch on op_type, log on
// failure".
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
/// `diffy_result_summary` is preserved for log-line continuity at
/// the call sites that still build one — Phase 3 day-10 deleted the
/// parity sink that consumed it, but the cohort-fanout helpers in
/// `materializer::handlers` still pass it through for `tracing::warn`
/// output on apply failure.  The argument may be deleted once those
/// helpers stop building summary strings.
///
/// Returns nothing.  Errors `tracing::warn!` and never propagate —
/// the engine dispatch must not break the materializer hot path.
pub(crate) fn shadow_apply(
    op_id: &str,
    op: &crate::op::OpPayload,
    device_id: &str,
    space_id: &crate::space::SpaceId,
    diffy_result_summary: String,
    state: &crate::loro::shared::ShadowState,
) {
    let _ = diffy_result_summary; // Phase 3 day-10: log-line use only.

    let crate::loro::shared::ShadowState { registry } = state;

    let mut guard = match registry.for_space(space_id, device_id) {
        Ok(g) => g,
        Err(e) => {
            tracing::warn!(
                space_id = %space_id,
                device_id,
                error = %e,
                "shadow_apply: registry.for_space failed; skipping",
            );
            return;
        }
    };
    let engine = guard.engine_mut();

    // Dispatch on op_type.  Phase-2 day-8.5 expanded coverage to TEN
    // op types (the original five — CreateBlock / EditBlock /
    // DeleteBlock / MoveBlock / SetProperty — plus AddTag / RemoveTag
    // / RestoreBlock / PurgeBlock / DeleteProperty).  AddAttachment /
    // DeleteAttachment remain log+skip — those are file-blob ops and
    // the file lives outside the CRDT state.
    let dispatch_result: Result<(), crate::error::AppError> = match op {
        crate::op::OpPayload::CreateBlock(p) => {
            let parent = p.parent_id.as_ref().map(|id| id.as_str());
            let position = p.position.unwrap_or(0);
            engine
                .apply_create_block(
                    p.block_id.as_str(),
                    &p.block_type,
                    &p.content,
                    parent,
                    position,
                )
                .map(|_| ())
        }
        crate::op::OpPayload::EditBlock(p) => engine
            .apply_edit_via_diff_splice(p.block_id.as_str(), &p.to_text)
            .map(|_| ()),
        crate::op::OpPayload::DeleteBlock(p) => {
            engine.apply_delete_block(p.block_id.as_str()).map(|_| ())
        }
        crate::op::OpPayload::MoveBlock(p) => {
            let parent = p.new_parent_id.as_ref().map(|id| id.as_str());
            engine
                .apply_move_block(p.block_id.as_str(), parent, p.new_position)
                .map(|_| ())
        }
        crate::op::OpPayload::SetProperty(p) => {
            // Spike's engine accepts string values; production
            // SetProperty has multiple typed columns.  Stringify the
            // single set field to fit the spike's surface.
            let value: Option<String> = p
                .value_text
                .clone()
                .or_else(|| p.value_num.map(|n| n.to_string()))
                .or_else(|| p.value_date.clone())
                .or_else(|| p.value_ref.clone())
                .or_else(|| p.value_bool.map(|b| b.to_string()));
            engine
                .apply_set_property(p.block_id.as_str(), &p.key, value.as_deref())
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
        // AddAttachment / DeleteAttachment are out of scope per
        // Phase-2 day-8.5: attachments are file-blobs that live
        // outside CRDT state — the file body sits on disk under
        // `app_data_dir`, not inside the per-space LoroDoc.
        other => {
            tracing::debug!(
                op_id,
                op_type = %other.op_type_str(),
                "shadow_apply: op type out of scope (attachment file-blob); skipping",
            );
            return;
        }
    };

    if let Err(e) = dispatch_result {
        tracing::warn!(
            op_id,
            op_type = %op.op_type_str(),
            error = %e,
            "shadow_apply: engine apply failed; skipping",
        );
    }
}

/// Vestigial summary builder, retained for log-line continuity.
///
/// Pre-Phase-3-day-10 this fed the `diffy_result` column of the
/// `merge_parity_log` table.  Day-10 dropped the table; the helper
/// stays because materializer cohort-fanout still calls it to build
/// a string for `tracing::warn` output on apply failure.  Future
/// cleanup may inline the few remaining call sites and delete this.
pub(crate) fn diffy_summary_for(op: &crate::op::OpPayload) -> String {
    match op {
        crate::op::OpPayload::CreateBlock(p) => format!("create:{}", p.block_id.as_str()),
        crate::op::OpPayload::EditBlock(p) => {
            let head: String = p.to_text.chars().take(50).collect();
            format!("edit:{}:{}", p.block_id.as_str(), head)
        }
        crate::op::OpPayload::DeleteBlock(p) => format!("delete:{}", p.block_id.as_str()),
        crate::op::OpPayload::MoveBlock(p) => {
            let parent = p.new_parent_id.as_ref().map(|id| id.as_str());
            format!(
                "move:{}:{}:{}",
                p.block_id.as_str(),
                parent.unwrap_or("<root>"),
                p.new_position
            )
        }
        crate::op::OpPayload::SetProperty(p) => {
            let value: Option<String> = p
                .value_text
                .clone()
                .or_else(|| p.value_num.map(|n| n.to_string()))
                .or_else(|| p.value_date.clone())
                .or_else(|| p.value_ref.clone())
                .or_else(|| p.value_bool.map(|b| b.to_string()));
            format!(
                "set_property:{}:{}={}",
                p.block_id.as_str(),
                p.key,
                value.as_deref().unwrap_or("<null>")
            )
        }
        crate::op::OpPayload::AddTag(p) => {
            format!("add_tag:{}:{}", p.block_id.as_str(), p.tag_id.as_str())
        }
        crate::op::OpPayload::RemoveTag(p) => {
            format!("remove_tag:{}:{}", p.block_id.as_str(), p.tag_id.as_str())
        }
        crate::op::OpPayload::RestoreBlock(p) => format!("restore:{}", p.block_id.as_str()),
        crate::op::OpPayload::PurgeBlock(p) => format!("purge:{}", p.block_id.as_str()),
        crate::op::OpPayload::DeleteProperty(p) => {
            format!("delete_property:{}:{}", p.block_id.as_str(), p.key)
        }
        other => format!("unsupported:{}", other.op_type_str()),
    }
}
