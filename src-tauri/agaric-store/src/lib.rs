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
