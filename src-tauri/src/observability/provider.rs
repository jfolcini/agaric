//! Builds the OTel providers that drive the local pipelines.
//!
//! [`build_tracer_provider`] owns:
//! - a [`Resource`] tagging every span with `service.name = "agaric"` and
//!   `service.version = <crate version>` (no host/user/PII identifiers),
//! - a **`BatchSpanProcessor`** wrapping the file exporter, so span export
//!   happens on a background worker and never blocks the command hot path,
//! - OPTIONALLY (M8), when `config.endpoint` is `Some` — i.e. the user opted in
//!   via a loopback `AGARIC_OTEL_ENDPOINT` — a SECOND `BatchSpanProcessor`
//!   wrapping the opt-in OTLP/HTTP exporter (see [`super::otlp`]). Spans then
//!   fan out to BOTH the local file and the loopback collector; the file sink
//!   is never replaced. If the OTLP exporter fails to build, the provider runs
//!   file-only, and
//! - a `ParentBased(TraceIdRatioBased(ratio))` sampler driven by
//!   [`ObservabilityConfig::sampling_ratio`], shared by both processors.
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
use opentelemetry_sdk::trace::{SdkTracer, SdkTracerProvider, SpanExporter};

use super::config::ObservabilityConfig;
use super::sampling::{RuntimeSampler, set_sampling_ratio};

/// Logical service name stamped on every span's resource.
const SERVICE_NAME: &str = "agaric";

/// Instrumentation-scope name for the tracer this provider hands out.
const TRACER_SCOPE: &str = "agaric";

/// The OTel [`Resource`] shared by the trace, logs, and metrics providers.
///
/// Tags every span, log record, and metric with `service.name = "agaric"` +
/// `service.version = <crate version>` and nothing else — no host name, user,
/// or other PII identifier. Built identically for all signals so a span, its
/// correlated logs, and the metrics emitted in the same run agree on the
/// resource. `pub(super)` so the M6 metrics provider
/// ([`super::metrics::build_meter_provider`]) reuses the *exact* same resource
/// rather than duplicating it.
pub(super) fn resource() -> Resource {
    Resource::builder()
        .with_service_name(SERVICE_NAME)
        .with_attribute(opentelemetry::KeyValue::new(
            "service.version",
            env!("CARGO_PKG_VERSION"),
        ))
        .build()
}

/// Build an `SdkTracerProvider` from `config` and an owned file `exporter`.
///
/// Uses `with_batch_exporter` (the default dedicated-worker
/// `BatchSpanProcessor`) to decouple export from the hot path, sets the
/// resource attributes, and installs a parent-based ratio sampler. The file
/// `exporter` is generic over `SpanExporter` so the file exporter (or any
/// future swap) drops in unchanged.
///
/// M8 — when `config.endpoint` is `Some(ep)` (the user opted into the
/// loopback-validated OTLP collector), a SECOND `BatchSpanProcessor` wrapping
/// the opt-in OTLP exporter is added so spans fan out to BOTH sinks. The OTLP
/// exporter is built via [`super::otlp::build_otlp_span_exporter`]; if it
/// returns `None` (build error), the provider proceeds file-only — the
/// always-present local sink is never dropped. Both processors share the one
/// `RuntimeSampler` + resource above, so the OTLP collector sees exactly the
/// same sampled spans (and resource attributes) as the file.
pub fn build_tracer_provider<E>(config: &ObservabilityConfig, exporter: E) -> SdkTracerProvider
where
    E: SpanExporter + 'static,
{
    // #2110 M5 — seed the process-global runtime ratio from config, then install
    // the runtime-adjustable `ParentBased(TraceIdRatioBased(ratio))` sampler.
    // Identical sampling semantics to the previous fixed sampler, except the
    // ratio is read live on each root decision so the `set_trace_sampling`
    // command can toggle full-tracing ↔ sampling without a provider rebuild.
    set_sampling_ratio(config.sampling_ratio);

    let mut builder = SdkTracerProvider::builder()
        .with_resource(resource())
        .with_sampler(RuntimeSampler)
        // The local-file exporter is ALWAYS present — the default, never-replaced
        // zero-egress sink.
        .with_batch_exporter(exporter);

    // M8 — additive, opt-in loopback OTLP egress. `config.endpoint` is `Some`
    // only when the user set a loopback-validated `AGARIC_OTEL_ENDPOINT`
    // (see `config::validate_loopback_endpoint`). A failed build leaves the
    // provider file-only.
    if let Some(endpoint) = config.endpoint.as_deref()
        && let Some(otlp_exporter) = super::otlp::build_otlp_span_exporter(endpoint)
    {
        builder = builder.with_batch_exporter(otlp_exporter);
    }

    builder.build()
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
