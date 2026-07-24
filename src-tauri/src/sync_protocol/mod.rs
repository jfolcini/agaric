//! #2621 Sync-D: production moved to [`agaric_sync::sync_protocol`]; this
//! app-side module hosts the app-coupled tests (which reference app-only
//! `Materializer` / `recovery`); production lives in `agaric_sync::sync_protocol`.
//!
//! `loro_sync_tests.rs` was an inline child of the `loro_sync` submodule, so its
//! `use super::*` reached `loro_sync`'s namespace; it is hosted in a wrapper that
//! reconstructs that namespace (`super` = the wrapper). The `../` in the path
//! escapes the inline-module directory back to `src/sync_protocol/`.
#![cfg_attr(test, allow(unused_imports))]

#[cfg(test)]
use agaric_sync::sync_protocol::*;

#[cfg(test)]
mod tests;

// `loro_sync_tests.rs` was an inline child of `loro_sync`; it is hosted in a
// wrapper module (a real file) that reconstructs that module's namespace.
#[cfg(test)]
mod loro_sync_tests_host;
