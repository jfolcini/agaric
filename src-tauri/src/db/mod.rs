mod command_tx;
mod pool;
mod recovery;

pub use command_tx::*;
// #2621 wave S3b-i: the pure, sqlx-free pool primitives (`DbPools`,
// `WritePool`, `ReadPool`, `base_connect_options`, the acquire/begin logging
// helpers, the pragma consts, `now_ms` / `next_delete_ms`) now live in
// `agaric-store`. Re-export them so every existing `crate::db::…` path resolves
// unchanged. The local `pool` glob below carries only the app-side remainder
// (`WriteCtx`, `init_pools`, `init_pool`) — the two export disjoint names, so
// the globs don't collide.
// kept (#2897): aggregation seam — app `db` module composes store primitives
// (`DbPools`/pragmas/`now_ms`) with app-local `command_tx`/`pool`/`recovery`.
pub use agaric_store::db::*;
pub use pool::*;
// #1893: the reserved-key→`blocks`-column mapping (`reserved_key_blocks_column`)
// is the single drift-tested source of truth and is reused by the op-log
// projection (`loro::projection`, now in agaric-engine) as well as recovery.
// It moved down into `agaric_store::db` (#2621, wave E1) so both the app and
// the engine can reach it; the `pub use agaric_store::db::*;` glob above
// re-exports it, so `crate::db::reserved_key_blocks_column` resolves unchanged.
// Other recovery helpers are crate-internal. Non-test callers reach them via
// their module path (`super::recovery::…` inside `db`); this glob exists only so
// the `tests` module (`db/tests.rs`) — which uses `super::*` per repo
// convention — keeps seeing them unqualified.
#[cfg(test)]
pub(crate) use recovery::*;

#[cfg(test)]
mod tests;
