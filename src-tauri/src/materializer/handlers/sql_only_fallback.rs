//! #1057 SQL-only fallback observability hook.
//!
//! #2621 (THE INVERSION): this process-global fallback counter moved DOWN into
//! `agaric_engine::apply::sql_only_fallback` alongside the `apply_*_via_loro`
//! handlers that record into it. This shim re-exports it so the coordinator's
//! status builder + tests keep reading the same static through
//! `crate::materializer::handlers::sql_only_fallback::{count, …}` (and the
//! `sql_only_fallback_count` alias in `mod.rs`).

pub(crate) use agaric_engine::apply::sql_only_fallback::*;
