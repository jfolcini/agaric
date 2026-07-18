//! Extracted handler functions for the materializer queues.
//!
//! #644: this module was split from a single ~4.9K-line `handlers.rs`
//! into per-responsibility submodules. The split is a pure move — every
//! function body, SQL string, and `// dynamic-sql:` justification is
//! verbatim from the original file; the only edits are the `mod`/`use`
//! plumbing here and the `pub(super)` visibility raises that let the
//! submodules call one another. The shared imports below are pulled into
//! each submodule via `use super::*;`, and the cross-submodule call graph
//! resolves through the private `use <submod>::*;` glob re-exports here.
//!
//! Submodules:
//! - `task_handlers`: foreground/background queue task dispatch.
//! - `apply`: the per-op apply transaction, apply cursor, and
//!   Restore/Delete cascade fan-out + cohort collectors.
//!   `pages_cache`: `pages_cache.{inbound_link_count,
//!   child_block_count}` maintenance (the canonical recompute SELECT).
//! - `loro_apply`: engine-routed `apply_*_via_loro` + the SQL purge cascade.
//! - `sql_only`: the `apply_*_sql_only` projection fallbacks.
//! - `attachments`: attachment apply handlers + orphan-cleanup (C-3c).

// #2621 (THE INVERSION): the apply kernel moved DOWN into `agaric-engine`; the
// submodule files below are now thin re-export shims (plus the app-side
// coordinator glue that stays: `apply_op` + the `dispatch_*` fan-out,
// `task_handlers`, the attachment GC, the two metric counters). The shared
// prelude is trimmed to only what that staying code still uses unqualified via
// `use super::*;`.
use super::MaterializeTask;
use crate::cache;
use crate::error::AppError;
use crate::fts;
use crate::op::{DeleteBlockPayload, OpType};
use crate::op_log::OpRecord;
use crate::tag_inheritance;
use sqlx::SqlitePool;
use std::path::{Path, PathBuf};
use std::sync::Arc;

mod apply;
mod attachments;
pub(crate) mod descendant_fanout_dropped;
mod loro_apply;
mod pages_cache;
mod sql_only;
pub(crate) mod sql_only_fallback;
mod task_handlers;

// Private glob re-exports so the STAYING sibling submodules (`apply`'s
// `apply_op` + fan-out, `task_handlers`) resolve the re-exported kernel items
// through their own `use super::*;` (e.g. `task_handlers` calling `apply_op_tx`
// / `ChunkAccumulator` / `recompute_pages_cache_counts_for_pages`). The
// engine-routed `loro_apply` / `sql_only` / `attachments` submodules are now
// shims that nothing app-side calls unqualified, so their globs are gone.
use apply::*;
use pages_cache::*;
// The engine-routed `apply_*_via_loro` / `apply_*_sql_only` handlers are called
// by the moved kernel INSIDE `agaric-engine`; app-side, only the engine-path
// convergence tests reach them unqualified via `use super::*;`. Gate the shim
// globs to the test build so they don't warn as unused in the production lib.
#[cfg(test)]
use loro_apply::*;
#[cfg(test)]
use sql_only::*;

// External re-exports — preserve the pre-split paths so callers outside
// this module (materializer/mod.rs, consumer.rs, tests.rs) do not change.
pub(crate) use attachments::cleanup_orphaned_attachments;
// #2110 M6 — the two process-global counter accessors, re-exported with
// disambiguating names (both submodules name their getter `count()`) so
// `materializer/mod.rs` can surface them to the OTel metrics pipeline.
pub(crate) use descendant_fanout_dropped::count as descendant_fanout_dropped_count;
pub(crate) use sql_only_fallback::count as sql_only_fallback_count;
// #2621: the LOCAL command paths now route their engine-apply through the moved
// kernel `apply_op_projected` (see `domain::block_ops`), not these per-op
// `apply_*_via_loro` helpers directly. The engine-path convergence tests reach
// the handlers unqualified via the `#[cfg(test)] use loro_apply::*;` glob above,
// so no explicit per-fn re-export is needed here any longer.
// #1257 the LOCAL delete / restore / purge command paths PRE-CAPTURE each
// root's subtree COHORT + SPACE below the SQL soft-delete (these collectors)
// and then drive the captured cohort onto the per-space Loro engine via the
// post-commit fan-out (`dispatch_*_descendants`) — mirroring `apply_op_tx` +
// `apply_op`. The cohort + space MUST be captured before the SQL UPDATE (else a
// post-delete `resolve_block_space` returns None → the engine misses the
// cascade → the #1257 phantom). The apply cursor stays put (boot-replay /
// `dispatch_op` concern only). The `apply_*_via_loro` CASCADE helpers are also
// raised to `pub(crate)` at their definitions (consumed crate-internally via
// the `use loro_apply::*` glob below) so they sit on the same engine-apply
// Surface established; the multi-root command path itself routes the
// engine through the fan-out + `merge::engine_apply` rather than the per-seed
// helper (the helper's single-root SQL projection would double-count the
// multi-root cascade; a post-cascade call hits dead space resolution).
pub(crate) use apply::{
    collect_delete_cohort, collect_restore_cohort, dispatch_delete_descendants,
    dispatch_restore_ancestors, dispatch_restore_descendants,
};
// #2325/#2250: the single collapsed apply-projection entry point. The LOCAL
// command sites route through this (`advance_cursor = false`) instead of
// calling `apply_*_via_loro` directly, so the LOCAL and REMOTE paths share one
// projection function whose only variation is the cursor-advance flag.
pub(crate) use apply::apply_op_projected;
// #2128 test-only: surface the LOCAL SQL purge cascade so the inbound-purge
// parity test can build a local-purge oracle DB (re-exported up through
// `materializer/mod.rs`).
#[cfg(test)]
pub(crate) use loro_apply::purge_block_sql_cascade;
#[cfg(test)]
pub(crate) use pages_cache::recompute_pages_cache_counts_for_pages;
// #2831: `handle_background_task` (unmetered) is test-only in a non-test lib
// build now that the consumer routes through `handle_background_task_metered`.
#[cfg_attr(not(test), allow(unused_imports))]
pub(crate) use task_handlers::{
    handle_background_task, handle_background_task_metered, handle_foreground_task,
};

#[cfg(test)]
mod apply_reproject_proptest;
#[cfg(test)]
mod crash_injection_convergence_tests;
#[cfg(test)]
mod create_edit_convergence_tests;
#[cfg(test)]
mod delete_cascade_tests;
#[cfg(test)]
mod delete_restore_convergence_tests;
#[cfg(test)]
mod engine_path_tests;
#[cfg(test)]
mod import_scaling_tests;
#[cfg(test)]
mod move_convergence_tests;
#[cfg(test)]
mod move_sql_only_cycle_tests;
#[cfg(test)]
mod restore_cascade_tests;
#[cfg(test)]
mod sibling_order_full_apply_603_tests;
#[cfg(test)]
mod space_hydration_tests;
#[cfg(test)]
mod static_source_checks;
#[cfg(test)]
mod tag_convergence_tests;
