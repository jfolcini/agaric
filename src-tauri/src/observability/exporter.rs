//! On-disk span exporter — the ONLY module that knows the trace file format.
//!
//! # Zero egress (hard invariant)
//!
//! Spans are serialized to a LOCAL FILE under `<log_dir>/traces/` and nothing
//! else. There is deliberately no network exporter anywhere in this crate
//! (`opentelemetry-otlp` and every HTTP/gRPC span exporter are intentionally
//! absent from `Cargo.toml`). The app's "nothing leaves your machine" promise
//! plus its CSP forbid any outbound connection, so this exporter is the single
//! sink and it only ever touches the filesystem.
//!
//! # Swappable behind the `SpanExporter` trait
//!
//! [`FileSpanExporter`] implements `opentelemetry_sdk::trace::SpanExporter`.
//! The line-per-span text format below is intentionally simple. A future,
//! stricter OTLP/JSON *file* exporter can replace this type wholesale without
//! touching `provider.rs`, `layer.rs`, `guard.rs`, or `mod.rs` — they only
//! depend on the trait, not on the format. (The upstream `opentelemetry-stdout`
//! crate was evaluated for this role and rejected: its 0.32 `SpanExporter`
//! hardcodes `println!` to process stdout with no writer hook, so it cannot
//! write to a file. Owning the exporter is the only way to hit a local file.)
//!
//! # PII discipline
//!
//! This exporter writes whatever attributes the SDK hands it. Keeping content,
//! query strings, tag names, and property values OUT of spans is enforced at
//! the *instrumentation* sites (the `#[instrument(... fields(...))]` on each
//! command), never here — by the time a `SpanData` reaches this code the
//! decision has already been made. The format below faithfully serializes the
//! attribute keys/values it is given.
//!
//! # Graceful degradation
//!
//! [`build_file_exporter`] returns `None` when `<log_dir>/traces/` cannot be
//! created or opened (read-only / full disk), exactly like
//! `build_log_file_appender` in `lib.rs`. The caller then skips the whole
//! trace pipeline and the app keeps running with normal logging.

use std::io::Write;
use std::path::Path;
use std::sync::Mutex;

use opentelemetry_sdk::error::OTelSdkResult;
use opentelemetry_sdk::logs::{LogBatch, LogExporter, SdkLogRecord};
use opentelemetry_sdk::trace::{SpanData, SpanExporter};
use tracing_appender::rolling::{RollingFileAppender, Rotation};

/// Maximum number of rotated files to retain per OTel signal subdir.
///
/// Mirrors the 14-file daily-rotation policy used for `agaric.log` in
/// `build_log_file_appender`, so the trace + log files never grow the on-disk
/// footprint unbounded between boots.
const MAX_OTEL_FILES: usize = 14;

/// Subdirectory of the log directory that holds rotated span (trace) files.
const TRACES_SUBDIR: &str = "traces";

/// Subdirectory of the log directory that holds rotated OTel `LogRecord` files
/// (M1b). Kept separate from `traces/` (spans) and from the human-readable
/// `agaric.log`, so each OTel signal is its own rotated, independently-degrading
/// stream.
const OTEL_LOGS_SUBDIR: &str = "otel-logs";

/// Shared rolling-file plumbing behind both OTel file exporters.
///
/// Owns a daily-rotated [`RollingFileAppender`] behind a `Mutex`: the SDK calls
/// `export` from a dedicated batch worker, so the mutex makes per-batch writes
/// atomic and keeps the type `Send + Sync` (required by the exporter traits)
/// without an async lock. [`FileSpanExporter`] and [`FileLogExporter`] differ
/// only in the per-record text format; all the directory-creation, rotation,
/// graceful-degradation, and write/flush logic lives here, once.
struct RollingFileSink {
    writer: Mutex<RollingFileAppender>,
}

impl RollingFileSink {
    /// Build a sink writing daily-rotated `<log_dir>/<subdir>/<prefix>*` files,
    /// or `None` when the subdir cannot be created or opened (read-only / full
    /// disk). Degrades exactly like `build_log_file_appender` in `lib.rs` —
    /// writes the failure to stderr (never silent) and never panics.
    fn build(log_dir: &Path, subdir: &str, filename_prefix: &str) -> Option<Self> {
        let dir = log_dir.join(subdir);

        if let Err(e) = std::fs::create_dir_all(&dir) {
            // Pre/parallel to the tracing subscriber; write to stderr directly
            // so the failure is never silent, exactly like the log-dir degrade
            // path.
            eprintln!(
                "agaric: could not create OpenTelemetry {subdir} directory {}: {e}; \
                 that signal is disabled for this run",
                dir.display()
            );
            return None;
        }

        match RollingFileAppender::builder()
            .rotation(Rotation::DAILY)
            .max_log_files(MAX_OTEL_FILES)
            .filename_prefix(filename_prefix)
            .build(&dir)
        {
            Ok(appender) => Some(Self {
                writer: Mutex::new(appender),
            }),
            Err(e) => {
                eprintln!(
                    "agaric: could not open OpenTelemetry file in {}: {e}; \
                     that signal is disabled for this run",
                    dir.display()
                );
                None
            }
        }
    }

    /// Write a pre-built buffer under the lock, then flush.
    ///
    /// A write failure to the local file is non-fatal: degrade silently for the
    /// rest of the run rather than poison the batch worker.
    fn write_buf(&self, buf: &str) {
        if let Ok(mut w) = self.writer.lock() {
            let _ = w.write_all(buf.as_bytes());
            let _ = w.flush();
        }
    }

    /// Flush any buffered bytes (used by `SpanExporter::force_flush`).
    fn flush(&self) {
        if let Ok(mut w) = self.writer.lock() {
            let _ = w.flush();
        }
    }
}

/// A local-file [`SpanExporter`]: serializes each batch of spans as one
/// human-readable line per span into a daily-rotated `traces/` file.
pub struct FileSpanExporter {
    sink: RollingFileSink,
}

impl std::fmt::Debug for FileSpanExporter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("FileSpanExporter")
    }
}

/// Build the on-disk span exporter, or `None` if `traces/` is unwritable.
///
/// Creates `<log_dir>/traces/` with a daily `RollingFileAppender` capped at
/// [`MAX_OTEL_FILES`] retained files. Degrades to `None` (caller skips the
/// trace pipeline) on any filesystem error — never panics, mirroring
/// `build_log_file_appender`.
pub fn build_file_exporter(log_dir: &Path) -> Option<FileSpanExporter> {
    RollingFileSink::build(log_dir, TRACES_SUBDIR, "agaric-traces.log")
        .map(|sink| FileSpanExporter { sink })
}

/// Serialize one span to a single line.
///
/// Format (tab-separated `key=value` pairs):
/// `end=<rfc3339-ms>\tname=<name>\ttrace=<id>\tspan=<id>\tparent=<id|->\t`
/// `dur_ms=<f>\tstatus=<…>\t<attr-key>=<attr-val>…`. `end` is the span's end
/// time as RFC-3339 with millisecond precision (UTC), so a line is
/// self-describing in time without cross-referencing the log. Only opaque ids,
/// op-types, counts, durations, and the attribute key/values the
/// instrumentation chose to attach appear — there is no app content here.
fn format_span(span: &SpanData) -> String {
    use std::fmt::Write as _;

    let dur_ms = span
        .end_time
        .duration_since(span.start_time)
        .map_or(f64::NAN, |d| d.as_secs_f64() * 1000.0);

    // Span end time as RFC-3339 (UTC, millis) — the leading, human-readable
    // timestamp the line is keyed on.
    let end = chrono::DateTime::<chrono::Utc>::from(span.end_time)
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

    let parent = if span.parent_span_id == opentelemetry::SpanId::INVALID {
        "-".to_owned()
    } else {
        span.parent_span_id.to_string()
    };

    let mut line = String::new();
    let _ = write!(
        line,
        "end={end}\tname={name}\ttrace={trace}\tspan={span_id}\tparent={parent}\tdur_ms={dur_ms:.3}\tstatus={status:?}",
        name = span.name,
        trace = span.span_context.trace_id(),
        span_id = span.span_context.span_id(),
        status = span.status,
    );
    for kv in &span.attributes {
        let _ = write!(line, "\t{}={}", kv.key, kv.value.as_str());
    }
    line.push('\n');
    line
}

impl SpanExporter for FileSpanExporter {
    async fn export(&self, batch: Vec<SpanData>) -> OTelSdkResult {
        // Build the full buffer outside the lock, then write under it.
        let mut buf = String::with_capacity(batch.len() * 128);
        for span in &batch {
            buf.push_str(&format_span(span));
        }
        self.sink.write_buf(&buf);
        Ok(())
    }

    fn force_flush(&self) -> OTelSdkResult {
        self.sink.flush();
        Ok(())
    }
}

/// A local-file [`LogExporter`] (M1b): serializes each OTel `LogRecord` — the
/// bridged form of an existing `tracing` event — as one line into a daily-
/// rotated `otel-logs/` file, carrying the active span's trace/span id so logs
/// and traces are correlated in the local sink.
pub struct FileLogExporter {
    sink: RollingFileSink,
}

impl std::fmt::Debug for FileLogExporter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("FileLogExporter")
    }
}

/// Build the on-disk log exporter, or `None` if `otel-logs/` is unwritable.
///
/// Same graceful degradation as [`build_file_exporter`]: on any filesystem
/// error the caller skips just the OTel logs bridge and normal logging (plus
/// traces, which use a separate sink) continues.
pub fn build_log_exporter(log_dir: &Path) -> Option<FileLogExporter> {
    RollingFileSink::build(log_dir, OTEL_LOGS_SUBDIR, "agaric-otel.log")
        .map(|sink| FileLogExporter { sink })
}

/// Render an `AnyValue` scalar to a compact string for a log line.
///
/// Only the scalar variants appear in practice for bridged `tracing` events;
/// the composite variants (`Bytes`/`ListAny`/`Map`) fall back to their `Debug`
/// form rather than panicking.
fn any_value_to_string(value: &opentelemetry::logs::AnyValue) -> String {
    use opentelemetry::logs::AnyValue;
    match value {
        AnyValue::String(s) => s.to_string(),
        AnyValue::Int(i) => i.to_string(),
        AnyValue::Double(d) => d.to_string(),
        AnyValue::Boolean(b) => b.to_string(),
        other => format!("{other:?}"),
    }
}

/// Escape the characters that would break the one-line-per-record format.
///
/// Tabs and newlines in a body/attribute value would split or misalign a
/// record, so they are escaped to literal two-char forms; everything else is
/// kept verbatim (the body is the same text already written to `agaric.log`).
fn sanitize_inline(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
        .replace('\t', "\\t")
}

/// Serialize one OTel `LogRecord` to a single line.
///
/// Format (tab-separated `key=value`):
/// `end=<rfc3339-ms>\tlevel=<severity>\ttrace=<id|->\tspan=<id|->\t`
/// `target=<module-path>\tbody=<message>\t<attr-key>=<attr-val>…`. `trace` /
/// `span` are the active span's ids (`-` when the event fired outside any span)
/// — this is the log↔trace correlation. Bodies/attributes mirror what already
/// goes to `agaric.log`; the same redaction pass that covers the human log
/// (M7) covers this file, for defense-in-depth.
fn format_log_record(record: &SdkLogRecord) -> String {
    use std::fmt::Write as _;

    // Prefer the event time; fall back to the SDK's observed time.
    let end = record
        .timestamp()
        .or_else(|| record.observed_timestamp())
        .map_or_else(
            || "-".to_owned(),
            |t| {
                chrono::DateTime::<chrono::Utc>::from(t)
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
            },
        );

    // Sanitized for uniform line integrity. In practice `level` is an
    // enum-derived severity string and `target` a compile-time module path —
    // neither a realistic injection vector — but routing them through the same
    // escape as `body`/attributes guarantees no field can ever split a record.
    let level = sanitize_inline(record.severity_text().unwrap_or("-"));

    // The correlation fields: the active span's trace + span id, or `-` when the
    // event was emitted outside any span.
    let (trace, span) = match record.trace_context() {
        Some(tc) => (tc.trace_id.to_string(), tc.span_id.to_string()),
        None => ("-".to_owned(), "-".to_owned()),
    };

    // `target` is the tracing event's module path (our source, never user data).
    let target = sanitize_inline(record.target().map_or("-", |t| t.as_ref()));

    let body = record
        .body()
        .map(|b| sanitize_inline(&any_value_to_string(b)))
        .unwrap_or_default();

    let mut line = String::new();
    let _ = write!(
        line,
        "end={end}\tlevel={level}\ttrace={trace}\tspan={span}\ttarget={target}\tbody={body}"
    );
    for (key, value) in record.attributes_iter() {
        let _ = write!(
            line,
            "\t{}={}",
            key,
            sanitize_inline(&any_value_to_string(value))
        );
    }
    line.push('\n');
    line
}

impl LogExporter for FileLogExporter {
    async fn export(&self, batch: LogBatch<'_>) -> OTelSdkResult {
        // Build the full buffer outside the lock, then write under it.
        let mut buf = String::with_capacity(64);
        for (record, _scope) in batch.iter() {
            buf.push_str(&format_log_record(record));
        }
        self.sink.write_buf(&buf);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_file_exporter_creates_traces_subdir() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let exporter = build_file_exporter(tmp.path());
        assert!(exporter.is_some(), "writable dir must yield an exporter");
        assert!(
            tmp.path().join(TRACES_SUBDIR).is_dir(),
            "traces/ subdir must be created under the log dir"
        );
    }

    #[test]
    fn build_file_exporter_degrades_on_unwritable_path() {
        // A path whose parent is a file (not a dir) cannot be created.
        let tmp = tempfile::tempdir().expect("tempdir");
        let file = tmp.path().join("not-a-dir");
        std::fs::write(&file, b"x").expect("write blocker file");
        let exporter = build_file_exporter(&file);
        assert!(
            exporter.is_none(),
            "unwritable traces dir must degrade to None"
        );
    }

    #[test]
    fn build_log_exporter_creates_otel_logs_subdir() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let exporter = build_log_exporter(tmp.path());
        assert!(exporter.is_some(), "writable dir must yield a log exporter");
        assert!(
            tmp.path().join(OTEL_LOGS_SUBDIR).is_dir(),
            "otel-logs/ subdir must be created under the log dir"
        );
    }

    #[test]
    fn build_log_exporter_degrades_on_unwritable_path() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let file = tmp.path().join("not-a-dir");
        std::fs::write(&file, b"x").expect("write blocker file");
        assert!(
            build_log_exporter(&file).is_none(),
            "unwritable otel-logs dir must degrade to None"
        );
    }
}
