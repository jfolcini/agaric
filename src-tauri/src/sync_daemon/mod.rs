//! #2621 Sync-D: production moved to [`agaric_sync::sync_daemon`]; this app-side
//! shim re-exports it so every `crate::sync_daemon::…` path resolves unchanged,
//! and hosts the app-coupled tests (which reference app-only `Materializer` /
//! `recovery`).
//!
//! The hosted tests use `use super::*`, which — pre-move — pulled in the parent
//! production module's private imports. Cross-crate the glob re-export does not
//! carry those, so the relevant imports are re-declared under `#[cfg(test)]`.
//! `snapshot_transfer_tests` was an inline child of the `snapshot_transfer`
//! submodule, so it is hosted in a wrapper module that reconstructs *that*
//! module's namespace (`super` = the wrapper).
#![cfg_attr(test, allow(unused_imports))]

pub use agaric_sync::sync_daemon::*;

// `sync_daemon/tests.rs` (super = this module) reaches these through `use super::*`.
#[cfg(test)]
use crate::sync_events::{SyncEvent, SyncEventSink};
#[cfg(test)]
use std::sync::Arc;
#[cfg(test)]
use std::sync::atomic::AtomicBool;
#[cfg(test)]
use tokio::sync::Notify;

#[cfg(test)]
mod tests;

// Sync-C-prep lifted the app-coupled inline tests of `snapshot_transfer.rs` into
// this sibling. It was an inline child of `snapshot_transfer`, so it is hosted in
// a wrapper module (a real file) that reconstructs that module's namespace.
#[cfg(test)]
mod snapshot_transfer_tests_host;
