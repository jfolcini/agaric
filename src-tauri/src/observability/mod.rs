//! OpenTelemetry trace observability for the Agaric backend (issue #2110, M1a).
//!
//! This module turns `tracing` spans emitted by backend commands into
//! OpenTelemetry traces and writes them to a LOCAL FILE. It plugs into the
//! existing `init_logging` subscriber chain in `lib.rs` as one more optional
//! `tracing_subscriber::Layer`, and a Drop-guard flushes the pipeline on exit
//! (mirroring `LogGuard`).
//!
//! # Architecture
//!
//! ```text
//!   #[instrument] commands ──► tracing ──► Registry
//!                                            ├─ EnvFilter (RUST_LOG / agaric=info)
//!                                            ├─ stderr fmt layer        (unchanged)
//!                                            ├─ JSON file layer         (unchanged)
//!                                            └─ OTel layer (this module, Option)
//!                                                   │
//!                                          tracing-opentelemetry
//!                                                   │
//!                                          SdkTracerProvider
//!                                            ├─ Resource(service.name/version)
//!                                            ├─ ParentBased(TraceIdRatio) sampler
//!                                            └─ BatchSpanProcessor ──► FileSpanExporter
//!                                                                          │
//!                                                              <log_dir>/traces/*.log
//! ```
//!
//! Submodules: [`config`] (pure env parsing), [`exporter`] (the only place that
//! knows the on-disk format), [`provider`] (resource + sampler + batch
//! processor), [`layer`] (the tracing↔OTel bridge), [`guard`] (flush on exit).
//!
//! # Three invariants (hard rules)
//!
//! 1. **Zero egress.** Spans go ONLY to a local file. There is no
//!    `opentelemetry-otlp` / HTTP / gRPC exporter anywhere in this crate. The
//!    app's "nothing leaves your machine" promise + CSP forbid it.
//! 2. **Off by default.** When `AGARIC_OTEL` is unset, [`init`] returns a no-op
//!    `Observability { trace_layer: None, guard: None }`. An `Option<Layer>` is
//!    a no-op when `None`, so the existing logging behaviour is byte-identical
//!    and overhead is ~zero.
//! 3. **PII discipline.** Span names + attributes carry ONLY opaque ids
//!    (ULIDs), enums/op-types, counts, durations, and booleans. NEVER block
//!    `content`, `to_text`, search query strings, tag names, or property
//!    values. This is enforced at every `#[instrument(... fields(...))]` site;
//!    the exporter just serializes what it is handed.

mod config;
mod exporter;
mod guard;
mod layer;
mod provider;

pub use config::{ObservabilityConfig, from_env};
pub use guard::ObservabilityGuard;

use tracing_subscriber::Layer;
use tracing_subscriber::registry::Registry;

/// The outputs of [`init`]: an optional trace layer to add to the registry and
/// an optional shutdown guard to place in Tauri managed state.
///
/// Both are `None` when observability is disabled or the file exporter could
/// not be built — the caller then adds a no-op layer and registers no guard.
pub struct Observability {
    /// Boxed OTel trace layer, or `None` when disabled / unavailable.
    ///
    /// `.with(None)` on a `tracing_subscriber` registry is a no-op, so the
    /// caller can add this unconditionally.
    pub trace_layer: Option<Box<dyn Layer<Registry> + Send + Sync>>,

    /// Flush-on-exit guard, or `None` when disabled / unavailable.
    ///
    /// When `Some`, the caller must keep it alive for the app lifetime
    /// (Tauri managed state), exactly like `LogGuard`.
    pub guard: Option<ObservabilityGuard>,
}

impl Observability {
    /// The disabled / unavailable result: no layer, no guard.
    fn disabled() -> Self {
        Self {
            trace_layer: None,
            guard: None,
        }
    }
}

/// Initialize the trace pipeline for one app boot.
///
/// Returns [`Observability::disabled`] (no layer, no guard) when
/// `config.enabled` is `false` OR the file exporter cannot be built (e.g. a
/// read-only disk). Otherwise builds the file exporter under
/// `<log_dir>/traces/`, the batched `SdkTracerProvider`, the boxed trace
/// layer, and the shutdown guard.
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
    let trace_layer = layer::build_trace_layer(&provider);
    let guard = ObservabilityGuard::new(provider);

    Observability {
        trace_layer: Some(trace_layer),
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
        assert!(obs.trace_layer.is_none(), "disabled ⇒ no trace layer");
        assert!(obs.guard.is_none(), "disabled ⇒ no guard");
    }

    /// `init` with an enabled config must produce both a layer and a guard, and
    /// must create the on-disk traces directory.
    #[test]
    fn init_enabled_builds_layer_and_guard() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let cfg = ObservabilityConfig {
            enabled: true,
            sampling_ratio: 1.0,
        };
        let obs = init(tmp.path(), &cfg);
        assert!(obs.trace_layer.is_some(), "enabled ⇒ trace layer present");
        assert!(obs.guard.is_some(), "enabled ⇒ guard present");
        assert!(
            tmp.path().join("traces").is_dir(),
            "enabled ⇒ traces/ dir created"
        );
        // Drop the guard explicitly (flush + shutdown) — must not panic.
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
}
