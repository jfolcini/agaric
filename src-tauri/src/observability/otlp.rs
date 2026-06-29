//! Opt-in, loopback-only OTLP/HTTP span exporter (#2110, #2121, M8) — the ONLY
//! network-egress path in this crate.
//!
//! # Off by default, loopback-validated upstream (hard invariant)
//!
//! Every OTHER exporter in this module (spans, logs, metrics) writes to a LOCAL
//! FILE and never touches the network. This module is the single exception: it
//! builds an OTLP/HTTP + protobuf exporter that sends spans to a user-run
//! collector — but ONLY when the user has explicitly opted in by setting
//! `AGARIC_OTEL_ENDPOINT`, and ONLY to a loopback address.
//!
//! The loopback guarantee is enforced UPSTREAM, in
//! [`super::config::validate_loopback_endpoint`], at config-parse time: a
//! non-loopback / malformed value never reaches this module — it resolves to
//! `None` and the file-only path runs. By the time [`build_otlp_span_exporter`]
//! is called, `endpoint` is an already-validated `http`/`https` URL on
//! `127.0.0.0/8`, `::1`, or `localhost`. This module re-states that contract in
//! its doc but does not re-parse the host: the single source of truth for "what
//! counts as loopback" is the config validator, which is exhaustively tested.
//!
//! # Additive, never replacing the file sink
//!
//! When built, the OTLP exporter is wired into the tracer provider as a SECOND
//! [`opentelemetry_sdk::trace::BatchSpanProcessor`] ALONGSIDE the local-file
//! exporter (see [`super::provider::build_tracer_provider`]). Spans fan out to
//! BOTH sinks; the file sink is never removed. So even with OTLP enabled, the
//! "nothing leaves your machine without you running the collector locally"
//! property holds and the on-disk record is unchanged.
//!
//! # No async runtime (matches the existing thread-based posture)
//!
//! The exporter is built with the `reqwest-blocking-client` HTTP transport, so
//! export runs synchronously on the `BatchSpanProcessor`'s own background worker
//! thread — no tokio runtime, exactly like the file span/log batch processors
//! and the metrics `PeriodicReader` (`rt-tokio` is deliberately not enabled; see
//! the `opentelemetry-otlp` note in `Cargo.toml`).
//!
//! # PII discipline
//!
//! This exporter serializes the SAME spans the file exporter already receives —
//! opaque ids (ULIDs), enums/op-types, counts, durations, and booleans only. It
//! adds nothing to spans. PII is kept out at the `#[instrument]` sites
//! (enforced by the leak-guard test in [`super`]), never here.
//!
//! # Graceful degradation
//!
//! [`build_otlp_span_exporter`] returns `None` (after a `tracing::warn!`) if the
//! OTLP builder errors — a misconfigured collector then degrades to file-only
//! export rather than panicking or taking down the trace pipeline. Scope is
//! TRACES ONLY for M8 (logs/metrics OTLP are a deferred follow-up).

use opentelemetry_otlp::{Protocol, SpanExporter, WithExportConfig};

/// Build the opt-in OTLP/HTTP span exporter for an already-validated loopback
/// `endpoint`, or `None` if the exporter cannot be constructed.
///
/// `endpoint` is the BASE collector URL (e.g. `http://127.0.0.1:4318`); the
/// OTLP/HTTP exporter appends the `/v1/traces` signal path itself, so callers
/// pass the base, NOT the full traces URL. The URL is assumed to have already
/// passed [`super::config::validate_loopback_endpoint`] — this function does not
/// re-validate the host (the config validator is the single source of truth for
/// the loopback rule).
///
/// Uses OTLP/HTTP with protobuf payloads ([`Protocol::HttpBinary`]) over the
/// blocking reqwest client, so export runs on the `BatchSpanProcessor` worker
/// thread with no async runtime.
///
/// Returns `None` (logging a `tracing::warn!`) when the builder errors, so a
/// misconfigured endpoint degrades to the always-present file-only export
/// instead of panicking. Never touches the network at build time and never
/// panics.
#[must_use]
pub fn build_otlp_span_exporter(endpoint: &str) -> Option<SpanExporter> {
    match SpanExporter::builder()
        .with_http()
        .with_endpoint(endpoint)
        .with_protocol(Protocol::HttpBinary)
        .build()
    {
        Ok(exporter) => Some(exporter),
        Err(err) => {
            // Degrade to file-only rather than failing the trace pipeline. The
            // endpoint is loopback-validated upstream, so this only fires on a
            // genuine builder/transport construction error (not a rejected
            // host); log it once so a misconfigured collector is diagnosable.
            tracing::warn!(
                endpoint = %endpoint,
                error = %err,
                "failed to build the opt-in OTLP span exporter; falling back to \
                 local-file export only"
            );
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A loopback endpoint builds an exporter (the common opt-in case). This
    /// exercises only construction — no span is exported and no network I/O
    /// happens until the batch processor's worker thread flushes.
    #[test]
    fn builds_exporter_for_loopback_endpoint() {
        let exporter = build_otlp_span_exporter("http://127.0.0.1:4318");
        assert!(
            exporter.is_some(),
            "a valid loopback endpoint must build an OTLP exporter"
        );
    }
}
