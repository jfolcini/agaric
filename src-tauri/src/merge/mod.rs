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

// Test-only alias: the existing test suite was written against the old
// name `merge_block`. Production callers MUST use `merge_block_text_only`
// so the text-only scope is explicit at the call site (M-73). This alias
// is gated on `cfg(test)` so it cannot leak into production code.
#[cfg(test)]
pub(crate) use apply::merge_block_text_only as merge_block;

// ---------------------------------------------------------------------------
// PEND-09 Phase 1 day-1 — shadow-mode dual-write hook.
//
// `shadow_apply` is the call site that, once Phase 1 progresses, will
// run every applied op through both the diffy merge layer AND the
// Loro `LoroEngine`, log the per-op parity result, and return the
// diffy result as authoritative.  Today's day-1 stub establishes the
// call shape and the feature-flag gating only — the actual dual-write
// logic + the wiring at real call sites is later-day work
// (SPIKE-REPORT.md §6 item 5).
//
// **No-op when `loro-shadow` is off.**  The function exists as
// `pub(crate)` regardless of feature so the call sites that *will*
// invoke it (in later Phase-1 days) don't need their own `#[cfg]`
// gates.  The body is the only thing that varies by feature.
// ---------------------------------------------------------------------------

/// Shadow-mode dual-write entry point.
///
/// `op_id` is a caller-supplied identity (production will pass the
/// op_log row's `(device_id, seq)` composite or `hash`).  Today's
/// stub only does anything when the `loro-shadow` feature is on, and
/// even then is a no-op placeholder — it doesn't actually run a
/// LoroEngine apply yet.  The point of the day-1 deliverable is the
/// call shape exists and compiles; days 2-3 wire it to real call
/// sites and exercise the real engine.
///
/// Returns nothing because the diffy result remains authoritative
/// for Phase 1; this hook records observations only.
// `dead_code` allow: day-1 lands the call shape only.  Real call
// sites get wired in days 2-3 (SPIKE-REPORT.md §6 item 5).  The
// allow attribute disappears the moment a real caller appears.
#[allow(unused_variables, dead_code)]
pub(crate) fn shadow_apply(op_id: &str) {
    #[cfg(feature = "loro-shadow")]
    {
        // Day-2/3 work: build/look-up the per-space `LoroEngine`
        // handle, dispatch the op, and write to the parity sampler.
        // Today the stub is intentionally empty — wiring the engine
        // requires the `loro_batch` payload envelope (item 4 on the
        // SPIKE-REPORT.md §6 readiness checklist), which is also
        // later-day work.
        //
        // Touching `op_id` here keeps the parameter live under the
        // feature flag without committing to a concrete sink.
        let _ = op_id;
    }
}
