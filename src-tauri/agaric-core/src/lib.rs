//! `agaric-core` — foundation crate for the layered-workspace split (#2621).
//!
//! Wave 1: the pure-leaf modules carved out of the `agaric` app crate.
//! Each depends only on std + external crates, never on another app
//! module, so they form the bottom of the dependency DAG. The `agaric`
//! crate re-exports them (`pub use agaric_core::error;` …) to keep every
//! existing `crate::error::…` path resolving unchanged.

pub mod error;
pub mod hash;
pub mod sql_utils;
pub mod tag_norm;
pub mod text_utils;
pub mod word_diff;
