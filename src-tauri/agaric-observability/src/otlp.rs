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
//! # Redirects disabled AND the system proxy ignored — the loopback guarantee
//! holds at request time too
//!
//! Validating the endpoint string is not enough: two request-time mechanisms can
//! send the bytes somewhere other than the host in the URL, and BOTH are on by
//! default in reqwest. The client is therefore built HERE (never with
//! `Client::new()` / the SDK's default) with both disabled — see
//! [`build_export_http_client`]:
//!
//! 1. **Redirects** ([`reqwest::redirect::Policy::none`]). reqwest's default
//!    policy follows up to 10 redirects, which would let a `3xx` from the
//!    (loopback-validated) collector bounce the span batch to an OFF-host
//!    `Location`.
//! 2. **The system proxy** (`.no_proxy()`, #3317). `ClientConfig::auto_sys_proxy`
//!    defaults to `true`, so `build()` installs a matcher over `HTTP_PROXY` /
//!    `http_proxy` / `ALL_PROXY` unless `.no_proxy()` or an explicit `.proxy()`
//!    clears it — and hyper-util's matcher has **no** automatic loopback
//!    exemption, so `127.0.0.1` is proxied like any other host unless it appears
//!    in `NO_PROXY`. On a corporate or containerised machine with `HTTP_PROXY`
//!    exported (routine, and inherited by any GUI app launched from a shell),
//!    every span batch would have gone to that proxy — an off-host third party —
//!    while the loopback validation logged nothing adverse.
//!
//! With both off, a span batch reaches the validated loopback host or fails; it
//! never reaches anywhere else. A redirecting or unreachable collector simply
//! fails the export and degrades to the local file, which is always present.
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
//! # PII discipline — what this actually carries (#3317)
//!
//! This exporter adds nothing to a span; it serializes the same `SpanData` the
//! file exporter receives. But "the same as the file" is NOT "opaque ids only",
//! and an earlier version of this doc claimed it was. Two corrections:
//!
//! - Span **attributes** are whatever the `#[instrument(... fields(...))]` site
//!   attached. That is a convention, not a mechanism — `import_markdown_-`
//!   `with_progress` really did record the user's page title into `page_title`
//!   until #3317 removed it, and the crate-level leak-guard test never saw it
//!   because that test only inspects a span it constructs itself.
//! - Span **events** carry MORE than the file does. `tracing-opentelemetry`
//!   turns every `tracing` event fired inside an instrumented span into an OTel
//!   span event whose attributes are the event's fields verbatim, and `err` on
//!   `#[instrument]` emits one carrying the error's `Display`. The file
//!   [`super::exporter::format_span`] does not serialize events, so this
//!   OTLP payload is a strict superset of the trace file — free-text log fields
//!   (`tracing::info!(page = %page_title, …)`) and error strings ride along.
//!
//! The guarantee this module owns is therefore CONTAINMENT, not redaction: the
//! payload may contain user content, and the loopback validation + no-redirect +
//! no-proxy client above are what keep it on the user's own machine. The
//! separate egress boundary — the bug-report bundle — redacts deny-by-default in
//! `commands::bug_report`.
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

/// Build the blocking HTTP client the OTLP exporter posts span batches with.
///
/// The two non-default settings are the whole loopback guarantee at request
/// time, and both must stay: `Policy::none` stops a `3xx` from bouncing a batch
/// off-host, and `.no_proxy()` stops an ambient `HTTP_PROXY` / `http_proxy` /
/// `ALL_PROXY` from routing a `127.0.0.1` POST through an off-machine proxy
/// (reqwest installs the system-proxy matcher by default and hyper-util's
/// matcher exempts only hosts named in `NO_PROXY` — loopback is NOT exempt).
/// There is no legitimate reason to proxy a POST to the user's own loopback
/// collector, so the decision is made here rather than left to the environment.
///
/// Split out of [`build_otlp_span_exporter`] so the egress guard test can build
/// the production client and prove it against a fake proxy (#3317).
fn build_export_http_client() -> reqwest::Result<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .timeout(EXPORT_TIMEOUT)
        .build()
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
/// The HTTP client comes from [`build_export_http_client`]: **redirects
/// disabled**, the **system proxy ignored**, and a bounded [`EXPORT_TIMEOUT`],
/// so a span batch can only ever reach the validated loopback host (neither a
/// `3xx` nor an ambient `HTTP_PROXY` can take it off-machine) and a down
/// collector cannot stall the worker. Uses OTLP/HTTP with protobuf payloads
/// ([`Protocol::HttpBinary`]) over the blocking reqwest client — no async runtime.
///
/// Returns `None` (logging a `tracing::warn!`) when the client or builder errors,
/// so a misconfigured endpoint degrades to the always-present file-only export
/// instead of panicking. Never touches the network at build time, never panics.
#[must_use]
pub fn build_otlp_span_exporter(endpoint: &str) -> Option<SpanExporter> {
    // Build the HTTP client ourselves so we can disable BOTH request-time
    // escapes from the validated host — redirects and the system proxy. See
    // `build_export_http_client`.
    let client = match build_export_http_client() {
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

    /// Minimal HTTP stub on an ephemeral loopback port.
    ///
    /// Returns its base URL and a receiver that yields one item per accepted
    /// connection — the observation channel the egress guard below asserts on.
    /// Every connection is answered `200` so a client that reaches the stub
    /// completes promptly instead of sitting on [`EXPORT_TIMEOUT`].
    fn spawn_http_stub() -> (String, std::sync::mpsc::Receiver<()>) {
        use std::io::{Read as _, Write as _};

        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind stub listener");
        let addr = listener.local_addr().expect("stub local_addr");
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                // Signal BEFORE answering: the guard cares that a connection
                // arrived at all, not that the exchange completed.
                if tx.send(()).is_err() {
                    return;
                }
                let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
                let mut buf = [0_u8; 4096];
                let _ = stream.read(&mut buf);
                let _ = stream.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n");
                let _ = stream.flush();
            }
        });
        (format!("http://{addr}"), rx)
    }

    /// #3317 egress guard: an ambient system proxy must not intercept the span
    /// batch a loopback-validated endpoint accepted.
    ///
    /// Structure mirrors the sync transport's DNS guards: a NEGATIVE CONTROL
    /// proves the fake proxy is observable in this process first (a client
    /// built exactly like production but WITHOUT `.no_proxy()` does get routed
    /// there), and only then does the guard assert that the real
    /// [`build_export_http_client`] does not. Without the control, deleting
    /// `.no_proxy()` and breaking the stub would both look like a pass.
    ///
    /// Deleting `.no_proxy()` from `build_export_http_client` turns the guard
    /// assertion red.
    ///
    /// Mutates process env, so it relies on nextest's per-test process
    /// isolation; no other test in this crate issues an HTTP request.
    #[test]
    #[allow(unsafe_code)] // `std::env::set_var` is `unsafe` on edition 2024.
    fn export_client_never_uses_the_system_proxy() {
        let (proxy_url, proxy_hits) = spawn_http_stub();
        let (collector_url, collector_hits) = spawn_http_stub();
        let traces_url = traces_endpoint(&collector_url);

        // Point every proxy variable hyper-util consults at the stub, and clear
        // any ambient NO_PROXY bypass (the nextest setup script sets a wildcard
        // one for the sync guards) so the control below cannot pass vacuously.
        // SAFETY: single-threaded test setup, before any client is built; the
        // spawned stub threads never read the environment.
        unsafe {
            std::env::set_var("HTTP_PROXY", &proxy_url);
            std::env::set_var("http_proxy", &proxy_url);
            std::env::set_var("ALL_PROXY", &proxy_url);
            std::env::set_var("all_proxy", &proxy_url);
            std::env::remove_var("NO_PROXY");
            std::env::remove_var("no_proxy");
        }

        // -- Negative control: the same builder MINUS `.no_proxy()` ----------
        let unguarded = reqwest::blocking::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(5))
            .build()
            .expect("control client builds");
        let _ = unguarded.post(&traces_url).body("control").send();
        assert!(
            proxy_hits.recv_timeout(Duration::from_secs(5)).is_ok(),
            "NEGATIVE CONTROL FAILED: a client without `.no_proxy()` did not reach the \
             fake proxy, so the guard below is not observable and must not pass. Either \
             reqwest stopped honouring HTTP_PROXY/ALL_PROXY by default or the stub is \
             not accepting connections."
        );

        // -- Guard: the production client must go straight to loopback -------
        let guarded = build_export_http_client().expect("export client builds");
        let response = guarded.post(&traces_url).body("guarded").send();
        assert!(
            proxy_hits.recv_timeout(Duration::from_secs(2)).is_err(),
            "OTLP span batch was routed through the system proxy — a loopback-validated \
             endpoint must never egress off-box (#3317). Restore `.no_proxy()` in \
             `build_export_http_client`."
        );
        assert!(
            response.is_ok(),
            "the guarded client must reach the loopback collector directly: {response:?}"
        );
        assert!(
            collector_hits.recv_timeout(Duration::from_secs(5)).is_ok(),
            "the guarded request never arrived at the loopback collector"
        );
    }
}
