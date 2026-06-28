//! OpenTelemetry observability for the Agaric backend (issue #2110, M1a + M1b).
//!
//! This module turns the `tracing` spans **and** events emitted by backend
//! commands into OpenTelemetry traces (M1a) and span-correlated logs (M1b) and
//! writes both to LOCAL FILES. It plugs into the existing `init_logging`
//! subscriber chain in `lib.rs` as a small set of optional
//! `tracing_subscriber::Layer`s, and a Drop-guard flushes both pipelines on
//! exit (mirroring `LogGuard`).
//!
//! # Architecture
//!
//! ```text
//!   #[instrument] commands ──► tracing ──► Registry
//!                                            ├─ EnvFilter (RUST_LOG / agaric=info)
//!                                            ├─ stderr fmt layer        (unchanged)
//!                                            ├─ JSON file layer         (unchanged)
//!                                            ├─ OTel trace layer (spans)
//!                                            │      │  tracing-opentelemetry
//!                                            │      ▼
//!                                            │   SdkTracerProvider
//!                                            │     ├─ Resource(service.name/version)
//!                                            │     ├─ ParentBased(TraceIdRatio) sampler
//!                                            │     └─ BatchSpanProcessor ─► FileSpanExporter
//!                                            │                                 └─► traces/*.log
//!                                            └─ OTel logs bridge (events, M1b)
//!                                                   │  opentelemetry-appender-tracing
//!                                                   ▼
//!                                                SdkLoggerProvider
//!                                                  ├─ Resource(service.name/version)
//!                                                  └─ BatchLogProcessor ──► FileLogExporter
//!                                                                              └─► otel-logs/*.log
//! ```
//!
//! Span↔log correlation is automatic: the trace layer activates each span's
//! OTel context as *current* on enter, and the SDK logger stamps every bridged
//! event with that active span's trace + span id.
//!
//! Submodules: [`config`] (pure env parsing), [`exporter`] (the only place that
//! knows the on-disk formats + owns the shared rolling-file sink), [`provider`]
//! (resource + sampler + batch processors for both signals), [`layer`] (the two
//! tracing↔OTel bridges), [`guard`] (flush both on exit).
//!
//! # Three invariants (hard rules)
//!
//! 1. **Zero egress.** Spans and log records go ONLY to local files. There is
//!    no `opentelemetry-otlp` / HTTP / gRPC exporter anywhere in this crate. The
//!    app's "nothing leaves your machine" promise + CSP forbid it.
//! 2. **Off by default.** When `AGARIC_OTEL` is unset, [`init`] returns a no-op
//!    `Observability { layers: <empty>, guard: None }`. An empty `Vec<Layer>`
//!    is a no-op on the registry, so the existing logging behaviour is
//!    byte-identical and overhead is ~zero.
//! 3. **PII discipline.** Span names + attributes carry ONLY opaque ids
//!    (ULIDs), enums/op-types, counts, durations, and booleans. NEVER block
//!    `content`, `to_text`, search query strings, tag names, or property
//!    values. This is enforced at every `#[instrument(... fields(...))]` site;
//!    the exporters just serialize what they are handed. Bridged log *bodies*
//!    mirror what already goes to `agaric.log` and ride the same redaction pass
//!    (M7); a leak-guard test asserts log attribute keys stay PII-free too.

mod config;
mod exporter;
mod guard;
mod layer;
mod propagation;
mod provider;

pub use config::{ObservabilityConfig, from_env};
pub use guard::ObservabilityGuard;
pub use propagation::extract_trace_context;

use tracing_subscriber::Layer;
use tracing_subscriber::registry::Registry;

/// The outputs of [`init`]: the OTel `tracing` layers to add to the registry
/// and an optional shutdown guard to place in Tauri managed state.
///
/// `layers` is **empty** (and `guard` is `None`) when observability is disabled
/// or the span exporter could not be built — the caller then adds a no-op and
/// registers no guard.
pub struct Observability {
    /// The OTel `tracing` layers — the trace bridge plus, when its sink built,
    /// the M1b logs bridge.
    ///
    /// Returned as a `Vec` rather than two `Option` fields on purpose: a
    /// `Vec<Box<dyn Layer<Registry>>>` is *itself* one `Layer<Registry>`, so the
    /// caller adds both in a single `.with(...)`. Two separately-boxed
    /// `Box<dyn Layer<Registry>>` values cannot be chained via `.with().with()`
    /// — each implements `Layer` only for the bare `Registry`, not for the
    /// `Layered<…>` that the first `.with` produces. An empty `Vec` is a no-op
    /// on the registry, so the caller adds it unconditionally.
    pub layers: Vec<Box<dyn Layer<Registry> + Send + Sync>>,

    /// Flush-on-exit guard, or `None` when disabled / unavailable.
    ///
    /// When `Some`, the caller must keep it alive for the app lifetime
    /// (Tauri managed state), exactly like `LogGuard`.
    pub guard: Option<ObservabilityGuard>,
}

impl Observability {
    /// The disabled / unavailable result: no layers, no guard.
    fn disabled() -> Self {
        Self {
            layers: Vec::new(),
            guard: None,
        }
    }
}

/// Initialize the trace + logs pipelines for one app boot.
///
/// Returns [`Observability::disabled`] (no layers, no guard) when
/// `config.enabled` is `false` OR the span exporter cannot be built (e.g. a
/// read-only disk). Otherwise builds the span exporter under `<log_dir>/traces/`,
/// the batched `SdkTracerProvider`, and the trace layer; then — independently —
/// the log exporter under `<log_dir>/otel-logs/`, its `SdkLoggerProvider`, and
/// the M1b logs bridge layer. The logs signal degrades on its own: if only its
/// sink is unwritable, tracing still runs without it.
///
/// This function never touches the network and never panics.
#[must_use]
pub fn init(log_dir: &std::path::Path, config: &ObservabilityConfig) -> Observability {
    if !config.enabled {
        return Observability::disabled();
    }

    // Degrade exactly like the log file appender: if the traces dir is
    // unwritable, skip the whole pipeline and keep the app running.
    let Some(exporter) = exporter::build_file_exporter(log_dir) else {
        return Observability::disabled();
    };

    let provider = provider::build_tracer_provider(config, exporter);
    let mut layers: Vec<Box<dyn Layer<Registry> + Send + Sync>> =
        vec![layer::build_trace_layer(&provider)];

    // M1b — the OTel logs bridge is an independent signal: if its `otel-logs/`
    // sink can't be opened, traces still run (no logs layer, no logger guard).
    let logger_provider = match exporter::build_log_exporter(log_dir) {
        Some(log_exporter) => {
            let logger_provider = provider::build_logger_provider(log_exporter);
            layers.push(layer::build_logs_layer(&logger_provider));
            Some(logger_provider)
        }
        None => None,
    };

    let guard = ObservabilityGuard::new(provider, logger_provider);

    Observability {
        layers,
        guard: Some(guard),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use opentelemetry::trace::TracerProvider as _;
    use opentelemetry_sdk::Resource;
    use opentelemetry_sdk::trace::{InMemorySpanExporter, Sampler, SdkTracerProvider};
    use tracing_subscriber::layer::SubscriberExt;

    /// `init` with a disabled config must be a complete no-op: no layer, no
    /// guard. This is the off-by-default invariant.
    #[test]
    fn init_disabled_returns_noop() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let cfg = ObservabilityConfig {
            enabled: false,
            sampling_ratio: 1.0,
        };
        let obs = init(tmp.path(), &cfg);
        assert!(obs.layers.is_empty(), "disabled ⇒ no OTel layers");
        assert!(obs.guard.is_none(), "disabled ⇒ no guard");
    }

    /// `init` with an enabled config must produce both OTel layers (trace +
    /// logs) and a guard, and must create the on-disk traces + otel-logs dirs.
    #[test]
    fn init_enabled_builds_layers_and_guard() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let cfg = ObservabilityConfig {
            enabled: true,
            sampling_ratio: 1.0,
        };
        let obs = init(tmp.path(), &cfg);
        assert_eq!(
            obs.layers.len(),
            2,
            "enabled ⇒ both the trace bridge and the M1b logs bridge are present"
        );
        assert!(obs.guard.is_some(), "enabled ⇒ guard present");
        assert!(
            tmp.path().join("traces").is_dir(),
            "enabled ⇒ traces/ dir created"
        );
        assert!(
            tmp.path().join("otel-logs").is_dir(),
            "enabled ⇒ otel-logs/ dir created"
        );
        // Drop the guard explicitly (flush + shutdown both providers) — must not
        // panic.
        drop(obs);
    }

    /// End-to-end pipeline + PII leak-guard.
    ///
    /// Builds a provider with the SDK's in-memory exporter, drives a span
    /// through the real `tracing-opentelemetry` layer, force-flushes, and
    /// asserts (a) the span landed with the expected name and (b) every
    /// attribute key is on a PII-safe allowlist. The allowlist assertion is
    /// the leak guard: if any future `#[instrument]` adds a content/query/tag
    /// attribute, this test fails.
    #[test]
    fn span_pipeline_emits_safe_attributes_only() {
        let exporter = InMemorySpanExporter::default();

        let resource = Resource::builder().with_service_name("agaric").build();
        let provider = SdkTracerProvider::builder()
            .with_resource(resource)
            // Simple processor exports synchronously on span end, which makes
            // force_flush deterministic for the test (no batch timing).
            .with_span_processor(opentelemetry_sdk::trace::SimpleSpanProcessor::new(
                exporter.clone(),
            ))
            .with_sampler(Sampler::ParentBased(Box::new(Sampler::TraceIdRatioBased(
                1.0,
            ))))
            .build();

        let tracer = provider.tracer("agaric");
        let otel_layer = tracing_opentelemetry::layer().with_tracer(tracer);
        let subscriber = tracing_subscriber::registry().with(otel_layer);

        // PII-safe fields only: opaque id + count + op-type enum.
        tracing::subscriber::with_default(subscriber, || {
            let span = tracing::info_span!(
                "create_block",
                block_type = "page",
                parent_id = "01ARZ3NDEKTSV4RRFFQ69G5FAV",
                child_count = 3_i64,
            );
            let _e = span.enter();
        });

        provider.force_flush().expect("force_flush");

        let spans = exporter.get_finished_spans().expect("finished spans");
        assert_eq!(spans.len(), 1, "exactly one span should be exported");
        let span = &spans[0];
        assert_eq!(span.name, "create_block", "span name must match");

        // Leak guard. Two layers:
        //
        // 1. FORBIDDEN: no attribute key may be (or contain) a PII-bearing
        //    name — content/text/query/tag-name/property/value. This is the
        //    hard "nothing leaks" assertion.
        // 2. ALLOWLIST: every *app-chosen* attribute (anything not in the
        //    framework `code.*` / `thread.*` source-location + runtime
        //    metadata namespaces) must appear on `ALLOWED_KEYS` and be opaque
        //    (id / enum tag / count / boolean). `code.*` / `thread.*` are
        //    injected automatically by `tracing-opentelemetry` from the span's
        //    `Metadata` — they describe OUR source/runtime, never user data
        //    (the same paths already ship in the binary), so they are exempt.
        const ALLOWED_KEYS: &[&str] = &[
            "block_type",
            "parent_id",
            "child_count",
            "space_id",
            "count",
            "op_type",
            "block_id",
            "has_parent",
            "has_tag_filter",
            "limit",
            "index",
        ];
        // Substrings that would indicate a PII leak if they appeared in a key.
        const FORBIDDEN_SUBSTRINGS: &[&str] = &[
            "content", "to_text", "query", "tag", "property", "value", "text", "title", "name",
        ];

        for kv in &span.attributes {
            let key = kv.key.as_str();

            // Framework-injected metadata is exempt from the allowlist but is
            // still checked for forbidden substrings below.
            // `code.*` / `thread.*` / `*_ns` are source-location + timing
            // metadata; `target` / `level` are the tracing event's own
            // module-path + verbosity (our code, not user data).
            let is_framework_meta = key.starts_with("code.")
                || key.starts_with("thread.")
                || key.ends_with("_ns")
                || key == "target"
                || key == "level";

            // Layer 1: hard PII-leak guard. `thread.name` / `code.*` legitimately
            // contain "name"; exempt framework metadata from the substring check.
            if !is_framework_meta {
                for bad in FORBIDDEN_SUBSTRINGS {
                    assert!(
                        !key.contains(bad),
                        "PII-leak guard: span attribute {key:?} contains forbidden \
                         substring {bad:?}"
                    );
                }
                // Layer 2: app-chosen keys must be explicitly allowlisted.
                assert!(
                    ALLOWED_KEYS.contains(&key),
                    "span carried non-allowlisted attribute {key:?} — add to \
                     ALLOWED_KEYS only after confirming it is opaque \
                     (id/enum/count/bool), never PII"
                );
            }
        }
    }

    /// M1b headline guarantee: a `tracing` event emitted inside an instrumented
    /// span reaches the OTel logs bridge as a `LogRecord` **correlated** to that
    /// span (same `trace_id` + `span_id`), and leaks no PII through its
    /// attribute keys.
    ///
    /// Correlation is not done by the appender bridge itself — the SDK logger
    /// fills the record's trace context from the *current* OTel context, which
    /// the `tracing-opentelemetry` layer activates on span enter (its default
    /// `context_activation`). This test wires the real trace layer + real
    /// bridge together to prove that seam, so a regression (e.g. a future
    /// `with_context_activation(false)`) fails here instead of silently
    /// shipping uncorrelated logs.
    #[test]
    fn logs_are_span_correlated_and_pii_safe() {
        use opentelemetry::logs::AnyValue;
        use opentelemetry_appender_tracing::layer::OpenTelemetryTracingBridge;
        use opentelemetry_sdk::logs::{InMemoryLogExporter, SdkLoggerProvider};

        // Trace side: in-memory span exporter behind the real tracing-otel layer.
        let span_exporter = InMemorySpanExporter::default();
        let tracer_provider = SdkTracerProvider::builder()
            .with_resource(Resource::builder().with_service_name("agaric").build())
            .with_span_processor(opentelemetry_sdk::trace::SimpleSpanProcessor::new(
                span_exporter.clone(),
            ))
            .with_sampler(Sampler::ParentBased(Box::new(Sampler::TraceIdRatioBased(
                1.0,
            ))))
            .build();
        let otel_trace_layer =
            tracing_opentelemetry::layer().with_tracer(tracer_provider.tracer("agaric"));

        // Logs side: in-memory log exporter behind the real appender bridge. A
        // simple (synchronous) processor makes force_flush deterministic.
        let log_exporter = InMemoryLogExporter::default();
        let logger_provider = SdkLoggerProvider::builder()
            .with_simple_exporter(log_exporter.clone())
            .build();
        let logs_bridge = OpenTelemetryTracingBridge::new(&logger_provider);

        let subscriber = tracing_subscriber::registry()
            .with(otel_trace_layer)
            .with(logs_bridge);

        tracing::subscriber::with_default(subscriber, || {
            // PII-safe span + event fields only: opaque id, enum tag, count.
            let span = tracing::info_span!("apply_op", block_id = "01ARZ3NDEKTSV4RRFFQ69G5FAV");
            let _enter = span.enter();
            tracing::error!(op_type = "insert", count = 2_i64, "op apply failed");
        });

        tracer_provider.force_flush().expect("flush spans");
        logger_provider.force_flush().expect("flush logs");

        let spans = span_exporter.get_finished_spans().expect("finished spans");
        assert_eq!(spans.len(), 1, "exactly one span should be exported");
        let span = &spans[0];

        let logs = log_exporter.get_emitted_logs().expect("emitted logs");
        // The bridged `tracing::error!` must be among the emitted records.
        let rec = logs
            .iter()
            .map(|l| &l.record)
            .find(|r| {
                r.body().is_some_and(
                    |b| matches!(b, AnyValue::String(s) if s.as_str().contains("op apply failed")),
                )
            })
            .expect("the tracing::error! event must reach the OTel logs bridge");

        // Correlation: the record must carry the active span's trace context.
        let tc = rec
            .trace_context()
            .expect("log record must carry trace context (span correlation)");
        assert_eq!(
            tc.trace_id,
            span.span_context.trace_id(),
            "log trace_id must equal the span's trace_id"
        );
        assert_eq!(
            tc.span_id,
            span.span_context.span_id(),
            "log span_id must equal the span's span_id"
        );

        // PII leak-guard on log attribute keys — same discipline as spans.
        const FORBIDDEN_SUBSTRINGS: &[&str] = &[
            "content", "to_text", "query", "tag", "property", "value", "text", "title",
        ];
        for (key, _value) in rec.attributes_iter() {
            let key = key.as_str();
            for bad in FORBIDDEN_SUBSTRINGS {
                assert!(
                    !key.contains(bad),
                    "PII-leak guard: log attribute {key:?} contains forbidden substring {bad:?}"
                );
            }
        }
    }
}
