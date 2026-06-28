//! The `tracing` → OpenTelemetry bridge layer.
//!
//! [`build_trace_layer`] returns a boxed `tracing_subscriber` `Layer` that
//! forwards `tracing` spans into the OTel `SdkTracerProvider` built in
//! [`crate::observability::provider`]. It is added to the existing registry
//! chain in `init_logging` alongside the stderr and JSON-file layers.
//!
//! # Filtering (M1a behaviour)
//!
//! This layer carries no per-layer filter, so it inherits the registry's
//! global `EnvFilter` (the same `RUST_LOG` / `agaric=info` filter the log
//! layers use). Consequently a span is exported to OTel exactly when it would
//! be logged. Because the default filter is `agaric=info`, the instrumented
//! commands are annotated at `level = "info"` so they pass it.
//!
//! Future refinement (not M1a): attach a dedicated per-layer filter here
//! (`.with_filter(...)`) so OTel can capture sub-`info` spans independently of
//! what is logged to stderr/file — useful for deep tracing without flooding
//! the human-readable logs.

use opentelemetry_appender_tracing::layer::OpenTelemetryTracingBridge;
use opentelemetry_sdk::logs::SdkLoggerProvider;
use opentelemetry_sdk::trace::SdkTracerProvider;
use tracing_subscriber::Layer;
use tracing_subscriber::registry::Registry;

use super::provider::tracer;

/// Build the boxed OpenTelemetry trace layer for the global registry.
///
/// `provider` is borrowed only to mint a tracer; the caller retains ownership
/// so the shutdown guard can flush it on exit.
///
/// The layer keeps `tracing-opentelemetry`'s default `context_activation`,
/// which attaches each span's OTel context as *current* on enter. That is what
/// lets the M1b logs bridge ([`build_logs_layer`]) correlate a `tracing` event
/// to the span it fired inside: the SDK logger reads the active span from the
/// current OTel context, which this layer — not the bridge — populates.
pub fn build_trace_layer(provider: &SdkTracerProvider) -> Box<dyn Layer<Registry> + Send + Sync> {
    tracing_opentelemetry::layer()
        .with_tracer(tracer(provider))
        .boxed()
}

/// Build the boxed OpenTelemetry **logs** bridge layer for the global registry
/// (M1b).
///
/// `OpenTelemetryTracingBridge` turns each `tracing` event that passes the
/// registry's `EnvFilter` into an OTel `LogRecord` emitted through `provider`.
/// It deliberately carries no per-layer filter, so it inherits the same global
/// filter the trace + file-log layers use — an event is bridged exactly when it
/// would be logged. Trace correlation is automatic (see [`build_trace_layer`]).
pub fn build_logs_layer(provider: &SdkLoggerProvider) -> Box<dyn Layer<Registry> + Send + Sync> {
    OpenTelemetryTracingBridge::new(provider).boxed()
}
