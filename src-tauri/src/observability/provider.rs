//! Builds the OTel providers that drive the local pipelines.
//!
//! [`build_tracer_provider`] owns:
//! - a [`Resource`] tagging every span with `service.name = "agaric"` and
//!   `service.version = <crate version>` (no host/user/PII identifiers),
//! - a **`BatchSpanProcessor`** wrapping the file exporter, so span export
//!   happens on a background worker and never blocks the command hot path, and
//! - a `ParentBased(TraceIdRatioBased(ratio))` sampler driven by
//!   [`ObservabilityConfig::sampling_ratio`].
//!
//! [`build_logger_provider`] (M1b) owns the same resource + a
//! **`BatchLogProcessor`** wrapping the file log exporter; the OTel logs bridge
//! feeds it `tracing` events as span-correlated `LogRecord`s.
//!
//! Both providers are returned *owned* so the [`crate::observability::guard`]
//! can flush + shut them down on app exit; a tracer is obtained from the tracer
//! provider for the tracing layer.

use opentelemetry::trace::TracerProvider as _;
use opentelemetry_sdk::Resource;
use opentelemetry_sdk::logs::{LogExporter, SdkLoggerProvider};
use opentelemetry_sdk::trace::{Sampler, SdkTracer, SdkTracerProvider, SpanExporter};

use super::config::ObservabilityConfig;

/// Logical service name stamped on every span's resource.
const SERVICE_NAME: &str = "agaric";

/// Instrumentation-scope name for the tracer this provider hands out.
const TRACER_SCOPE: &str = "agaric";

/// The OTel [`Resource`] shared by the trace and logs providers.
///
/// Tags every span and log record with `service.name = "agaric"` +
/// `service.version = <crate version>` and nothing else — no host name, user,
/// or other PII identifier. Built identically for both signals so a span and
/// its correlated logs agree on the resource.
fn resource() -> Resource {
    Resource::builder()
        .with_service_name(SERVICE_NAME)
        .with_attribute(opentelemetry::KeyValue::new(
            "service.version",
            env!("CARGO_PKG_VERSION"),
        ))
        .build()
}

/// Build an `SdkTracerProvider` from `config` and an owned `exporter`.
///
/// Uses `with_batch_exporter` (the default dedicated-worker
/// `BatchSpanProcessor`) to decouple export from the hot path, sets the
/// resource attributes, and installs a parent-based ratio sampler. The
/// exporter is generic over `SpanExporter` so the file exporter (or any future
/// swap) drops in unchanged.
pub fn build_tracer_provider<E>(config: &ObservabilityConfig, exporter: E) -> SdkTracerProvider
where
    E: SpanExporter + 'static,
{
    // ParentBased: honour an upstream sampling decision when a parent span
    // exists; for root spans, fall back to the trace-id ratio sampler. This is
    // the standard "sample whole traces consistently" configuration.
    let sampler = Sampler::ParentBased(Box::new(Sampler::TraceIdRatioBased(config.sampling_ratio)));

    SdkTracerProvider::builder()
        .with_resource(resource())
        .with_sampler(sampler)
        .with_batch_exporter(exporter)
        .build()
}

/// Build an `SdkLoggerProvider` from an owned log `exporter` (M1b).
///
/// Uses `with_batch_exporter` (the dedicated-worker `BatchLogProcessor`) so log
/// export happens off the hot path, with the same [`resource`] as the tracer
/// provider. There is no sampler on the logs side — every event that passes the
/// subscriber's `EnvFilter` is recorded; correlation with the active span is
/// supplied by the SDK logger from the current OTel context, which the
/// `tracing-opentelemetry` layer activates on span enter.
pub fn build_logger_provider<E>(exporter: E) -> SdkLoggerProvider
where
    E: LogExporter + 'static,
{
    SdkLoggerProvider::builder()
        .with_resource(resource())
        .with_batch_exporter(exporter)
        .build()
}

/// Obtain the tracer used by the `tracing-opentelemetry` layer.
///
/// Kept as a tiny helper so the scope name is defined in exactly one place and
/// the layer module never reaches for a string literal.
pub fn tracer(provider: &SdkTracerProvider) -> SdkTracer {
    provider.tracer(TRACER_SCOPE)
}
