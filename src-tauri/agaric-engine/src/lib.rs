//! `agaric-engine` — the CRDT / document-domain layer for the layered-workspace
//! split (#2621).
//!
//! Sits above `agaric-store` (persistence + read/query) and below the `agaric`
//! app crate — the home of the Loro CRDT runtime and the `dag` materializer as
//! their extraction lands. Wave E0 establishes the crate with the query-free
//! leaf `bibliography` module (a pure BibTeX / CSL-JSON import parser — no
//! sqlx, no IO, no app-layer coupling; depends only on `agaric-core`'s `error`
//! module + serde_json). The `agaric` crate re-exports it
//! (`pub use agaric_engine::bibliography;`) so every existing
//! `crate::bibliography::…` path resolves unchanged.
//!
//! Wave E1 folds in the Loro CRDT runtime (`loro`) — the first query-bearing
//! engine module, so the crate now carries its own `.sqlx` offline cache
//! (migrations symlink + committed cache, mirroring `agaric-store`). The
//! `agaric` crate re-exports it (`pub use agaric_engine::loro;`) so every
//! existing `crate::loro::…` path resolves unchanged.

pub mod bibliography;

/// The Logseq/Markdown import parser (#2621, wave E4-import) — parses indented
/// markdown into a flat list of blocks plus the import-outcome specta types
/// (`ImportResult` / `ImportProgressUpdate` / `VaultFile`). Query-free: pure
/// string/regex parsing with no sqlx, no IO, no app-layer coupling; depends
/// only on `agaric-core` (`text_utils::strip_yaml_quotes`) and `agaric-store`
/// (`block_descendants::MAX_BLOCK_DEPTH`). The `agaric` crate re-exports it
/// (`pub use agaric_engine::import;`) so every existing `crate::import::…` path
/// resolves unchanged.
pub mod import;

/// The block draft writer — the autosave buffer for in-progress editor edits
/// (`block_drafts` table). An independent document-domain leaf: depends only on
/// `agaric-store` (db/op/op_log) and `agaric-core` (error/ulid), with two
/// `sqlx::query!` sites captured in this crate's `.sqlx` cache. The `agaric`
/// crate re-exports it (`pub use agaric_engine::draft;`) so every existing
/// `crate::draft::…` path resolves unchanged.
pub mod draft;

/// The Loro CRDT engine — per-space `LoroEngine` runtime, the block-projection
/// writer (`projection`), the engine registry, snapshot persistence, revert,
/// and peer-epoch bookkeeping. Depends on `agaric-core` (error/ulid/hash/
/// tag_norm) and `agaric-store` (db/op/space/block_descendants) plus the `loro`
/// CRDT crate; carries `sqlx::query!` macros against the workspace schema.
pub mod loro;

/// CRDT merge dispatch — applies an inbound `OpPayload` to a space's
/// `LoroState` (`engine_apply`) and counts divergence between local/remote
/// frontiers (`divergence`). Query-free and engine-clean: depends only on
/// sibling `loro` plus `agaric-store` (op/space) and `agaric-core` (ulid/error).
/// The `agaric` crate re-exports it (`pub use agaric_engine::merge;`) so every
/// existing `crate::merge::…` path resolves unchanged (#2621, wave E3-merge).
pub mod merge;

/// The per-op apply kernel (#2621 THE INVERSION) — the projection kernel that
/// turns one op-log record into materialised SQL + drives the per-space Loro
/// engine: `apply_op_projected` / `apply_op_tx` / `advance_apply_cursor`, the
/// `ApplyEffects` / `ChunkAccumulator` types, the descendant-cohort collectors,
/// the engine-routed `apply_*_via_loro` handlers, the `apply_*_sql_only`
/// fallbacks, the `pages_cache` count maintenance, and the three attachment
/// writers. Builds on `agaric-store` (Pieces A+B: `rederive_page_and_space_ids`,
/// `cross_space_validation`) plus the sibling `loro` / `merge` modules; carries
/// the bulk of the crate's `sqlx::query!` sites. The app re-exports each
/// submodule through shims at the old `crate::materializer::handlers::…` paths
/// so the coordinator / queue / command sites compile unchanged. The
/// `recompute_call_spy` invocation counter is exposed via the `test-util`
/// feature (like loro's `reproject_call_spy`) so the app's import-scaling tests
/// can read it across the crate boundary.
pub mod apply;

/// Neutral block-write core (#2621 THE INVERSION) — the pure validators / typed
/// property-arg builders / content caps plus the three in-transaction writers
/// (`create_block_in_tx`, `set_property_in_tx`,
/// `set_property_in_tx_with_declaration`). They drive the moved apply kernel
/// (`apply::kernel::apply_op_projected`) + the store's `cross_space_validation`,
/// and carry one `query_as!` site. The app re-exports the module
/// (`pub use agaric_engine::block_ops::*;`) at `crate::domain::block_ops` so the
/// recurrence / bootstrap / command call sites resolve unchanged.
pub mod block_ops;

/// The recurrence-sibling core (#2621 THE INVERSION) — the transaction-scoped
/// inner core of the recurring-task flow: `build_recurrence_sibling_in_tx`
/// reads a block's `repeat` properties, evaluates the end conditions, and
/// creates the next sibling occurrence plus its recurrence properties, plus the
/// pure `shift_date` rule-string parser. Builds on the sibling `block_ops`
/// writers (`create_block_in_tx` / `set_property_in_tx` / `is_valid_iso_date`)
/// and the store's pure interval math (`agaric_store::recurrence_math`); carries
/// the recurrence `sqlx::query!` sites. The app keeps the `CommandTx` /
/// `Materializer` orchestration behind unchanged shims
/// (`crate::recurrence::compute::handle_recurrence` / `handle_recurrence_in_tx`)
/// and re-exports `shift_date` at `crate::recurrence::…` so those call sites
/// resolve unchanged.
pub mod recurrence;
