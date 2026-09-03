//! Pages command handlers.
//!
//! #644 — split from the former monolithic `commands/pages.rs` into cohesive
//! feature submodules (behaviour-preserving verbatim move). Each submodule is
//! glob-re-exported so every `crate::commands::pages::<name>` path — the
//! `invoke_handler!` macro in `lib.rs`, the `pub use pages::{…}` blocks in
//! `commands/mod.rs`, and the `tests/commands/*` suite — resolves exactly as
//! it did when this was a single file.

pub(crate) mod aliases;
pub mod bibliography;
pub mod inline_query_md;
pub(crate) mod links;
pub mod listing;
pub mod markdown;
pub(crate) mod markdown_yaml;
pub mod metadata;

pub use aliases::*;
pub use bibliography::*;
pub use links::*;
pub use listing::*;
pub use markdown::*;
pub use metadata::*;
