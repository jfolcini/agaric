//! #2621 Sync-D: production moved to [`agaric_sync::snapshot`]; this app-side
//! app-side module hosts app-coupled tests (production lives in `agaric_sync::snapshot`);
//! hosts the app-coupled tests (`src/snapshot/tests.rs`, which reference app-only
//! `Materializer` / `recovery` and the proptest harness).
//!
//! The `codec` / `types` submodules are `pub mod` in the moved crate so the
//! test's `super::codec::…` / `super::types::…` paths resolve through the glob
//! re-export below.
#![cfg_attr(test, allow(unused_imports))]

#[cfg(test)]
use agaric_sync::snapshot::*;

#[cfg(test)]
mod tests;
