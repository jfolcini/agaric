//! Lifetime guard that flushes + shuts down the OTel pipelines on app exit.
//!
//! Mirrors `LogGuard` in `lib.rs`: the guard is stored in Tauri's managed
//! state so it lives for the whole app lifetime, and its `Drop` impl runs at
//! exit. Dropping it force-flushes any spans/log records still buffered in the
//! batch processors plus the latest metrics in the periodic reader, and then
//! shuts the providers down, so no traces, logs, or metrics are lost when the
//! process terminates.

use opentelemetry_sdk::logs::SdkLoggerProvider;
use opentelemetry_sdk::metrics::SdkMeterProvider;
use opentelemetry_sdk::trace::SdkTracerProvider;

/// Owns the OTel providers for the app's lifetime and flushes them on drop.
///
/// Placed in Tauri managed state next to `LogGuard`. The tracer provider is
/// otherwise only referenced (by the trace layer's tracer), the logger provider
/// only by the bridge layer's logger, and the meter provider only by the global
/// meter provider + the registered observable-counter callbacks — so this guard
/// is the single owner responsible for an orderly shutdown of all three.
///
/// `logger_provider` and `meter_provider` are `Option` because the logs (M1b)
/// and metrics (M6) signals degrade independently of traces: if a signal's sink
/// (`otel-logs/` / `metrics/`) cannot be opened, traces still run and that field
/// is `None`.
pub struct ObservabilityGuard {
    tracer_provider: SdkTracerProvider,
    logger_provider: Option<SdkLoggerProvider>,
    meter_provider: Option<SdkMeterProvider>,
}

impl ObservabilityGuard {
    /// Wrap the owned providers so they are flushed + shut down on drop.
    #[must_use]
    pub fn new(
        tracer_provider: SdkTracerProvider,
        logger_provider: Option<SdkLoggerProvider>,
        meter_provider: Option<SdkMeterProvider>,
    ) -> Self {
        Self {
            tracer_provider,
            logger_provider,
            meter_provider,
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
        // M6 — flush the periodic reader's latest metrics + shut the meter
        // provider down last (after the tracer/logger), so a final collection
        // cycle writes the closing counter/histogram lines to `metrics/`.
        if let Some(meter_provider) = &self.meter_provider {
            if let Err(e) = meter_provider.force_flush() {
                tracing::debug!(error = %e, "observability: meter force_flush on shutdown failed");
            }
            if let Err(e) = meter_provider.shutdown() {
                tracing::debug!(error = %e, "observability: meter provider shutdown failed");
            }
        }
    }
}
