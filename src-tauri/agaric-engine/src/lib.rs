// Test bodies are exempt from the 70-code-line ceiling (AGENTS.md "Patterns
// caught in review" item 6); production functions over it carry `#[expect]`
// so the marker expires when the function is split (#4639).
#![cfg_attr(test, allow(clippy::too_many_lines))]
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
//! engine module. The `agaric` crate re-exports it
//! (`pub use agaric_engine::loro;`) so every existing `crate::loro::…` path
//! resolves unchanged.

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
/// `sqlx::query!` sites captured in the workspace-root `.sqlx` cache. The `agaric`
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

/// The spaces-bootstrap sibling core (#2621 THE INVERSION) — the
/// transaction-scoped inner core of the boot-time spaces bootstrap: the
/// seeded-space ULID/accent consts, the idempotent seeded-block /
/// `is_space` / `accent_color` writers, the page-space backfill, and the
/// orphan-tag majority-space assignment. Builds on the sibling
/// `block_ops` writer (`set_property_in_tx`) and the store
/// (`agaric_store::{op_log, op, db}`); carries the spaces `sqlx::query!` sites.
/// The app keeps the `CommandTx` / `Materializer` orchestration behind an
/// unchanged shim (`crate::spaces::bootstrap::bootstrap_spaces`) and
/// re-exports the consts + `migrate_orphan_tags_to_space` /
/// `repair_misfiled_tag_spaces` at `crate::spaces::…` so those call sites
/// resolve unchanged.
pub mod spaces;

/// Boot-time sweep of leaked empty blocks (#4729 part 2): the eight-guard
/// deletion predicate, the age floor and per-boot cap, and the cursor that
/// keeps every boot after the first off a full `blocks` walk. Emits
/// `DeleteBlock` ops through `apply_op_projected` — never a raw tombstone
/// write. The app's `soft_delete::empty_block_sweep` drives it after
/// `bootstrap_spaces`, in a non-fatal `CommandTx` of its own.
pub mod empty_blocks;

/// Replays a stale editor's change on the block's current text, so an
/// `edit_block` from an editor that has not seen a peer's edit keeps it.
pub mod edit_rebase;

/// Boot-time repairs that make historically-unreachable content reachable
/// again (#4728 orphans re-homed under an `Unreachable` page, #4715 duplicate
/// journal pages merged onto the oldest). Every change is a real op through
/// `apply_op_projected`, appended as `Actor::Housekeeping` so positional undo
/// never reverts a repair. The app's `repair` module drives each in a
/// non-fatal `CommandTx` of its own after the empty-block sweep.
pub mod repair;

/// Op-log ingest for a peer's replicated audit records
/// (`ingest_replicated_record`, which the app's `OpTransfer` shim decodes
/// into), plus `get_block_edit_heads` and `parse_parent_seqs_canonical`.
pub mod dag;

pub mod reverse;

/// The op-log→SQL projection queue (#4502, #4499 phase 2): the `Materializer`
/// coordinator, its foreground/background consumers, dispatch, dedup, the
/// persisted retry queue and the queue metrics. Builds on the sibling `apply`
/// kernel and `loro` engine plus `agaric-store` (db/op/op_log/cache/fts/
/// tag_inheritance); carries the queue's `sqlx::query!` sites. The app passes
/// its runtime handle in at construction (its `setup` runs outside any
/// runtime) and re-exports the module (`pub use agaric_engine::materializer;`)
/// so every `crate::materializer::…` path resolves unchanged. The tests that
/// drive the app's command layer, `CommandTx` or the reconciliation oracle
/// stay app-side as `materializer_app_tests`.
pub mod materializer;

/// TEST-PROPTEST-B (#150): shared seeded-DB proptest fixture harness —
/// random valid block trees + op chains over a real pool. Reused by
/// `tests/reverse_proptest_b1.rs` here and by the app crate's B2-B4
/// proptests, hence `test-util` rather than `cfg(test)`.
#[cfg(any(test, feature = "test-util"))]
pub mod proptest_db_harness;
