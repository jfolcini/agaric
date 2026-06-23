//! Pages command handlers.
//!
//! #644 — split from the former monolithic `commands/pages.rs` into cohesive
//! feature submodules (behaviour-preserving verbatim move). Each submodule is
//! glob-re-exported so every `crate::commands::pages::<name>` path — the
//! `invoke_handler!` macro in `lib.rs`, the `pub use pages::{…}` blocks in
//! `commands/mod.rs`, and the `commands/tests/*` suite — resolves exactly as
//! it did when this was a single file.

pub(crate) mod aliases;
pub(crate) mod links;
pub(crate) mod listing;
pub(crate) mod markdown;
pub(crate) mod markdown_yaml;
pub(crate) mod metadata;

pub use aliases::*;
pub use links::*;
pub use listing::*;
pub use markdown::*;
pub use metadata::*;
