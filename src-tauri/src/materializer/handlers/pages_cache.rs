//! `pages_cache.{inbound_link_count,child_block_count}`
//! maintenance: the canonical recompute SELECT and the per-op
//! affected-page resolution hooks.

// #2621 (THE INVERSION): `pages_cache` count maintenance moved DOWN into
// `agaric_engine::apply::pages_cache`. This shim re-exports the maintenance
// fns + helpers (and, via the engine `test-util` feature, the
// `recompute_call_spy` invocation counter the import-scaling tests read) so
// the old `crate::materializer::handlers::…` paths resolve unchanged.
pub(crate) use agaric_engine::apply::pages_cache::*;
