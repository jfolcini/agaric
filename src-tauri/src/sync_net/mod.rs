//! #2621 Sync-D: production moved to [`agaric_sync::sync_net`]; this app-side
//! app-side module hosts app-coupled tests (production lives in `agaric_sync::sync_net`);
//! hosts the app-coupled tests (`src/sync_net/tests.rs`, which reach into the
//! daemon / materializer glue that lives above `agaric-sync`).
//!
//! The submodules (`connection`, `tls`, `websocket`) are `pub mod` in the moved
//! crate so the test's `super::<submod>::…` paths resolve through the glob
//! re-export below. Production module imports the test reaches via `use super::*`
//! are re-declared under `#[cfg(test)]`.
#![cfg_attr(test, allow(unused_imports))]

#[cfg(test)]
use agaric_sync::sync_net::*;

#[cfg(test)]
use agaric_core::error::AppError;

#[cfg(test)]
mod tests;
