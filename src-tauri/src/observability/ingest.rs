//! Ingest of frontend-produced spans into the local trace sink (#2110, M3b).
//!
//! The frontend tracer (M3b/M4) produces W3C/OTLP-shaped interaction spans and
//! ships them to the backend over a single Tauri command
//! ([`crate::commands::observability::ingest_otel_spans`]). This module owns the
//! sink-facing half: it serializes each [`FrontendSpan`] to one line and writes
//! it into a daily-rotated file under `<log_dir>/traces/`, the SAME directory
//! the backend [`super::exporter::FileSpanExporter`] writes to. Because both
//! halves carry the W3C `trace_id`, a frontend interaction span and the backend
//! command spans it triggered can be joined by `trace_id` in the local sink.
//!
//! # Zero egress (hard invariant)
//!
//! Frontend spans go ONLY to a local file, exactly like the backend spans —
//! there is no network exporter anywhere in this crate. The rolling-file
//! plumbing is reused wholesale from [`super::exporter::RollingFileSink`]; this
//! module adds only the frontend-span line format, never a second copy of the
//! directory-creation / rotation / degrade logic.
//!
//! # Off by default
//!
//! [`build_frontend_ingestor`] holds `None` when observability is disabled (and
//! also on any filesystem error), so [`FrontendSpanIngestor::ingest`] is a
//! silent no-op. When disabled it creates no `traces/` directory and writes
//! nothing, mirroring the rest of the pipeline's "byte-identical when off"
//! guarantee.
//!
//! # PII discipline
//!
//! This writes whatever the frontend sends. Keeping content, query strings, tag
//! names, and property values OUT of frontend span names + attributes is the
//! FRONTEND's responsibility (enforced by the M4 frontend guard), exactly as the
//! backend [`super::exporter`] trusts its `#[instrument]` instrumentation sites:
//! by the time a span reaches this code the PII decision has already been made.
//! Values are routed through [`super::exporter::sanitize_inline`] only for line
//! integrity (so a tab/newline can never split a record), not as a redaction
//! boundary.

use std::path::Path;

use super::exporter::{RollingFileSink, TRACES_SUBDIR, sanitize_inline};

/// Filename prefix for the frontend-span rolling file, kept distinct from the
/// backend `agaric-traces.log` so the two streams rotate independently while
/// sharing the `traces/` directory.
const FRONTEND_TRACES_PREFIX: &str = "agaric-frontend.log";

/// `service.name` stamped on every ingested frontend span line, distinguishing
/// frontend interaction spans from the backend `agaric` spans in the same sink.
const FRONTEND_SERVICE_NAME: &str = "agaric-frontend";

/// Maximum number of spans accepted from a single `ingest` call; the rest are
/// dropped. Bounds a misbehaving (or malicious) frontend that floods the IPC,
/// mirroring how `log_frontend` truncates oversized fields.
const MAX_SPANS_PER_CALL: usize = 512;

/// One frontend-produced span, mirroring a W3C/OTLP span. Deserialized straight
/// off the IPC boundary; the frontend tracer fills every field.
///
/// The id fields are opaque W3C hex strings (`trace_id` 32 hex chars, `span_id`
/// 16); `start_unix_millis` / `end_unix_millis` are epoch-millisecond `f64`s
/// (matching `performance.timeOrigin + performance.now()` on the frontend).
/// `attributes` is a flat key/value list the frontend chose to attach — it is
/// the frontend's job (M4 guard) to keep PII out of these.
#[derive(Debug, Clone, serde::Deserialize, specta::Type)]
pub struct FrontendSpan {
    /// W3C trace id (32 lowercase hex chars). The join key with backend spans.
    pub trace_id: String,
    /// W3C span id (16 lowercase hex chars).
    pub span_id: String,
    /// Parent span id, or `None` for a root span.
    pub parent_span_id: Option<String>,
    /// Span name (an opaque interaction/op label — never content).
    pub name: String,
    /// Span start as epoch milliseconds.
    pub start_unix_millis: f64,
    /// Span end as epoch milliseconds.
    pub end_unix_millis: f64,
    /// Flat attribute key/value pairs the frontend attached.
    pub attributes: Vec<(String, String)>,
    /// Optional status string (e.g. `"ok"` / `"error"`), or `None`.
    pub status: Option<String>,
}

/// Writes ingested [`FrontendSpan`]s to the local `traces/` sink.
///
/// Owns an `Option<RollingFileSink>`: `Some` when observability is enabled and
/// the sink built, `None` otherwise. The inner [`RollingFileSink`] already keeps
/// its appender behind a `Mutex`, so this type is `Send + Sync + 'static` and
/// can live in Tauri managed state for the app lifetime.
pub struct FrontendSpanIngestor {
    sink: Option<RollingFileSink>,
}

impl std::fmt::Debug for FrontendSpanIngestor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FrontendSpanIngestor")
            .field("enabled", &self.sink.is_some())
            .finish()
    }
}

impl FrontendSpanIngestor {
    /// Write each span as one line to the local frontend-trace file.
    ///
    /// A silent no-op when the sink is `None` (observability disabled or the
    /// file unavailable). Caps the batch at [`MAX_SPANS_PER_CALL`] — extra
    /// spans are dropped rather than written, bounding a flooding frontend.
    pub fn ingest(&self, spans: &[FrontendSpan]) {
        let Some(sink) = &self.sink else {
            return;
        };
        if spans.is_empty() {
            return;
        }

        let take = spans.len().min(MAX_SPANS_PER_CALL);
        // Build the full buffer outside the lock, then write under it (one
        // atomic write per call), mirroring the backend exporter.
        let mut buf = String::with_capacity(take * 128);
        for span in &spans[..take] {
            buf.push_str(&format_frontend_span(span));
        }
        sink.write_buf(&buf);
    }
}

/// Serialize one frontend span to a single line.
///
/// Format (tab-separated `key=value`), mirroring `format_span` in
/// [`super::exporter`]:
/// `end=<rfc3339-ms>\tservice=agaric-frontend\tname=<name>\ttrace=<trace_id>\t`
/// `span=<span_id>\tparent=<parent_span_id|->\tdur_ms=<end-start, 3dp>\t`
/// `status=<status|->\t<attr-key>=<attr-val>…`. `end` is `end_unix_millis`
/// rendered as RFC-3339 (UTC, millis) so a line is self-describing in time and
/// sorts alongside the backend trace lines. Every value is routed through
/// [`sanitize_inline`] so no field can split a record.
fn format_frontend_span(span: &FrontendSpan) -> String {
    use std::fmt::Write as _;

    let dur_ms = span.end_unix_millis - span.start_unix_millis;

    let end = epoch_millis_to_rfc3339(span.end_unix_millis);

    let parent = span
        .parent_span_id
        .as_deref()
        .map_or_else(|| "-".to_owned(), sanitize_inline);
    let status = span
        .status
        .as_deref()
        .map_or_else(|| "-".to_owned(), sanitize_inline);

    let mut line = String::new();
    let _ = write!(
        line,
        "end={end}\tservice={service}\tname={name}\ttrace={trace}\tspan={span_id}\tparent={parent}\tdur_ms={dur_ms:.3}\tstatus={status}",
        service = FRONTEND_SERVICE_NAME,
        name = sanitize_inline(&span.name),
        trace = sanitize_inline(&span.trace_id),
        span_id = sanitize_inline(&span.span_id),
    );
    for (key, value) in &span.attributes {
        let _ = write!(
            line,
            "\t{}={}",
            sanitize_inline(key),
            sanitize_inline(value)
        );
    }
    line.push('\n');
    line
}

/// Render an epoch-millisecond `f64` as RFC-3339 (UTC, millisecond precision).
///
/// Falls back to `"-"` for a non-finite or out-of-range value rather than
/// panicking, so a malformed frontend timestamp never breaks a line.
fn epoch_millis_to_rfc3339(millis: f64) -> String {
    if !millis.is_finite() {
        return "-".to_owned();
    }
    // Fractional milliseconds are intentionally dropped, and an out-of-range
    // value makes `from_timestamp_millis` return `None` (→ "-"), so this cast is
    // range-safe.
    #[allow(clippy::cast_possible_truncation)]
    let millis_i64 = millis as i64;
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(millis_i64).map_or_else(
        || "-".to_owned(),
        |dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    )
}

/// Build the frontend-span ingestor for one app boot.
///
/// When `enabled`, opens a [`RollingFileSink`] under `<log_dir>/traces/` with
/// the [`FRONTEND_TRACES_PREFIX`] filename prefix; on any filesystem error (or
/// when disabled) holds `None` so [`FrontendSpanIngestor::ingest`] is a no-op.
/// Never panics — matches the graceful degradation of the rest of the pipeline.
#[must_use]
pub fn build_frontend_ingestor(log_dir: &Path, enabled: bool) -> FrontendSpanIngestor {
    let sink = if enabled {
        RollingFileSink::build(log_dir, TRACES_SUBDIR, FRONTEND_TRACES_PREFIX)
    } else {
        None
    };
    FrontendSpanIngestor { sink }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_span(trace_id: &str) -> FrontendSpan {
        FrontendSpan {
            trace_id: trace_id.to_owned(),
            span_id: "00f067aa0ba902b7".to_owned(),
            parent_span_id: None,
            name: "click_create_block".to_owned(),
            start_unix_millis: 1_700_000_000_000.0,
            end_unix_millis: 1_700_000_000_012.5,
            attributes: vec![("count".to_owned(), "3".to_owned())],
            status: Some("ok".to_owned()),
        }
    }

    /// (a) An enabled ingestor writes N spans to the frontend trace file, and
    /// the file carries the trace_id and `service=agaric-frontend`.
    #[test]
    fn ingest_writes_spans_to_file() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let ingestor = build_frontend_ingestor(tmp.path(), true);

        let trace = "4bf92f3577b34da6a3ce929d0e0e4736";
        let spans = vec![sample_span(trace), sample_span(trace)];
        ingestor.ingest(&spans);

        let traces_dir = tmp.path().join(TRACES_SUBDIR);
        assert!(traces_dir.is_dir(), "enabled ⇒ traces/ dir created");

        // Find the single rotated file the appender produced.
        let mut contents = String::new();
        for entry in std::fs::read_dir(&traces_dir).expect("read traces dir") {
            let path = entry.expect("dir entry").path();
            if path.is_file() {
                contents.push_str(&std::fs::read_to_string(&path).expect("read trace file"));
            }
        }

        assert!(
            contents.contains(trace),
            "trace_id must appear in the written line(s): {contents:?}"
        );
        assert!(
            contents.contains("service=agaric-frontend"),
            "line must carry service=agaric-frontend: {contents:?}"
        );
        assert!(
            contents.contains("name=click_create_block"),
            "line must carry the span name: {contents:?}"
        );
        assert_eq!(
            contents.lines().count(),
            2,
            "two spans ⇒ two lines, got: {contents:?}"
        );
    }

    /// (b) A disabled ingestor is a complete no-op: no file, no `traces/` dir.
    #[test]
    fn disabled_ingestor_is_a_noop() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let ingestor = build_frontend_ingestor(tmp.path(), false);

        ingestor.ingest(&[sample_span("4bf92f3577b34da6a3ce929d0e0e4736")]);

        assert!(
            !tmp.path().join(TRACES_SUBDIR).exists(),
            "disabled ⇒ no traces/ dir is created"
        );
    }

    /// (c) A batch over the cap is truncated to [`MAX_SPANS_PER_CALL`] lines.
    #[test]
    fn ingest_caps_batch_over_limit() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let ingestor = build_frontend_ingestor(tmp.path(), true);

        let trace = "4bf92f3577b34da6a3ce929d0e0e4736";
        let spans: Vec<FrontendSpan> = (0..MAX_SPANS_PER_CALL + 10)
            .map(|_| sample_span(trace))
            .collect();
        ingestor.ingest(&spans);

        let traces_dir = tmp.path().join(TRACES_SUBDIR);
        let mut line_count = 0usize;
        for entry in std::fs::read_dir(&traces_dir).expect("read traces dir") {
            let path = entry.expect("dir entry").path();
            if path.is_file() {
                line_count += std::fs::read_to_string(&path)
                    .expect("read trace file")
                    .lines()
                    .count();
            }
        }
        assert_eq!(
            line_count, MAX_SPANS_PER_CALL,
            "batch over cap must be truncated to {MAX_SPANS_PER_CALL} lines"
        );
    }

    /// A non-finite / malformed end timestamp degrades to `-` rather than
    /// panicking, keeping the line well-formed.
    #[test]
    fn malformed_timestamp_degrades_to_dash() {
        assert_eq!(epoch_millis_to_rfc3339(f64::NAN), "-");
        assert_eq!(epoch_millis_to_rfc3339(f64::INFINITY), "-");
        // A valid timestamp renders as RFC-3339 millis.
        let rendered = epoch_millis_to_rfc3339(1_700_000_000_012.0);
        assert!(rendered.ends_with('Z'), "UTC RFC-3339, got {rendered:?}");
    }
}
