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
//! # Redirects disabled — the loopback guarantee holds at request time too
//!
//! The HTTP client is built HERE with redirects **disabled**
//! ([`reqwest::redirect::Policy::none`]). reqwest's default policy follows up to
//! 10 redirects, which would let a `3xx` from the (loopback-validated) collector
//! bounce the span batch to an OFF-host `Location` — a hole in the "never leaves
//! the machine" guarantee. With redirects off, a span batch is POSTed to the
//! validated loopback host and nowhere else; a redirecting collector simply
//! fails the export (degraded to the local file, which is always present).
//!
//! # Signal path appended explicitly
//!
//! The OTLP/HTTP spec puts traces at `<base>/v1/traces`. The SDK appends that
//! path automatically ONLY for the *environment-variable* endpoint; the
//! programmatic `with_endpoint(...)` used here is taken VERBATIM (see
//! `opentelemetry_otlp`'s `resolve_http_endpoint`). So [`traces_endpoint`]
//! appends `/v1/traces` to the validated base before handing it to the builder —
//! otherwise spans would POST to the collector root and a standard collector
//! would 404 them.
//!
//! # Additive, never replacing the file sink
//!
//! When built, the OTLP exporter is wired into the tracer provider as a SECOND
//! [`opentelemetry_sdk::trace::BatchSpanProcessor`] ALONGSIDE the local-file
//! exporter (see [`super::provider::build_tracer_provider`]). Spans fan out to
//! BOTH sinks; the file sink is never removed.
//!
//! # No async runtime (matches the existing thread-based posture)
//!
//! The exporter uses the `reqwest::blocking` HTTP client, so export runs
//! synchronously on the `BatchSpanProcessor`'s own background worker thread — no
//! tokio runtime, exactly like the file span/log batch processors and the
//! metrics `PeriodicReader`. A bounded [`EXPORT_TIMEOUT`] keeps a down collector
//! from stalling that worker indefinitely.
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
//! HTTP client or OTLP builder cannot be constructed — a misconfigured collector
//! then degrades to file-only export rather than panicking or taking down the
//! trace pipeline. Scope is TRACES ONLY for M8 (logs/metrics OTLP are a deferred
//! follow-up).

use std::time::Duration;

use opentelemetry_otlp::{Protocol, SpanExporter, WithExportConfig, WithHttpConfig};

/// OTLP/HTTP signal path for traces, appended to the validated base endpoint.
const TRACES_PATH: &str = "/v1/traces";

/// Bound on a single export round-trip so an unreachable collector cannot stall
/// the batch worker thread indefinitely (the export runs off the command hot
/// path, but an unbounded blocking POST could still wedge shutdown flushing).
const EXPORT_TIMEOUT: Duration = Duration::from_secs(10);

/// Append the OTLP `/v1/traces` signal path to an already-validated base URL.
///
/// Pure + testable. The validated endpoint is a base like `http://127.0.0.1:4318`
/// (or with a trailing slash from URL normalization); the OTLP/HTTP traces
/// receiver lives at `<base>/v1/traces`. If the caller already pointed at the
/// signal path, it is left as-is (idempotent) rather than doubled.
#[must_use]
fn traces_endpoint(base: &str) -> String {
    let trimmed = base.trim_end_matches('/');
    if trimmed.ends_with(TRACES_PATH) {
        trimmed.to_string()
    } else {
        format!("{trimmed}{TRACES_PATH}")
    }
}

/// Build the opt-in OTLP/HTTP span exporter for an already-validated loopback
/// `endpoint`, or `None` if the exporter cannot be constructed.
///
/// `endpoint` is the BASE collector URL (e.g. `http://127.0.0.1:4318`); this
/// function appends the `/v1/traces` signal path (see [`traces_endpoint`]) — the
/// programmatic `with_endpoint` path is NOT auto-suffixed by the SDK. The URL is
/// assumed to have already passed [`super::config::validate_loopback_endpoint`];
/// this function does not re-validate the host.
///
/// The HTTP client is built with **redirects disabled** and a bounded
/// [`EXPORT_TIMEOUT`], so a span batch can only ever reach the validated
/// loopback host (a `3xx` cannot bounce it off-machine) and a down collector
/// cannot stall the worker. Uses OTLP/HTTP with protobuf payloads
/// ([`Protocol::HttpBinary`]) over the blocking reqwest client — no async runtime.
///
/// Returns `None` (logging a `tracing::warn!`) when the client or builder errors,
/// so a misconfigured endpoint degrades to the always-present file-only export
/// instead of panicking. Never touches the network at build time, never panics.
#[must_use]
pub fn build_otlp_span_exporter(endpoint: &str) -> Option<SpanExporter> {
    // Build the HTTP client ourselves so we can DISABLE redirects: reqwest's
    // default follows up to 10, which would let a 3xx from the loopback collector
    // re-POST the span batch to an off-host `Location`. With `Policy::none` the
    // batch reaches the validated loopback host or fails — never elsewhere.
    let client = match reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(EXPORT_TIMEOUT)
        .build()
    {
        Ok(client) => client,
        Err(err) => {
            tracing::warn!(
                error = %err,
                "failed to build the OTLP HTTP client; falling back to local-file export only"
            );
            return None;
        }
    };

    match SpanExporter::builder()
        .with_http()
        .with_http_client(client)
        .with_endpoint(traces_endpoint(endpoint))
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

    /// The `/v1/traces` signal path is appended to a bare base (the common
    /// case), trailing slashes are normalized, and an endpoint already pointing
    /// at the signal path is left untouched (idempotent — no doubling).
    #[test]
    fn traces_endpoint_appends_signal_path() {
        assert_eq!(
            traces_endpoint("http://127.0.0.1:4318"),
            "http://127.0.0.1:4318/v1/traces"
        );
        // URL normalization can leave a trailing slash on a host-only base.
        assert_eq!(
            traces_endpoint("http://127.0.0.1:4318/"),
            "http://127.0.0.1:4318/v1/traces"
        );
        assert_eq!(
            traces_endpoint("http://[::1]:4318/"),
            "http://[::1]:4318/v1/traces"
        );
        // Idempotent: an endpoint already at the signal path is not doubled.
        assert_eq!(
            traces_endpoint("http://localhost:4318/v1/traces"),
            "http://localhost:4318/v1/traces"
        );
    }

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
