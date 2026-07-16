//! `agaric-store` — persistence + read/query layer for the layered-workspace
//! split (#2621).
//!
//! Sits between `agaric-core` (pure foundation) and the `agaric` app crate.
//! Wave S1 establishes the crate with the pure-leaf `cancellation` module
//! (cooperative cancellation tokens; std + tokio only — no DB, no other app
//! module, the natural bottom of the store layer). The `agaric` crate
//! re-exports it (`pub use agaric_store::cancellation;`) so every existing
//! `crate::cancellation::…` path resolves unchanged.
//!
//! Later waves add the DB core (`op`, `op_log`, `db`) with a store-local
//! `.sqlx` offline cache + a 2nd `sqlx prepare` CI lane, then the query
//! modules (`pagination`, `fts`, `cache`, …).

pub mod cancellation;
// `op` — op-type / op-payload value types (the op-log record shape). Pure:
// depends only on `agaric-core` (`error`, `hash`, `ulid`) + serde/specta.
pub mod op;
// `task_locals` — crate-wide tokio task-locals (op-append provenance + actor
// identity). Depends only on the sibling `op` module.
pub mod task_locals;
// `db` — pure, sqlx-free SQLite pool primitives (pool value types, slow-acquire
// logging helpers, connect-options builder + pragma consts, epoch-ms clocks).
// The app re-exports it (`pub use agaric_store::db::*;`) so every existing
// `crate::db::…` path resolves unchanged.
pub mod db;
// `op_log` — op-log writer / reader (append, bypass, payload, query, record).
// Carries `sqlx::query!` macros, so the crate now stands up its own `.sqlx`
// offline cache (prepared against `../dev.db`) + a 2nd `sqlx prepare` CI lane.
// External deps are `agaric_core::{error,hash}`; `op`, `task_locals`, and `db`
// are store siblings. The app re-exports it (`pub use agaric_store::op_log;`)
// so every existing `crate::op_log::…` path resolves unchanged.
pub mod op_log;
