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
// ── Wave S4a (#2621): five leaf read/query modules + a reusable test_support.
// The app re-exports each so `crate::<mod>::…` paths resolve unchanged.
//
// `space` — `SpaceId`/`SpaceScope` newtype + space-scoped query helpers.
pub mod space;
// `space_filter_canonical` — drift-detection parity guard for the space-filter
// SQL fragment (test-only canonical; a couple of `query!`-shaped helpers).
pub mod space_filter_canonical;
// `block_descendants` — shared recursive descendant/ancestor CTEs, exposed as
// `#[macro_export]` `macro_rules!` (`descendants_cte_*!`, `ancestors_cte_*!`).
// The macros land at the crate root; the app re-exports them so
// `crate::descendants_cte_*!` paths resolve unchanged.
pub mod block_descendants;
// `peer_refs` — peer-ref read/write helpers + pending-pairing marker.
pub mod peer_refs;
// `tag_inheritance_macros` — the `#[macro_export]` `tag_inh_*!` CTE macros that
// emit `tag_inheritance`'s sqlx queries. MUST precede `tag_inheritance`; the
// app re-exports the macros so `crate::tag_inh_*!` paths resolve unchanged.
pub mod tag_inheritance_macros;
// `tag_inheritance` — incremental maintenance of the `block_tag_inherited`
// cache. Built entirely on the `tag_inh_*!` macro family above.
pub mod tag_inheritance;

// ── Wave S4b (#2621): two read/query modules. The app re-exports each so
// `crate::<mod>::…` paths resolve unchanged.
//
// `pagination` — cursor-based keyset pagination (the eleven paginated query
// functions + cursor codec). Leaf read module. A handful of phase-7
// cross-space tests that call app-only command inner functions relocated to
// the app crate (`pagination_app_tests`).
pub mod pagination;
// `tag_query` — tag search / prefix-resolve read queries. Builds on the
// sibling `tag_inheritance` + `pagination` modules.
pub mod tag_query;

// `test_support` — recovery-free test scaffolding (temp-file WAL `test_pool`
// + `insert_block` + space helpers) that the moved tests use in place of the
// app's `crate::db::init_pool` / `crate::commands::tests::common`. Later S4
// waves reuse it. Compiled only for the store's own test build.
#[cfg(test)]
pub mod test_support;
