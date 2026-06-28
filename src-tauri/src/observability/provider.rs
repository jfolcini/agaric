//! Builds the `SdkTracerProvider` that drives the trace pipeline.
//!
//! The provider owns:
//! - a [`Resource`] tagging every span with `service.name = "agaric"` and
//!   `service.version = <crate version>` (no host/user/PII identifiers),
//! - a **`BatchSpanProcessor`** wrapping the file exporter, so span export
//!   happens on a background worker and never blocks the command hot path, and
//! - a `ParentBased(TraceIdRatioBased(ratio))` sampler driven by
//!   [`ObservabilityConfig::sampling_ratio`].
//!
//! The provider is returned *owned* so the [`crate::observability::guard`] can
//! flush + shut it down on app exit; a tracer is obtained from it for the
//! tracing layer.

use opentelemetry::trace::TracerProvider as _;
use opentelemetry_sdk::Resource;
use opentelemetry_sdk::trace::{Sampler, SdkTracer, SdkTracerProvider, SpanExporter};

use super::config::ObservabilityConfig;

/// Logical service name stamped on every span's resource.
const SERVICE_NAME: &str = "agaric";

/// Instrumentation-scope name for the tracer this provider hands out.
const TRACER_SCOPE: &str = "agaric";

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
    let resource = Resource::builder()
        .with_service_name(SERVICE_NAME)
        .with_attribute(opentelemetry::KeyValue::new(
            "service.version",
            env!("CARGO_PKG_VERSION"),
        ))
        .build();

    // ParentBased: honour an upstream sampling decision when a parent span
    // exists; for root spans, fall back to the trace-id ratio sampler. This is
    // the standard "sample whole traces consistently" configuration.
    let sampler = Sampler::ParentBased(Box::new(Sampler::TraceIdRatioBased(config.sampling_ratio)));

    SdkTracerProvider::builder()
        .with_resource(resource)
        .with_sampler(sampler)
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
