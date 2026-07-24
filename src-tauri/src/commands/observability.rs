//! OpenTelemetry observability command handlers (#2110, M3b).
//!
//! Hosts [`ingest_otel_spans`], the single IPC entry point the frontend tracer
//! uses to ship its interaction spans to the backend's local trace sink. The
//! command is pure-additive, zero-egress (writes a local file only), and a
//! silent no-op when observability is disabled — see
//! [`agaric_observability::FrontendSpanIngestor`].

use tracing::instrument;

use agaric_core::error::AppError;
use agaric_observability::{FrontendSpan, FrontendSpanIngestor};

/// Ingest a batch of frontend-produced spans into the local trace sink.
///
/// Writes each [`FrontendSpan`] as one line into `<log_dir>/traces/`'s
/// frontend-trace file, so frontend interaction spans land in the same local
/// sink as the backend trace spans and can be joined by `trace_id`. A no-op
/// when observability is disabled (the managed [`FrontendSpanIngestor`] holds no
/// sink). Fire-and-forget on the frontend side; always returns `Ok(())`.
///
/// `#[instrument(skip_all, fields(count = spans.len()))]` records only the batch
/// size — never the span payload — satisfying the M2a command-instrumentation
/// guard while keeping content/PII out of the span.
#[tauri::command]
#[instrument(skip_all, fields(count = spans.len()))]
#[specta::specta]
pub async fn ingest_otel_spans(
    ingestor: tauri::State<'_, FrontendSpanIngestor>,
    spans: Vec<FrontendSpan>,
) -> Result<(), AppError> {
    ingestor.ingest(&spans);
    Ok(())
}

/// Set the runtime trace head-sampling ratio (#2110, M5).
///
/// One call toggles the whole app between full-tracing and sampling: the
/// backend's runtime sampler reads the new ratio on the next root span (see
/// [`agaric_observability::set_sampling_ratio`]), and the frontend tracer sets
/// the same ratio locally — so "sample 10%" or "trace everything" is a single
/// app-wide switch. `ratio` is clamped to `[0.0, 1.0]`; `1.0` = full tracing,
/// `0.0` = drop new roots.
///
/// No-op-safe when observability is disabled: the ratio is just a process-global
/// number; with no provider installed nothing samples regardless. The `ratio`
/// is a bare number (no content/PII), so the span records it directly.
#[tauri::command]
#[instrument]
#[specta::specta]
pub fn set_trace_sampling(ratio: f64) -> Result<(), AppError> {
    agaric_observability::set_sampling_ratio(ratio);
    Ok(())
}
