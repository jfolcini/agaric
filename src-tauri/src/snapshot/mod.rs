//! #2621 Sync-D: production moved to [`agaric_sync::snapshot`]; this app-side
//! shim re-exports it so every `crate::snapshot::…` path resolves unchanged, and
//! hosts the app-coupled tests (`src/snapshot/tests.rs`, which reference app-only
//! `Materializer` / `recovery` and the proptest harness).
//!
//! The `codec` / `types` submodules are `pub mod` in the moved crate so the
//! test's `super::codec::…` / `super::types::…` paths resolve through the glob
//! re-export below.
#![cfg_attr(test, allow(unused_imports))]

pub use agaric_sync::snapshot::*;

#[cfg(test)]
mod tests;
