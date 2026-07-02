mod command_tx;
mod pool;
mod recovery;

pub use command_tx::*;
pub use pool::*;
// #1893: the reserved-key→`blocks`-column mapping (`reserved_key_blocks_column`)
// is the single drift-tested source of truth and is reused by the op-log
// projection (`loro::projection`) as well as recovery. Re-export it so that
// cross-module caller can reach it without exposing the whole `recovery`
// module.
pub(crate) use recovery::reserved_key_blocks_column;
// Other recovery helpers are crate-internal. Non-test callers reach them via
// their module path (`super::recovery::…` inside `db`); this glob exists only so
// the `tests` module (`db/tests.rs`) — which uses `super::*` per repo
// convention — keeps seeing them unqualified.
#[cfg(test)]
pub(crate) use recovery::*;

#[cfg(test)]
mod tests;
