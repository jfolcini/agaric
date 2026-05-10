//! Three-way merge using diffy.
//!
//! Provides:
//! - `merge_text()` — three-way text merge for a block's content
//! - `create_conflict_copy()` — creates a conflict copy block when merge fails
//! - `resolve_property_conflict()` — LWW for concurrent property changes
//! - `merge_block_text_only()` — text-only merge orchestrator for a single
//!   block's `edit_block` history. Deliberately scoped: callers must
//!   compose property/move/delete-resurrect passes separately (see
//!   `sync_protocol::operations::merge_diverged_blocks`).

mod apply;
mod detect;
mod resolve;
mod types;

#[cfg(test)]
mod tests;

pub use apply::merge_block_text_only;
pub use detect::merge_text;
pub use resolve::{create_conflict_copy, resolve_property_conflict};
pub use types::{MergeOutcome, MergeResult, PropertyConflictResolution};

// PEND-09 Phase 1 day-3 — re-export the shadow-mode dispatcher so the
// materializer (`materializer::handlers::apply_op`) and any other
// per-op call sites can reach it without depending on the
// `merge::apply` private module path.  Feature-gated: with
// `loro-shadow` off the symbol does not compile, mirroring
// `shadow_apply` below.
#[cfg(feature = "loro-shadow")]
pub(crate) use apply::shadow_dispatch_for_record;

// Test-only alias: the existing test suite was written against the old
// name `merge_block`. Production callers MUST use `merge_block_text_only`
// so the text-only scope is explicit at the call site (M-73). This alias
// is gated on `cfg(test)` so it cannot leak into production code.
#[cfg(test)]
pub(crate) use apply::merge_block_text_only as merge_block;

// ---------------------------------------------------------------------------
// PEND-09 Phase 1 day-2 — shadow-mode dual-write hook.
//
// `shadow_apply` is the call site that runs every applied op through
// both the diffy merge layer AND the per-space Loro `LoroEngine`,
// logs a per-op parity event into the in-memory ring buffer, and
// returns the diffy result as authoritative (Phase 1 is "shadow mode" —
// diffy stays the source of truth for the entire phase).
//
// **No-op when `loro-shadow` is off.**  The function exists as
// `pub(crate)` regardless of feature so the call sites that invoke it
// (currently `merge::apply::merge_block_text_only`, future per-op
// apply paths) don't need their own `#[cfg]` gates.  The body is the
// only thing that varies by feature.
// ---------------------------------------------------------------------------

/// Shadow-mode dual-write entry point.
///
/// `op_id` is a caller-supplied identity (production will pass the
/// op_log row's `(device_id, seq)` composite formatted as `"DEV/SEQ"`).
/// `op` is the typed payload that diffy just produced; we mirror it
/// onto the per-space `LoroEngine` and record a [`ParityEvent`].
///
/// `space_id` is the engine partition key — every op carries an
/// implicit space (its block's owning page resolves to one space)
/// and the registry holds one engine per space.
///
/// `device_id` is the production UUID-v4 device id.  It's threaded
/// through to [`LoroEngine::with_peer_id`] so the engine's Loro
/// peer id is stable across the process lifetime.
///
/// `diffy_result_summary` is a small human-readable string (e.g. for
/// CreateBlock the resulting block_id; for EditBlock the post-content's
/// first 50 chars) used for the parity event's `diffy_result` column.
/// Today's "match" is coarse: string-equality on the diffy and Loro
/// summaries.  Day-4 (persistent SQLite parity sink) will refine the
/// summary shape and the match semantics.
///
/// Returns nothing because the diffy result remains authoritative for
/// Phase 1; this hook records observations only.
// PEND-09 Phase 1 day-3 — the off-side `(op_id, op, device_id)` stub
// was deleted; the day-2 reviewer flagged the divergent two-signature
// shape as fragile under day-3 envelope work.  The single feature-on
// definition below is the only surface that ever exists.  Every caller
// in the codebase is itself `#[cfg(feature = "loro-shadow")]`-gated
// (see `merge/apply.rs` and `materializer/handlers.rs`), so removing
// the off-side stub has no effect on the feature-off build.
#[cfg(feature = "loro-shadow")]
pub(crate) fn shadow_apply(
    op_id: &str,
    op: &crate::op::OpPayload,
    device_id: &str,
    space_id: &crate::space::SpaceId,
    diffy_result_summary: String,
    state: &crate::loro::shared::ShadowState,
) {
    use crate::loro::parity::ParityEvent;

    let crate::loro::shared::ShadowState { registry, sampler } = state;

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

    // Dispatch on op_type and capture a small, human-readable
    // summary string.  Phase-2 day-8.5 expanded coverage to TEN op
    // types (the original five — CreateBlock / EditBlock / DeleteBlock /
    // MoveBlock / SetProperty — plus AddTag / RemoveTag / RestoreBlock /
    // PurgeBlock / DeleteProperty).  AddAttachment / DeleteAttachment
    // remain log+skip — those are file-blob ops and the file lives
    // outside the CRDT state, so the engine has nothing useful to
    // mirror (see SPIKE-REPORT.md and PEND-09 Phase-2 cutover plan §3
    // day-8.5).
    let dispatch_result: Result<String, crate::error::AppError> = match op {
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
                .map(|_| format!("create:{}", p.block_id.as_str()))
        }
        crate::op::OpPayload::EditBlock(p) => engine
            .apply_edit_via_diff_splice(p.block_id.as_str(), &p.to_text)
            .map(|_| {
                let head: String = p.to_text.chars().take(50).collect();
                format!("edit:{}:{}", p.block_id.as_str(), head)
            }),
        crate::op::OpPayload::DeleteBlock(p) => engine
            .apply_delete_block(p.block_id.as_str())
            .map(|_| format!("delete:{}", p.block_id.as_str())),
        crate::op::OpPayload::MoveBlock(p) => {
            let parent = p.new_parent_id.as_ref().map(|id| id.as_str());
            engine
                .apply_move_block(p.block_id.as_str(), parent, p.new_position)
                .map(|_| {
                    format!(
                        "move:{}:{}:{}",
                        p.block_id.as_str(),
                        parent.unwrap_or("<root>"),
                        p.new_position
                    )
                })
        }
        crate::op::OpPayload::SetProperty(p) => {
            // Spike's engine accepts string values; production
            // SetProperty has multiple typed columns.  Stringify the
            // single set field to fit the spike's surface.  Day-4 will
            // refine the encoding (likely a typed enum on the engine
            // side) — for now we collapse to a single string.
            let value: Option<String> = p
                .value_text
                .clone()
                .or_else(|| p.value_num.map(|n| n.to_string()))
                .or_else(|| p.value_date.clone())
                .or_else(|| p.value_ref.clone())
                .or_else(|| p.value_bool.map(|b| b.to_string()));
            engine
                .apply_set_property(p.block_id.as_str(), &p.key, value.as_deref())
                .map(|_| {
                    format!(
                        "set_property:{}:{}={}",
                        p.block_id.as_str(),
                        p.key,
                        value.as_deref().unwrap_or("<null>")
                    )
                })
        }
        crate::op::OpPayload::AddTag(p) => engine
            .apply_add_tag(p.block_id.as_str(), p.tag_id.as_str())
            .map(|_| format!("add_tag:{}:{}", p.block_id.as_str(), p.tag_id.as_str())),
        crate::op::OpPayload::RemoveTag(p) => engine
            .apply_remove_tag(p.block_id.as_str(), p.tag_id.as_str())
            .map(|_| format!("remove_tag:{}:{}", p.block_id.as_str(), p.tag_id.as_str())),
        crate::op::OpPayload::RestoreBlock(p) => engine
            .apply_restore_block(p.block_id.as_str())
            .map(|_| format!("restore:{}", p.block_id.as_str())),
        crate::op::OpPayload::PurgeBlock(p) => engine
            .apply_purge_block(p.block_id.as_str())
            .map(|_| format!("purge:{}", p.block_id.as_str())),
        crate::op::OpPayload::DeleteProperty(p) => engine
            .apply_delete_property(p.block_id.as_str(), &p.key)
            .map(|_| format!("delete_property:{}:{}", p.block_id.as_str(), p.key)),
        // AddAttachment / DeleteAttachment are out of scope per Phase-2
        // day-8.5: attachments are file-blobs that live outside CRDT
        // state — the file body sits on disk under `app_data_dir`,
        // not inside the per-space LoroDoc.  Phase 3 may revisit if
        // attachment metadata (filename / mime) needs CRDT-style
        // merge; today the materializer's row-level write is enough.
        other => {
            tracing::debug!(
                op_id,
                op_type = %other.op_type_str(),
                "shadow_apply: op type out of scope (attachment file-blob); skipping",
            );
            return;
        }
    };

    let loro_result_summary = match &dispatch_result {
        Ok(summary) => summary.clone(),
        Err(e) => format!("error:{e}"),
    };

    // Coarse match: the diffy + loro summaries are stringified the
    // same way (e.g. both start with "create:<block_id>"), so a
    // string-equality is a usable first signal.  Day-4 refines this
    // to a content-aware comparison.
    let r#match = diffy_result_summary == loro_result_summary;

    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    // Day-14: snapshot the cutover flag at record time.  The bucket
    // semantics (the two summaries differ) do not change with the
    // flag, but a maintainer reading `parity_report` weeks later
    // needs to know whether diffy or Loro was authoritative when
    // each row was written.  Sub-100 µs hot-path read by contract
    // (see `crate::loro::cutover` module docs).
    let loro_authoritative = crate::loro::cutover::is_loro_authoritative();

    sampler.record(ParityEvent {
        op_id: op_id.to_string(),
        space_id: space_id.to_string(),
        op_type: op.op_type_str().to_string(),
        diffy_result: diffy_result_summary,
        loro_result: loro_result_summary,
        r#match,
        timestamp,
        loro_authoritative,
    });

    if !r#match {
        tracing::debug!(
            op_id,
            "shadow_apply: parity diverged (expected during early shadow mode)",
        );
    }
}

/// Build the same compact "summary" string `shadow_apply` produces
/// from the typed op, for the `diffy_result` side of the parity event.
/// Exposed as a sibling helper so callers in `merge/apply.rs` can
/// build the diffy summary using the same shape that the Loro side
/// emits — a perfect-string-match parity event means both layers
/// agreed at the structural level.
///
/// Used only with `loro-shadow` on; with the feature off this helper
/// is dead code and the gate hides it.
#[cfg(feature = "loro-shadow")]
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
        // Phase-2 day-8.5 — typed summaries for the five newly-mirrored
        // op types (AddTag / RemoveTag / RestoreBlock / PurgeBlock /
        // DeleteProperty).  `unsupported:` is now reachable only for
        // the attachment ops (AddAttachment / DeleteAttachment), which
        // are intentionally out of CRDT scope — see `shadow_apply`'s
        // dispatch comment.
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
