//! Lifetime guard that flushes + shuts down the OTel pipelines on app exit.
//!
//! Mirrors `LogGuard` in `lib.rs`: the guard is stored in Tauri's managed
//! state so it lives for the whole app lifetime, and its `Drop` impl runs at
//! exit. Dropping it force-flushes any spans/log records still buffered in the
//! batch processors and then shuts the providers down, so neither traces nor
//! logs are lost when the process terminates.

use opentelemetry_sdk::logs::SdkLoggerProvider;
use opentelemetry_sdk::trace::SdkTracerProvider;

/// Owns the OTel providers for the app's lifetime and flushes them on drop.
///
/// Placed in Tauri managed state next to `LogGuard`. The tracer provider is
/// otherwise only referenced (by the trace layer's tracer) and the logger
/// provider only by the bridge layer's logger, so this guard is the single
/// owner responsible for an orderly shutdown of both.
///
/// `logger_provider` is `Option` because the logs signal (M1b) degrades
/// independently of traces: if its `otel-logs/` sink cannot be opened, traces
/// still run and this is `None`.
pub struct ObservabilityGuard {
    tracer_provider: SdkTracerProvider,
    logger_provider: Option<SdkLoggerProvider>,
}

impl ObservabilityGuard {
    /// Wrap the owned providers so they are flushed + shut down on drop.
    #[must_use]
    pub fn new(
        tracer_provider: SdkTracerProvider,
        logger_provider: Option<SdkLoggerProvider>,
    ) -> Self {
        Self {
            tracer_provider,
            logger_provider,
        }
    }
}

impl Drop for ObservabilityGuard {
    fn drop(&mut self) {
        // Force-flush first so buffered spans/records reach the file exporters,
        // then shut the providers down. Both calls return a Result; failures at
        // exit are non-actionable (we are tearing down) but worth a debug line
        // for diagnosis. Never panic in Drop.
        if let Err(e) = self.tracer_provider.force_flush() {
            tracing::debug!(error = %e, "observability: tracer force_flush on shutdown failed");
        }
        if let Err(e) = self.tracer_provider.shutdown() {
            tracing::debug!(error = %e, "observability: tracer provider shutdown failed");
        }
        if let Some(logger_provider) = &self.logger_provider {
            if let Err(e) = logger_provider.force_flush() {
                tracing::debug!(error = %e, "observability: logger force_flush on shutdown failed");
            }
            if let Err(e) = logger_provider.shutdown() {
                tracing::debug!(error = %e, "observability: logger provider shutdown failed");
            }
        }
    }
}
