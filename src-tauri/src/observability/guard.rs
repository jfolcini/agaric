//! Lifetime guard that flushes + shuts down the trace pipeline on app exit.
//!
//! Mirrors `LogGuard` in `lib.rs`: the guard is stored in Tauri's managed
//! state so it lives for the whole app lifetime, and its `Drop` impl runs at
//! exit. Dropping it force-flushes any spans still buffered in the
//! `BatchSpanProcessor` and then shuts the provider down, so traces are not
//! lost when the process terminates.

use opentelemetry_sdk::trace::SdkTracerProvider;

/// Owns the `SdkTracerProvider` for the app's lifetime and flushes it on drop.
///
/// Placed in Tauri managed state next to `LogGuard`. The provider is otherwise
/// only referenced (by the trace layer's tracer), so this guard is the single
/// owner responsible for an orderly shutdown.
pub struct ObservabilityGuard {
    provider: SdkTracerProvider,
}

impl ObservabilityGuard {
    /// Wrap an owned provider so it is flushed + shut down on drop.
    #[must_use]
    pub fn new(provider: SdkTracerProvider) -> Self {
        Self { provider }
    }
}

impl Drop for ObservabilityGuard {
    fn drop(&mut self) {
        // Force-flush first so spans buffered in the batch processor reach the
        // file exporter, then shut the provider down. Both return a Result;
        // failures at exit are non-actionable (we are tearing down) but worth
        // a debug line for diagnosis. Never panic in Drop.
        if let Err(e) = self.provider.force_flush() {
            tracing::debug!(error = %e, "observability: force_flush on shutdown failed");
        }
        if let Err(e) = self.provider.shutdown() {
            tracing::debug!(error = %e, "observability: provider shutdown failed");
        }
    }
}
