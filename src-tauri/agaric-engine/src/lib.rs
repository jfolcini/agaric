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
