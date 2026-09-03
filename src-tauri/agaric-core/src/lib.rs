// Test bodies are exempt from the 70-code-line ceiling (AGENTS.md "Patterns
// caught in review" item 6); production functions over it carry `#[expect]`
// so the marker expires when the function is split (#4639).
#![cfg_attr(test, allow(clippy::too_many_lines))]
//! `agaric-core` — foundation crate for the layered-workspace split (#2621).
//!
//! Wave 1: the pure-leaf modules carved out of the `agaric` app crate.
//! Each depends only on std + external crates, never on another app
//! module, so they form the bottom of the dependency DAG. The `agaric`
//! crate re-exports them (`pub use agaric_core::error;` …) to keep every
//! existing `crate::error::…` path resolving unchanged.

pub mod attachment_filename;
pub mod attachment_path;
pub mod date_filter;
pub mod date_validation;
pub mod error;
pub mod foreground;
pub mod hash;
pub mod sql_utils;
pub mod sync_status;
pub mod tag_norm;
pub mod text_utils;
pub mod time;
pub mod ulid;
pub mod word_diff;
