//! On-disk metric exporter (#2110, M6) — the ONLY module that knows the
//! metrics file format.
//!
//! # Zero egress (hard invariant)
//!
//! Metric data points are serialized to a LOCAL FILE under
//! `<log_dir>/metrics/` and nothing else, exactly like the M1 span + log
//! exporters. There is deliberately no network metric exporter anywhere in
//! this crate (`opentelemetry-otlp` and every HTTP/gRPC exporter are
//! intentionally absent from `Cargo.toml`). The app's "nothing leaves your
//! machine" promise plus its CSP forbid any outbound connection, so this
//! exporter is the single sink and it only ever touches the filesystem.
//!
//! # Swappable behind the `PushMetricExporter` trait
//!
//! [`FileMetricExporter`] implements
//! `opentelemetry_sdk::metrics::exporter::PushMetricExporter`. The
//! line-per-data-point text format below is intentionally simple, mirroring
//! the span/log line format so all three signals read alike in the local sink.
//! A future, stricter OTLP/JSON *file* exporter can replace this type wholesale
//! without touching `metrics.rs`, `guard.rs`, or `mod.rs` — they depend only on
//! the trait, not on the format.
//!
//! # PII discipline
//!
//! This exporter writes whatever instruments + attributes the SDK hands it.
//! Keeping content, query strings, tag names, and property values OUT of
//! metrics is enforced at the *instrumentation* sites (the instrument names +
//! attribute keys chosen in [`super::metrics`]), never here: every metric this
//! pipeline emits carries only opaque counts, durations, and command *names*
//! (which are compile-time identifiers, not user data). The format below
//! additionally routes every serialized value through
//! [`super::exporter::sanitize_inline`] so no value can ever split or misalign
//! a line — the same defense-in-depth the M1b log exporter applies.
//!
//! # Graceful degradation
//!
//! [`build_metric_exporter`] returns `None` when `<log_dir>/metrics/` cannot be
//! created or opened (read-only / full disk), exactly like
//! [`super::exporter::build_file_exporter`]. The caller then skips just the
//! metrics pipeline and the app keeps running with traces + logs (each on its
//! own sink) and normal logging.

use std::time::Duration;

use opentelemetry_sdk::error::OTelSdkResult;
use opentelemetry_sdk::metrics::Temporality;
use opentelemetry_sdk::metrics::data::{
    AggregatedMetrics, HistogramDataPoint, Metric, MetricData, ResourceMetrics, SumDataPoint,
};
use opentelemetry_sdk::metrics::exporter::PushMetricExporter;

use super::exporter::{RollingFileSink, sanitize_inline};

/// Subdirectory of the log directory that holds rotated metric data-point
/// files (M6). Kept separate from `traces/` (spans), `otel-logs/` (M1b log
/// records), and the human-readable `agaric.log`, so each OTel signal is its
/// own rotated, independently-degrading stream.
const METRICS_SUBDIR: &str = "metrics";

/// A local-file [`PushMetricExporter`]: serializes each exported
/// `ResourceMetrics` batch as one human-readable line per data point into a
/// daily-rotated `metrics/` file.
pub struct FileMetricExporter {
    sink: RollingFileSink,
}

impl std::fmt::Debug for FileMetricExporter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("FileMetricExporter")
    }
}

/// Build the on-disk metric exporter, or `None` if `metrics/` is unwritable.
///
/// Creates `<log_dir>/metrics/` with a daily `RollingFileAppender` (the shared
/// [`RollingFileSink`], same retention cap as the trace + log sinks). Degrades
/// to `None` (caller skips the metrics pipeline) on any filesystem error —
/// never panics, mirroring [`super::exporter::build_file_exporter`].
pub fn build_metric_exporter(log_dir: &std::path::Path) -> Option<FileMetricExporter> {
    RollingFileSink::build(log_dir, METRICS_SUBDIR, "agaric-metrics.log")
        .map(|sink| FileMetricExporter { sink })
}

impl FileMetricExporter {
    /// Serialize one `ResourceMetrics` batch to a buffer of newline-terminated
    /// lines (one per data point) and write it under the sink lock.
    ///
    /// Walks `scope_metrics → metrics → AggregatedMetrics` and dispatches each
    /// `Metric` on its aggregation kind: `Sum` (the observable counters) and
    /// `Histogram` (the latency instruments) are the only kinds this pipeline
    /// produces, so `Gauge` / `ExponentialHistogram` are skipped rather than
    /// guessed at. Resource attributes are not re-emitted per line — they are
    /// constant for the run (`service.name` / `service.version`, see
    /// [`super::provider::resource`]) and already documented at boot.
    fn export_to_buf(metrics: &ResourceMetrics) -> String {
        let mut buf = String::new();
        for scope in metrics.scope_metrics() {
            for metric in scope.metrics() {
                Self::format_metric(&mut buf, metric);
            }
        }
        buf
    }

    /// Serialize one [`Metric`] (all of its data points) into `out`.
    fn format_metric(out: &mut String, metric: &Metric) {
        let name = metric.name();
        match metric.data() {
            AggregatedMetrics::U64(data) => Self::format_metric_data(out, name, data),
            AggregatedMetrics::I64(data) => Self::format_metric_data(out, name, data),
            AggregatedMetrics::F64(data) => Self::format_metric_data(out, name, data),
        }
    }

    /// Dispatch one typed [`MetricData`] on its aggregation kind.
    ///
    /// Only `Sum` (observable counters) and `Histogram` (latency instruments)
    /// are emitted by this pipeline; `Gauge` and `ExponentialHistogram` are
    /// deliberately ignored (no instrument here produces them).
    fn format_metric_data<T: Copy + std::fmt::Display>(
        out: &mut String,
        name: &str,
        data: &MetricData<T>,
    ) {
        // Each exported batch shares the collection `time` across its points;
        // it is the natural, human-readable timestamp the line is keyed on,
        // mirroring `end=` on the span/log lines.
        match data {
            MetricData::Sum(sum) => {
                let end = rfc3339_ms(sum.time());
                for point in sum.data_points() {
                    write_sum_line(out, name, &end, point);
                }
            }
            MetricData::Histogram(hist) => {
                let end = rfc3339_ms(hist.time());
                for point in hist.data_points() {
                    write_histogram_line(out, name, &end, point);
                }
            }
            // No instrument in this pipeline produces a Gauge or an
            // ExponentialHistogram; skip rather than serialize a shape that
            // can never appear (keeps the format honest).
            MetricData::Gauge(_) | MetricData::ExponentialHistogram(_) => {}
        }
    }
}

/// Format a `SystemTime` as RFC-3339 (UTC, millis) — the leading,
/// human-readable timestamp each metric line is keyed on, identical to the
/// `end=` field on the span + log lines.
fn rfc3339_ms(time: std::time::SystemTime) -> String {
    chrono::DateTime::<chrono::Utc>::from(time).to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Append a `cmd=`-style attribute tail for one data point's attributes.
///
/// Every key + value is routed through [`sanitize_inline`] so a tab/newline can
/// never split the line. The only attribute this pipeline attaches in practice
/// is `cmd=<command-name>` (a compile-time IPC identifier, never user data).
fn write_attrs<'a>(line: &mut String, attrs: impl Iterator<Item = &'a opentelemetry::KeyValue>) {
    use std::fmt::Write as _;
    for kv in attrs {
        let _ = write!(
            line,
            "\t{}={}",
            sanitize_inline(kv.key.as_str()),
            sanitize_inline(&kv.value.to_string())
        );
    }
}

/// Serialize one `Sum` data point (an observable counter sample) to one line:
/// `end=<rfc3339-ms>\tmetric=<name>\tsum=<value>\t<attr=val>…`.
fn write_sum_line<T: Copy + std::fmt::Display>(
    out: &mut String,
    name: &str,
    end: &str,
    point: &SumDataPoint<T>,
) {
    use std::fmt::Write as _;
    let mut line = String::new();
    let _ = write!(
        line,
        "end={end}\tmetric={metric}\tsum={value}",
        metric = sanitize_inline(name),
        value = point.value(),
    );
    write_attrs(&mut line, point.attributes());
    line.push('\n');
    out.push_str(&line);
}

/// Serialize one `Histogram` data point (a latency sample) to one line:
/// `end=<rfc3339-ms>\tmetric=<name>\tcount=<n>\tsum=<s>\tmin=<m>\tmax=<M>\t`
/// `<attr=val>…`. The per-bucket boundaries/counts are intentionally omitted
/// from this human-readable summary line; `min`/`max` are `-` before the first
/// recorded value.
fn write_histogram_line<T: Copy + std::fmt::Display>(
    out: &mut String,
    name: &str,
    end: &str,
    point: &HistogramDataPoint<T>,
) {
    use std::fmt::Write as _;
    let min = point
        .min()
        .map_or_else(|| "-".to_owned(), |m| m.to_string());
    let max = point
        .max()
        .map_or_else(|| "-".to_owned(), |m| m.to_string());
    let mut line = String::new();
    let _ = write!(
        line,
        "end={end}\tmetric={metric}\tcount={count}\tsum={sum}\tmin={min}\tmax={max}",
        metric = sanitize_inline(name),
        count = point.count(),
        sum = point.sum(),
    );
    write_attrs(&mut line, point.attributes());
    line.push('\n');
    out.push_str(&line);
}

impl PushMetricExporter for FileMetricExporter {
    async fn export(&self, metrics: &ResourceMetrics) -> OTelSdkResult {
        // Build the full buffer outside the lock, then write under it.
        let buf = Self::export_to_buf(metrics);
        if !buf.is_empty() {
            self.sink.write_buf(&buf);
        }
        Ok(())
    }

    fn force_flush(&self) -> OTelSdkResult {
        self.sink.force_flush();
        Ok(())
    }

    fn shutdown_with_timeout(&self, _timeout: Duration) -> OTelSdkResult {
        // The local file sink holds no background resource of its own (the
        // `PeriodicReader`'s collector thread is owned + joined by the
        // provider), so shutdown is just a final flush. Never fails.
        self.sink.force_flush();
        Ok(())
    }

    fn temporality(&self) -> Temporality {
        // Cumulative: the observable counters mirror monotonic process-global
        // atomics (a cumulative total since boot), and cumulative is the
        // simplest, most faithful temporality for a local file the operator
        // reads directly (each line is the running total, not a per-interval
        // delta). This is also the SDK default.
        Temporality::Cumulative
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use opentelemetry::metrics::MeterProvider as _;
    use opentelemetry_sdk::metrics::{PeriodicReader, SdkMeterProvider};

    /// The exporter creates its `metrics/` subdir on build, mirroring the
    /// span/log exporters' subdir creation.
    #[test]
    fn build_metric_exporter_creates_metrics_subdir() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let exporter = build_metric_exporter(tmp.path());
        assert!(
            exporter.is_some(),
            "writable dir must yield a metric exporter"
        );
        assert!(
            tmp.path().join(METRICS_SUBDIR).is_dir(),
            "metrics/ subdir must be created under the log dir"
        );
    }

    /// Graceful degradation: an unwritable `metrics/` path yields `None`, so the
    /// caller skips just the metrics pipeline (same as the span/log exporters).
    #[test]
    fn build_metric_exporter_degrades_on_unwritable_path() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let file = tmp.path().join("not-a-dir");
        std::fs::write(&file, b"x").expect("write blocker file");
        assert!(
            build_metric_exporter(&file).is_none(),
            "unwritable metrics dir must degrade to None"
        );
    }

    /// End-to-end: an observable counter exported through the real
    /// `FileMetricExporter` (driven by a `PeriodicReader` + `force_flush`)
    /// writes a `metric=<name>` line carrying the observed `sum=` value to the
    /// on-disk `metrics/` file.
    #[test]
    fn file_exporter_writes_counter_line() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let exporter = build_metric_exporter(tmp.path()).expect("exporter");
        let reader = PeriodicReader::builder(exporter).build();
        let provider = SdkMeterProvider::builder().with_reader(reader).build();

        let meter = provider.meter("agaric");
        let _counter = meter
            .u64_observable_counter("agaric.materializer.sql_only_fallback")
            .with_callback(|observer| observer.observe(7, &[]))
            .build();

        // force_flush triggers one collection (firing the callback) + export.
        provider.force_flush().expect("force_flush");

        // Read whatever rolled file the appender created under metrics/.
        let metrics_dir = tmp.path().join(METRICS_SUBDIR);
        let contents: String = std::fs::read_dir(&metrics_dir)
            .expect("read metrics dir")
            .filter_map(Result::ok)
            .map(|e| std::fs::read_to_string(e.path()).unwrap_or_default())
            .collect();

        assert!(
            contents.contains("metric=agaric.materializer.sql_only_fallback"),
            "metrics file must carry the counter's metric name line; got:\n{contents}"
        );
        assert!(
            contents.contains("sum=7"),
            "metrics file must carry the observed counter value; got:\n{contents}"
        );
    }
}
