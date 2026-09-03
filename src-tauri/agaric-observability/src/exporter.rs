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
//! #3317 — "enforced at the instrumentation sites" was a convention with no
//! mechanism behind it until that issue, and it had already been broken
//! (`import_markdown_with_progress` recorded the user's page title into a
//! `page_title` attribute, which this exporter duly wrote to `traces/*.log`).
//! The mechanism now exists: `agaric::commands::observability`'s
//! `span_fields_stay_on_the_pii_allowlist` test scans every
//! `#[instrument(... fields(...))]` key, every `...span!` inline field (the
//! generic `tracing::span!` and all five `{info,debug,trace,warn,error}_span!`
//! shorthands), and every `<receiver>.record("key", ...)` call in the
//! workspace against an opaque-only allowlist. Both scans are
//! deny-by-default: the `.record` scan does not care what the receiver is
//! named, and skips only an explicit list of receivers confirmed not to be
//! spans. Being a text scan it cannot see a non-literal key or
//! `.record_all(...)`, and it does NOT cover the bridged log records below,
//! whose attributes are arbitrary `tracing` event fields.
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
///
/// Shared with the frontend-span ingestor ([`super::ingest`]) so backend span
/// files and frontend interaction-span files land in the same `traces/` sink
/// and can be joined by `trace_id`.
pub(crate) const TRACES_SUBDIR: &str = "traces";

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
pub(crate) struct RollingFileSink {
    writer: Mutex<RollingFileAppender>,
}

impl RollingFileSink {
    /// Build a sink writing daily-rotated `<log_dir>/<subdir>/<prefix>*` files,
    /// or `None` when the subdir cannot be created or opened (read-only / full
    /// disk). Degrades exactly like `build_log_file_appender` in `lib.rs` —
    /// writes the failure to stderr (never silent) and never panics.
    pub(crate) fn build(log_dir: &Path, subdir: &str, filename_prefix: &str) -> Option<Self> {
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
    pub(crate) fn write_buf(&self, buf: &str) {
        if let Ok(mut w) = self.writer.lock() {
            let _ = w.write_all(buf.as_bytes());
            let _ = w.flush();
        }
    }

    /// Flush any buffered bytes (used by `SpanExporter::force_flush` and the
    /// M6 `FileMetricExporter`'s `force_flush` / `shutdown_with_timeout`).
    pub(crate) fn force_flush(&self) {
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
/// `MAX_OTEL_FILES` retained files. Degrades to `None` (caller skips the
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
///
/// # Sanitization (#3975, #4128)
///
/// The name, every attribute KEY, and every attribute value are routed
/// through [`sanitize_inline`], the same escape [`format_log_record`] applies
/// to its own fields (including its attribute keys), so a `\n`/`\t`/`\\`
/// embedded in any of those positions cannot split or misalign a record —
/// matching that function's "no field can ever split a record" guarantee,
/// which previously held only for logs, not spans (#3975), and which
/// previously excluded attribute keys in both writers (#4128).
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
        name = sanitize_inline(&span.name),
        trace = span.span_context.trace_id(),
        span_id = span.span_context.span_id(),
        status = span.status,
    );
    for kv in &span.attributes {
        let _ = write!(
            line,
            "\t{}={}",
            sanitize_inline(kv.key.as_str()),
            sanitize_inline(&kv.value.as_str())
        );
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
        self.sink.force_flush();
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
/// A tab (the FIELD separator) or a newline (the RECORD separator) in any
/// field — a name, a body, an attribute value, or an attribute KEY (#4128) —
/// would split or misalign a record, so all three of `\n`/`\r`/`\t` are
/// escaped to literal two-char forms; everything else is kept verbatim (the
/// body is the same text already written to `agaric.log`).
///
/// The `\\` replacement MUST stay first, and is not optional. It is what
/// makes the escape INJECTIVE: without it a literal `\` + `n` already in the
/// input would render identically to a real newline, and a reader that
/// unescapes a field could not tell the two apart — the same forgery one
/// layer down. Pinned by
/// `sanitize_inline_is_an_injective_escape_over_every_framing_byte`.
///
/// Deliberately NOT escaped: U+2028/U+2029. No reader of these files treats
/// them as a break — `commands::bug_report`'s `redact_log` splits records
/// with `split_inclusive('\n')` and `redact_kv_line` splits fields with
/// `split('\t')` — so escaping them would alter legitimate body text for no
/// benefit. Covered as an explicit case in
/// `format_span_attribute_key_cannot_forge_a_field_or_a_record`.
pub(crate) fn sanitize_inline(s: &str) -> String {
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
/// goes to `agaric.log`.
///
/// # Redaction (#3317 — this doc used to be wrong)
///
/// It previously claimed "the same redaction pass that covers the human log
/// (M7) covers this file, for defense-in-depth". It did not. The bug-report
/// redactor dispatched per line on "does this parse as JSON?": `agaric.log` is
/// JSON so it took the deny-by-default path, while these tab-separated
/// `key=value` records fell through to a four-needle allow-list that passes all
/// other text verbatim. A `tracing::info!(page = %page_title, …)` that became
/// `[REDACTED]` in `agaric.log` was bundled here in the clear. The bundle now
/// declares this format (`LineFormat::OtelSignal` in `commands::bug_report`)
/// and applies a deny-by-default pass over every VALUE on the line, so the
/// claim holds — but note the file itself is still written verbatim: redaction
/// is a property of the BUNDLE, not of this sink.
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
    // escape as `body`/attributes/attribute-keys (below) guarantees no field
    // can ever split a record.
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
        // #4128: attribute KEYS are `tracing` field names, which are
        // compile-time literals in every reachable caller (`tracing`'s
        // macros accept no other kind), so no untrusted byte reaches this
        // position today. Sanitizing anyway — the same escape already
        // applied to every value on this line — makes the guarantee true
        // unconditionally rather than true-by-caller-discipline: a key built
        // through the exporter's own types (not through `tracing`'s macros)
        // cannot forge a `\n`/`\t`/`\\` into the record framing either.
        let _ = write!(
            line,
            "\t{}={}",
            sanitize_inline(key.as_str()),
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
    use opentelemetry::KeyValue;
    use opentelemetry::trace::{SpanContext, SpanId, SpanKind, Status};
    use opentelemetry_sdk::trace::{SpanEvents, SpanLinks};
    use std::time::SystemTime;

    /// Build a minimal [`SpanData`] fixture with a caller-supplied name and
    /// attribute set; every other field is a harmless default. Mirrors the
    /// literal used by `opentelemetry_sdk`'s own `span_processor` tests.
    fn test_span(name: &'static str, attributes: Vec<KeyValue>) -> SpanData {
        SpanData {
            span_context: SpanContext::empty_context(),
            parent_span_id: SpanId::INVALID,
            parent_span_is_remote: false,
            span_kind: SpanKind::Internal,
            name: name.into(),
            start_time: SystemTime::now(),
            end_time: SystemTime::now(),
            attributes,
            dropped_attributes_count: 0,
            events: SpanEvents::default(),
            links: SpanLinks::default(),
            status: Status::Unset,
            instrumentation_scope: opentelemetry::InstrumentationScope::default(),
        }
    }

    /// #3975 — `format_span` must sanitize the span name and every attribute
    /// value exactly like `format_log_record` does, so a `\n` embedded in
    /// either position cannot forge an extra line in `traces/*.log`.
    ///
    /// This asserts the record's LINE COUNT / exact boundary (one trailing
    /// `\n` and no other), not just that the output parses — a forged line
    /// parses fine, so a parseability assertion would pass whether or not
    /// the bug were fixed. Before the fix, this test fails with the
    /// unsanitized line printed verbatim in the assertion message, which is
    /// itself the forged second record: everything after the embedded `\n`
    /// reads as a second, attacker-authored `end=…` line.
    #[test]
    fn format_span_sanitizes_name_and_attributes_so_a_newline_cannot_forge_a_line() {
        let forged_attr_value = "real-value\nend=2099-01-01T00:00:00.000Z\tname=forged-by-attacker\t\
             trace=deadbeefdeadbeefdeadbeefdeadbeef\tspan=cafebabecafebabe\t\
             parent=-\tdur_ms=0.000\tstatus=Unset";
        let span = test_span(
            "legit.span\nname=forged-by-attacker",
            vec![KeyValue::new("evil", forged_attr_value)],
        );

        let line = format_span(&span);

        // format_span always appends exactly one trailing '\n'. If the name
        // or an attribute value carries an unsanitized '\n', it adds another
        // — collapsing the record's own line-terminator count is exactly
        // what "no field can ever split a record" means in practice.
        let newline_count = line.matches('\n').count();
        assert_eq!(
            newline_count, 1,
            "a `\\n` in a span name or attribute value must not forge an \
             extra record line in traces/*.log; got:\n{line}"
        );

        // Sanitization must escape, not silently drop, the offending bytes:
        // the literal two-char form is still present in the single line.
        assert!(
            line.contains("legit.span\\nname=forged-by-attacker"),
            "span name's embedded newline must be escaped to `\\n`, not \
             dropped or left raw; got:\n{line}"
        );
        assert!(
            line.contains("real-value\\nend=2099"),
            "attribute value's embedded newline must be escaped to `\\n`, \
             not dropped or left raw; got:\n{line}"
        );
    }

    /// #4128 — attribute KEYS were the one field neither writer sanitized,
    /// despite the doc comment on [`format_log_record`] claiming "no field
    /// can ever split a record". Not reachable through `tracing`'s macros
    /// (a `#[instrument(fields(...))]`/`info_span!` field name is a
    /// compile-time literal there), so this builds the `SpanData` directly —
    /// exactly like [`test_span`] above already does — to test the writer
    /// itself, independent of whether any caller can reach it.
    #[test]
    fn format_span_sanitizes_attribute_keys_so_a_newline_cannot_forge_a_line() {
        let forged_key = "evil\nend=2099-01-01T00:00:00.000Z\tname=forged-by-attacker\t\
             trace=deadbeefdeadbeefdeadbeefdeadbeef\tspan=cafebabecafebabe\t\
             parent=-\tdur_ms=0.000\tstatus=Unset";
        let span = test_span(
            "legit.span",
            vec![KeyValue::new(forged_key.to_owned(), "harmless-value")],
        );

        let line = format_span(&span);

        let newline_count = line.matches('\n').count();
        assert_eq!(
            newline_count, 1,
            "a `\\n` in an attribute KEY must not forge an extra record \
             line in traces/*.log; got:\n{line}"
        );
        assert!(
            line.contains("evil\\nend=2099"),
            "attribute key's embedded newline must be escaped to `\\n`, not \
             dropped or left raw; got:\n{line}"
        );

        // Round trip: a downstream reader splits the single line on `\t` and
        // treats each `key=value` piece as one field. A forged key that
        // reproduced a legitimate-looking second record would show up here
        // as an extra `name=` field alongside the real one.
        let forged_field_count = line
            .trim_end_matches('\n')
            .split('\t')
            .filter(|field| field.starts_with("name="))
            .count();
        assert_eq!(
            forged_field_count, 1,
            "an attribute key must never contribute a second `name=` field \
             once escaped, or a downstream parser could read the forged key \
             as a second legitimate record; got:\n{line}"
        );
    }

    /// #4128 — the same defect and fix as
    /// `format_span_sanitizes_attribute_keys_so_a_newline_cannot_forge_a_line`,
    /// for [`format_log_record`]. `tracing`'s field-name literals mean no
    /// caller can reach this through the normal logging API either, so the
    /// record is built through the exporter's own types instead of a
    /// `tracing::error!`: `SdkLoggerProvider::logger` + `create_log_record`
    /// gives a real [`SdkLogRecord`], and `LogRecord::add_attribute` accepts
    /// any `Into<Key>` — including a runtime `String`, which `tracing`'s
    /// macros could never produce for a field name.
    #[test]
    fn format_log_record_sanitizes_attribute_keys_so_a_newline_cannot_forge_a_line() {
        use opentelemetry::logs::{AnyValue, LogRecord as _, Logger as _, LoggerProvider as _};
        use opentelemetry_sdk::logs::SdkLoggerProvider;

        let provider = SdkLoggerProvider::builder().build();
        let logger = provider.logger("test");
        let mut record = logger.create_log_record();
        record.set_body(AnyValue::from("legit body"));
        let forged_key = "evil\nend=2099-01-01T00:00:00.000Z\tlevel=ERROR\ttrace=-\tspan=-\t\
             target=forged\tbody=forged-by-attacker";
        record.add_attribute(forged_key.to_owned(), "harmless-value");

        let line = format_log_record(&record);

        // format_log_record always appends exactly one trailing '\n'. If an
        // attribute key carries an unsanitized '\n', it adds another —
        // collapsing the record's own line-terminator count is exactly what
        // "no field can ever split a record" means in practice.
        let newline_count = line.matches('\n').count();
        assert_eq!(
            newline_count, 1,
            "a `\\n` in an attribute KEY must not forge an extra record \
             line in otel-logs/*.log; got:\n{line}"
        );
        assert!(
            line.contains("evil\\nend=2099"),
            "attribute key's embedded newline must be escaped to `\\n`, not \
             dropped or left raw; got:\n{line}"
        );

        // Round trip: a downstream reader splits the single line on `\t` and
        // treats each `key=value` piece as one field. A forged key that
        // reproduced a legitimate-looking second record would show up here
        // as an extra `end=` field alongside the real one.
        let forged_field_count = line
            .trim_end_matches('\n')
            .split('\t')
            .filter(|field| field.starts_with("end="))
            .count();
        assert_eq!(
            forged_field_count, 1,
            "an attribute key must never contribute a second `end=` field \
             once escaped, or a downstream parser could read the forged key \
             as a second legitimate record; got:\n{line}"
        );
    }

    /// Undo [`sanitize_inline`]. Only meaningful if the escape is injective,
    /// which is exactly what
    /// `sanitize_inline_is_an_injective_escape_over_every_framing_byte` uses
    /// it to establish.
    fn unescape_inline(s: &str) -> String {
        let mut out = String::with_capacity(s.len());
        let mut chars = s.chars();
        while let Some(c) = chars.next() {
            if c != '\\' {
                out.push(c);
                continue;
            }
            match chars.next() {
                Some('\\') => out.push('\\'),
                Some('n') => out.push('\n'),
                Some('r') => out.push('\r'),
                Some('t') => out.push('\t'),
                // Not an escape this function emits; keep both chars so the
                // helper is total rather than lossy.
                Some(other) => {
                    out.push('\\');
                    out.push(other);
                }
                None => out.push('\\'),
            }
        }
        out
    }

    /// #4128 — "handles `\n`" is not the property that matters; INJECTIVITY
    /// is.
    ///
    /// Rendering a real newline as the two characters `\` + `n` is only safe
    /// if a literal `\` + `n` already in the input is *also* escaped.
    /// Otherwise the two collide, and a reader that unescapes a field to
    /// recover the original text cannot tell an attacker's literal `\n` text
    /// from a newline the writer escaped — the same forgery, one layer down,
    /// in whatever tool reads the bundle. [`sanitize_inline`] escapes `\`
    /// FIRST and only then the three framing bytes, which makes the mapping
    /// injective; reordering those `.replace` calls, or dropping the
    /// backslash rule, reddens the round trip below.
    #[test]
    fn sanitize_inline_is_an_injective_escape_over_every_framing_byte() {
        // The four bytes that can break framing, each to its own two-char form.
        assert_eq!(sanitize_inline("\\"), r"\\");
        assert_eq!(sanitize_inline("\n"), r"\n");
        assert_eq!(sanitize_inline("\r"), r"\r");
        assert_eq!(sanitize_inline("\t"), r"\t");

        // The collision: a literal backslash-n must not render identically to
        // a real newline.
        assert_ne!(
            sanitize_inline(r"a\nb"),
            sanitize_inline("a\nb"),
            "a literal `\\n` in the input must not render the same as a real \
             newline, or an unescaping reader cannot distinguish them"
        );

        // Round trip over a corpus that mixes framing bytes, literal escape
        // sequences, and non-ASCII text. `\u{2028}`/`\u{2029}` are included
        // deliberately: they are NOT escaped, and must survive verbatim —
        // see `format_span_attribute_key_cannot_forge_a_field_or_a_record`
        // for why they are not framing bytes for any reader of these files.
        for original in [
            "",
            "plain",
            r"a\nb",
            "a\nb",
            "\t",
            "\r\n",
            "\\",
            r"\\n",
            "mixed \\t\treal-tab",
            "\u{2028}\u{2029}",
            "unicodé ✓",
            "trailing backslash \\",
        ] {
            let escaped = sanitize_inline(original);
            assert_eq!(
                unescape_inline(&escaped),
                original,
                "sanitize_inline must round-trip {original:?} (escaped: {escaped:?}); \
                 a non-injective escape lets a literal escape sequence in the input \
                 impersonate an escaped framing byte"
            );
        }
    }

    /// Hostile attribute keys, each paired with what it is trying to do.
    ///
    /// #4128's acceptance is "no forged record", but a tab-separated
    /// `key=value` format has TWO separators, and only one of them is the
    /// newline. A `\t` in a key forges an extra FIELD rather than an extra
    /// record — invisible to a record-count assertion, and enough to shift
    /// every later field's position, which is what
    /// `commands::bug_report::redact_kv_line`'s POSITIONAL skeleton
    /// allowance keys off. Hence the field-count assertions below alongside
    /// the record-count ones.
    const HOSTILE_ATTRIBUTE_KEYS: &[(&str, &str)] = &[
        (
            "\tname=forged\tdur_ms=0.000",
            "a TAB forges extra FIELDS, shifting every later field's position",
        ),
        (
            "\nend=2099-01-01T00:00:00.000Z\tname=forged",
            "an LF forges an extra record",
        ),
        (
            "\r\nend=2099-01-01T00:00:00.000Z\tname=forged",
            "a CRLF forges an extra record for a CRLF-splitting reader",
        ),
        (
            "\rname=forged",
            "a lone CR rewrites the visible line on a terminal",
        ),
        (
            r"k\nend=2099-01-01T00:00:00.000Z",
            "a LITERAL backslash-n, colliding with the escape for a real newline",
        ),
        ("", "an empty key"),
        ("   ", "an all-whitespace key"),
        (
            "has=equals=everywhere",
            "a key carrying the intra-field `key=value` separator",
        ),
        (
            "\u{2028}end=2099-01-01T00:00:00.000Z",
            "U+2028 LINE SEPARATOR, in case a reader treats it as a break",
        ),
        (
            "\u{2029}end=2099-01-01T00:00:00.000Z",
            "U+2029 PARAGRAPH SEPARATOR, likewise",
        ),
        ("\\", "a bare trailing backslash"),
    ];

    /// #4128, widened — an attribute KEY must not be able to forge a record
    /// OR a field in `traces/*.log`, whatever it contains.
    ///
    /// `format_span` writes a fixed 7-field skeleton
    /// (`end name trace span parent dur_ms status`) and then one field per
    /// attribute, so exactly one attribute means exactly 8 fields and exactly
    /// one line terminator, for every possible key. That pair of counts is
    /// the whole structural guarantee; anything that changes either is a
    /// forgery, whether it split the record or only misaligned it.
    ///
    /// On U+2028/U+2029: they are deliberately NOT escaped, and the counts
    /// below are still the right assertion. The only reader of these files is
    /// `commands::bug_report`, whose `redact_log` splits records with
    /// `split_inclusive('\n')` and whose `redact_kv_line` splits fields with
    /// `split('\t')` — neither treats a Unicode separator as a break, and
    /// Rust's `str::lines()` does not either. Escaping them would change
    /// legitimate body text for no reader's benefit. If a reader that splits
    /// on them is ever added, these cases are already here to be re-pointed.
    #[test]
    fn format_span_attribute_key_cannot_forge_a_field_or_a_record() {
        // 7 skeleton fields + 1 attribute field.
        const EXPECTED_FIELDS: usize = 8;

        let long_key = format!("{}\nend=2099-01-01T00:00:00.000Z", "A".repeat(16 * 1024));
        let cases = HOSTILE_ATTRIBUTE_KEYS
            .iter()
            .map(|(key, intent)| ((*key).to_owned(), *intent))
            .chain(std::iter::once((
                long_key,
                "a very long key, to check length alone changes no invariant",
            )));

        for (key, intent) in cases {
            let span = test_span("legit.span", vec![KeyValue::new(key.clone(), "safe-value")]);
            let line = format_span(&span);
            let body = line
                .strip_suffix('\n')
                .expect("format_span always terminates the record with exactly one LF");

            assert!(
                !body.contains('\n'),
                "attribute key {key:?} ({intent}) forged an extra RECORD in traces/*.log; \
                 got:\n{line}"
            );
            assert!(
                !body.contains('\r'),
                "attribute key {key:?} ({intent}) left a raw CR in the record; a CR-splitting \
                 or terminal reader sees a forged line; got:\n{line}"
            );
            assert_eq!(
                body.split('\t').count(),
                EXPECTED_FIELDS,
                "attribute key {key:?} ({intent}) changed the FIELD count of a one-attribute \
                 span record; every later field's position shifts, and \
                 `bug_report::redact_kv_line` allows skeleton values POSITIONALLY; got:\n{line}"
            );
            assert!(
                body.contains(&sanitize_inline(&key)),
                "attribute key {key:?} ({intent}) must appear ESCAPED, not dropped or \
                 truncated; got:\n{line}"
            );
        }
    }

    /// #4128, widened — the same structural guarantee for
    /// [`format_log_record`] (`otel-logs/*.log`), whose skeleton is 6 fields
    /// (`end level trace span target body`), so one attribute means exactly
    /// 7 fields and exactly one line terminator.
    #[test]
    fn format_log_record_attribute_key_cannot_forge_a_field_or_a_record() {
        use opentelemetry::logs::{AnyValue, LogRecord as _, Logger as _, LoggerProvider as _};
        use opentelemetry_sdk::logs::SdkLoggerProvider;

        // 6 skeleton fields + 1 attribute field.
        const EXPECTED_FIELDS: usize = 7;

        let provider = SdkLoggerProvider::builder().build();
        let logger = provider.logger("test");

        let long_key = format!("{}\nend=2099-01-01T00:00:00.000Z", "A".repeat(16 * 1024));
        let cases = HOSTILE_ATTRIBUTE_KEYS
            .iter()
            .map(|(key, intent)| ((*key).to_owned(), *intent))
            .chain(std::iter::once((
                long_key,
                "a very long key, to check length alone changes no invariant",
            )));

        for (key, intent) in cases {
            let mut record = logger.create_log_record();
            record.set_body(AnyValue::from("legit body"));
            record.add_attribute(key.clone(), "safe-value");

            let line = format_log_record(&record);
            let body = line
                .strip_suffix('\n')
                .expect("format_log_record always terminates the record with exactly one LF");

            assert!(
                !body.contains('\n'),
                "attribute key {key:?} ({intent}) forged an extra RECORD in otel-logs/*.log; \
                 got:\n{line}"
            );
            assert!(
                !body.contains('\r'),
                "attribute key {key:?} ({intent}) left a raw CR in the record; got:\n{line}"
            );
            assert_eq!(
                body.split('\t').count(),
                EXPECTED_FIELDS,
                "attribute key {key:?} ({intent}) changed the FIELD count of a one-attribute \
                 log record; got:\n{line}"
            );
            assert!(
                body.contains(&sanitize_inline(&key)),
                "attribute key {key:?} ({intent}) must appear ESCAPED, not dropped; got:\n{line}"
            );
        }
    }

    /// The one string-bearing field in [`format_span`] that is NOT routed
    /// through [`sanitize_inline`]: `status={status:?}`.
    ///
    /// The review question behind #4128 is "is the escape applied at EVERY
    /// write site", and the honest answer for this field is "no, and it does
    /// not need to be" — `Status::Error`'s description is rendered by the
    /// derived `Debug`, which goes through `str`'s `Debug` and escapes
    /// `\n`/`\r`/`\t`/`\\`/`"` itself. Nothing in this workspace calls
    /// `set_status`, so the value is `Unset` in production; the exemption is
    /// therefore a property of the FORMATTER, not of the caller set, and
    /// this pins it. Rendering the description any other way (a `Display`
    /// impl, or interpolating `description` directly) reddens this.
    #[test]
    fn format_span_status_description_cannot_split_a_record() {
        let mut span = test_span("legit.span", vec![]);
        span.status = Status::error(
            "boom\nend=2099-01-01T00:00:00.000Z\tname=forged-by-attacker\tstatus=Unset",
        );

        let line = format_span(&span);
        let body = line
            .strip_suffix('\n')
            .expect("format_span always terminates the record with exactly one LF");

        assert!(
            !body.contains('\n'),
            "a `\\n` in a span status description must not forge an extra record; got:\n{line}"
        );
        // 7 skeleton fields, no attributes.
        assert_eq!(
            body.split('\t').count(),
            7,
            "a `\\t` in a span status description must not forge an extra field; got:\n{line}"
        );
    }

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
