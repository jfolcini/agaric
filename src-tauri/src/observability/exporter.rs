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
use opentelemetry_sdk::trace::{SpanData, SpanExporter};
use tracing_appender::rolling::{RollingFileAppender, Rotation};

/// Maximum number of rotated trace files to retain.
///
/// Mirrors the 14-file daily-rotation policy used for `agaric.log` in
/// `build_log_file_appender`, so traces never grow the on-disk footprint
/// unbounded between boots.
const MAX_TRACE_FILES: usize = 14;

/// Subdirectory of the log directory that holds rotated trace files.
const TRACES_SUBDIR: &str = "traces";

/// A local-file [`SpanExporter`]: serializes each batch of spans as one
/// human-readable line per span into a daily-rotated file.
///
/// The inner appender is wrapped in a `Mutex` because the SDK calls `export`
/// from a dedicated batch worker; the mutex makes writes atomic per batch and
/// keeps the type `Send + Sync` (required by the trait) without an async lock.
pub struct FileSpanExporter {
    writer: Mutex<RollingFileAppender>,
}

impl std::fmt::Debug for FileSpanExporter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("FileSpanExporter")
    }
}

/// Build the on-disk trace exporter, or `None` if the traces dir is unwritable.
///
/// Creates `<log_dir>/traces/` and a daily `RollingFileAppender` capped at
/// [`MAX_TRACE_FILES`] retained files. Degrades to `None` (caller skips the
/// pipeline) on any filesystem error — never panics, mirroring
/// `build_log_file_appender`.
pub fn build_file_exporter(log_dir: &Path) -> Option<FileSpanExporter> {
    let traces_dir = log_dir.join(TRACES_SUBDIR);

    if let Err(e) = std::fs::create_dir_all(&traces_dir) {
        // Pre/parallel to the tracing subscriber; write to stderr directly so
        // the failure is never silent, exactly like the log-dir degrade path.
        eprintln!(
            "agaric: could not create traces directory {}: {e}; \
             OpenTelemetry traces disabled for this run",
            traces_dir.display()
        );
        return None;
    }

    match RollingFileAppender::builder()
        .rotation(Rotation::DAILY)
        .max_log_files(MAX_TRACE_FILES)
        .filename_prefix("agaric-traces.log")
        .build(&traces_dir)
    {
        Ok(appender) => Some(FileSpanExporter {
            writer: Mutex::new(appender),
        }),
        Err(e) => {
            eprintln!(
                "agaric: could not open trace file in {}: {e}; \
                 OpenTelemetry traces disabled for this run",
                traces_dir.display()
            );
            None
        }
    }
}

/// Serialize one span to a single line.
///
/// Format (tab-separated): `<rfc3339-end> <name> trace=<id> span=<id>
/// parent=<id|->  dur_ms=<f> status=<…> { <key>=<val> … }`. Only opaque ids,
/// op-types, counts, durations, and the attribute key/values the
/// instrumentation chose to attach appear — there is no app content here.
fn format_span(span: &SpanData) -> String {
    use std::fmt::Write as _;

    let dur_ms = span
        .end_time
        .duration_since(span.start_time)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(f64::NAN);

    let parent = if span.parent_span_id == opentelemetry::SpanId::INVALID {
        "-".to_owned()
    } else {
        span.parent_span_id.to_string()
    };

    let mut line = String::new();
    let _ = write!(
        line,
        "name={name}\ttrace={trace}\tspan={span_id}\tparent={parent}\tdur_ms={dur_ms:.3}\tstatus={status:?}",
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
        if let Ok(mut w) = self.writer.lock() {
            // A write failure to the local file is non-fatal: degrade silently
            // for the rest of the run rather than poison the batch worker.
            let _ = w.write_all(buf.as_bytes());
            let _ = w.flush();
        }
        Ok(())
    }

    fn force_flush(&self) -> OTelSdkResult {
        if let Ok(mut w) = self.writer.lock() {
            let _ = w.flush();
        }
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
}
