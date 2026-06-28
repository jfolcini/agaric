//! OpenTelemetry observability command handlers (#2110, M3b).
//!
//! Hosts [`ingest_otel_spans`], the single IPC entry point the frontend tracer
//! uses to ship its interaction spans to the backend's local trace sink. The
//! command is pure-additive, zero-egress (writes a local file only), and a
//! silent no-op when observability is disabled — see
//! [`crate::observability::FrontendSpanIngestor`].

use tracing::instrument;

use crate::error::AppError;
use crate::observability::{FrontendSpan, FrontendSpanIngestor};

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
