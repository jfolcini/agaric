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
//! Query-free for now, so the crate stands up NO `.sqlx` offline cache yet —
//! that lands when the DB-touching engine modules (loro / dag) move.

pub mod bibliography;
