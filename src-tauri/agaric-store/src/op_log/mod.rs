//! Op log writer — appends local operations to the `op_log` table.
//!
//! Phase 1 implementation: single-device, linear chain. Each new op references
//! the immediately preceding op from the same device as its sole parent.

mod append;
mod bypass;
mod high_water;
mod payload;
mod query;
mod record;

pub use append::*;
pub use bypass::*;
// #3310 / #3998: the durable per-device seq high-water that survives BOTH
// wholesale op_log wipes (compaction prune and the snapshot-RESET truncate).
pub use high_water::*;
// `payload` exports two `pub` production helpers (`serialize_inner_payload`,
// `extract_indexed_ids_from_payload`) consumed cross-crate by the app's
// `crate::dag` remote-ingest path (#2621, wave S3b-ii); the single-field
// `extract_*_from_payload` oracles stay `#[cfg(test)]` for the store's own tests.
pub use payload::*;
pub use query::*;
pub use record::*;

#[cfg(test)]
mod tests;
