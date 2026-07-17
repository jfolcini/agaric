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

/// The Loro CRDT engine — per-space `LoroEngine` runtime, the block-projection
/// writer (`projection`), the engine registry, snapshot persistence, revert,
/// and peer-epoch bookkeeping. Depends on `agaric-core` (error/ulid/hash/
/// tag_norm) and `agaric-store` (db/op/space/block_descendants) plus the `loro`
/// CRDT crate; carries `sqlx::query!` macros against the workspace schema.
pub mod loro;
