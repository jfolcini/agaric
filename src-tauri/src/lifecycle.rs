//! App-layer Tauri managed-state wrapper for the foreground hooks.
//!
//! The shared foreground/background gating primitive itself
//! ([`crate::foreground::LifecycleHooks`]) lives in the foundation-layer
//! [`crate::foreground`] module so the sync and materializer layers can
//! depend *down* on it. This module holds only the app-shell wiring: the
//! Tauri managed-state wrapper registered in `lib.rs`'s `setup()`.

use crate::foreground::LifecycleHooks;

/// Tauri managed-state wrapper for [`LifecycleHooks`].
///
/// Registered in `lib.rs`'s `setup()` so future commands (e.g. a "sync
/// now" handler) can inject the same shared flag/wake pair.
pub struct AppLifecycle(pub LifecycleHooks);
