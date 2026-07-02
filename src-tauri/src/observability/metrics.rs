//! The OTel metrics provider + instruments (#2110, M6).
//!
//! [`build_meter_provider`] owns an [`SdkMeterProvider`] driving a
//! **`PeriodicReader`** (a `std::thread` + `mpsc` collector that calls the
//! exporter via `futures_executor::block_on` — no async runtime, so the M1
//! "no rt-tokio / thread-based" posture holds for metrics too) around the
//! local-file [`FileMetricExporter`]. It tags every metric with the SAME
//! [`super::provider::resource`] as the trace + logs providers, so a span, its
//! correlated logs, and the metrics of the same run agree on `service.name` /
//! `service.version`.
//!
//! [`register_instruments`] registers the **observable counters** that read the
//! existing process-global materializer atomics on each collection cycle, plus
//! the two **latency histograms** (`record_ipc_duration` /
//! `record_op_apply_duration`), which it builds from the OWNED provider so they
//! bind to the real meter regardless of global-set ordering (#2275 — a lazy
//! `opentelemetry::global::meter` lookup on first record could otherwise pin the
//! default no-op meter forever if a record fired before `init`).
//! `record_op_apply_duration` is unconditional but no-ops until the histograms
//! are installed: when no meter provider is registered (observability off — the
//! default) the record helpers simply return. `record_ipc_duration` goes one
//! step further and is gated on
//! the process-global [`ipc_metrics_enabled`] flag, so its per-invoke `cmd`
//! `KeyValue` allocation (and the matching command-name clone in the `lib.rs`
//! invoke wrapper) are skipped entirely when off — the IPC hot path then pays
//! only one relaxed atomic load rather than a record into the no-op meter.
//!
//! # PII discipline
//!
//! Every instrument here is PII-safe by construction. The observable counters
//! expose only opaque process-global counts (`u64` totals). The histograms
//! carry only a millisecond `f64` and a `cmd` attribute, where `cmd` is the IPC
//! command *name* — a compile-time identifier, never user data. There is no
//! content, query string, tag name, or property value anywhere in this module.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use opentelemetry::KeyValue;
use opentelemetry::metrics::{Histogram, MeterProvider as _};
use opentelemetry_sdk::metrics::{PeriodicReader, SdkMeterProvider};

use super::config::ObservabilityConfig;
use super::metrics_exporter::FileMetricExporter;
use super::provider::resource;

/// Export interval for the metrics `PeriodicReader`.
///
/// 30s balances freshness (the operator reading the local file sees recent
/// counts) against write volume (a line per data point every cycle). The M6
/// instruments are low-cardinality, so this is a tiny periodic write.
const EXPORT_INTERVAL: Duration = Duration::from_secs(30);

/// Instrumentation-scope name for the meter this module hands out — the same
/// `"agaric"` scope the tracer + logger use, so all three signals share a
/// scope in the local sink.
const METER_SCOPE: &str = "agaric";

/// Build an [`SdkMeterProvider`] from `config` and an owned `exporter`.
///
/// Wraps the exporter in a [`PeriodicReader`] (background collector thread, no
/// async runtime) at [`EXPORT_INTERVAL`] and stamps the same
/// [`resource`] as the trace + logs providers. `config` is accepted for
/// symmetry with [`super::provider::build_tracer_provider`] and so a future
/// metrics-specific knob (e.g. interval override) has a home; today the only
/// gate that matters — whether to build this at all — is checked by the caller
/// ([`super::init`]) against `config.enabled`, exactly like the trace pipeline.
#[must_use]
pub fn build_meter_provider(
    _config: &ObservabilityConfig,
    exporter: FileMetricExporter,
) -> SdkMeterProvider {
    let reader = PeriodicReader::builder(exporter)
        .with_interval(EXPORT_INTERVAL)
        .build();

    SdkMeterProvider::builder()
        .with_resource(resource())
        .with_reader(reader)
        .build()
}

/// Register the M6 observable counters on `meter_provider`.
///
/// Each observable counter carries a collection callback that reads the
/// matching process-global atomic and `observe`s its current value. The
/// callbacks fire on the `PeriodicReader`'s collection cycle (every
/// [`EXPORT_INTERVAL`]); they are cheap relaxed atomic loads with no locking.
///
/// The returned [`ObservableCounter`]s are *not* stored: registering the
/// callback is the whole job, and the SDK keeps the instrument alive inside the
/// provider for the provider's lifetime. The caller hands the provider to the
/// shutdown guard, which is what keeps the callbacks running.
///
/// # Counters wired
///
/// - `agaric.materializer.sql_only_fallback` — the #1057 SQL-only fallback
///   total (read via [`crate::materializer::sql_only_fallback_count`]).
/// - `agaric.materializer.descendant_fanout_dropped` — the #2031 descendant
///   fan-out drop total (read via
///   [`crate::materializer::descendant_fanout_dropped_count`]).
///
/// # Counter deliberately NOT wired
///
/// `pending_block_count_refreshes` (materializer `coordinator.rs`) is
/// `#[cfg(test)]` **per-instance** state (`Arc<AtomicU32>` inside the test-only
/// `BlockCountTestHooks`), not a process-global with a production accessor.
/// Surfacing it would require threading a `Materializer` handle into this
/// boot-time registration — invasive architecture-bending for a test-only
/// signal — so it is intentionally skipped here (per the M6 brief's
/// "prefer skipping with a clear note over invasive plumbing").
pub fn register_instruments(meter_provider: &SdkMeterProvider) {
    let meter = meter_provider.meter(METER_SCOPE);

    // #1057 — SQL-only fallback total. Each collection reads the monotonic
    // process-global atomic and reports it as the current cumulative value.
    let _sql_only_fallback = meter
        .u64_observable_counter("agaric.materializer.sql_only_fallback")
        .with_description(
            "Cumulative count of materializer apply handlers that fell back to \
             the SQL-only projection path (engine uninit / space unresolved). \
             Nonzero in production signals an unexpected fallback (#1057).",
        )
        .with_callback(|observer| {
            observer.observe(crate::materializer::sql_only_fallback_count(), &[]);
        })
        .build();

    // #2031 — descendant fan-out drops that left the engine potentially
    // divergent from SQL. Same monotonic process-global atomic shape.
    let _descendant_fanout_dropped = meter
        .u64_observable_counter("agaric.materializer.descendant_fanout_dropped")
        .with_description(
            "Cumulative count of post-commit descendant fan-out skips that left \
             the Loro engine potentially divergent from SQL. Nonzero signals \
             possible engine/SQL divergence this run (#2031).",
        )
        .with_callback(|observer| {
            observer.observe(crate::materializer::descendant_fanout_dropped_count(), &[]);
        })
        .build();

    // #2275 — build the latency histograms from the OWNED provider here, right
    // after it is installed, and cache them process-globally. Previously they
    // were built lazily from `opentelemetry::global::meter` on first `record`;
    // an unconditional `record_op_apply_duration` (or an enabled
    // `record_ipc_duration`) that fired BEFORE `super::init` set the global
    // provider would resolve the default **no-op** meter and pin it into the
    // OnceLock forever, silently dropping every later metric. Installing from
    // the real provider at registration time makes the record path independent
    // of global-set ordering. `set` (not `get_or_init`) so a stray earlier
    // resolve can never win; init runs once so the Err arm is unreachable.
    let _ = HISTOGRAMS.set(Histograms {
        ipc_duration: meter
            .f64_histogram("agaric.ipc.duration")
            .with_unit("ms")
            .with_description(
                "Wall-clock duration of one backend IPC command dispatch, in \
                 milliseconds, attributed by command name.",
            )
            .build(),
        op_apply_duration: meter
            .f64_histogram("agaric.materializer.op_apply.duration")
            .with_unit("ms")
            .with_description(
                "Wall-clock duration of one materializer per-op apply \
                 transaction (apply_op), in milliseconds.",
            )
            .build(),
    });
}

/// Handles to the two latency histograms, built from the real provider by
/// [`register_instruments`] at [`super::init`] time.
///
/// #2275 — these are installed once from the OWNED [`SdkMeterProvider`], never
/// resolved lazily from `opentelemetry::global::meter`. Until they are
/// installed the record helpers below no-op, so a record that fires before the
/// provider is set can neither export nor pin the global no-op meter.
struct Histograms {
    /// `agaric.ipc.duration` — wall-clock duration of one IPC command dispatch,
    /// in milliseconds, attributed by `cmd` (the command name).
    ipc_duration: Histogram<f64>,
    /// `agaric.materializer.op_apply.duration` — wall-clock duration of one
    /// `apply_op` (the per-op materializer apply transaction), in milliseconds.
    op_apply_duration: Histogram<f64>,
}

/// Process-global cache of the histogram handles, installed once by
/// [`register_instruments`] from the real provider. See [`Histograms`].
static HISTOGRAMS: std::sync::OnceLock<Histograms> = std::sync::OnceLock::new();

/// The installed histogram handles, or `None` until [`register_instruments`]
/// builds them from the real provider at [`super::init`] time. The record
/// helpers no-op while `None`, so a record before init can neither export nor
/// pin the global no-op meter (#2275).
fn histograms() -> Option<&'static Histograms> {
    HISTOGRAMS.get()
}

/// Process-global "is the IPC-duration metric actually being recorded?" flag.
///
/// Set once by [`super::init`] (to `true`) only when the meter provider is
/// installed — i.e. observability is on AND the metrics sink built. It stays
/// `false` in the default (observability-off) build. Both the `lib.rs` invoke
/// wrapper and [`record_ipc_duration`] consult it so the two per-invoke `String`
/// allocations (the command-name clone in the wrapper + the `KeyValue` here) are
/// skipped entirely when off — the hot path then costs one relaxed atomic load
/// instead of a `record` into the global no-op meter plus two allocations.
static IPC_METRICS_ENABLED: AtomicBool = AtomicBool::new(false);

/// Flip the IPC-metrics gate. Called by [`super::init`] once the meter provider
/// is installed; there is no un-set path (an app boots observability once).
pub(crate) fn set_ipc_metrics_enabled(enabled: bool) {
    IPC_METRICS_ENABLED.store(enabled, Ordering::Relaxed);
}

/// Whether the IPC-duration metric is being recorded this run. The `lib.rs`
/// invoke wrapper checks this BEFORE allocating the command name so an
/// observability-off dispatch pays only this relaxed atomic load.
#[must_use]
pub fn ipc_metrics_enabled() -> bool {
    IPC_METRICS_ENABLED.load(Ordering::Relaxed)
}

/// Record one IPC command dispatch duration (milliseconds), attributed by the
/// command `cmd` (the opaque command *name* — a compile-time identifier, never
/// user data).
///
/// Gated on [`ipc_metrics_enabled`]: when observability is off (the default)
/// this returns before the `KeyValue` allocation, so it is a single relaxed
/// atomic load. Callers still wrap the dispatch without a feature check — the
/// gate lives here (and in the `lib.rs` wrapper, which skips the command-name
/// clone on the same flag).
pub fn record_ipc_duration(ms: f64, cmd: &str) {
    if !ipc_metrics_enabled() {
        return;
    }
    if let Some(h) = histograms() {
        h.ipc_duration
            .record(ms, &[KeyValue::new("cmd", cmd.to_owned())]);
    }
}

/// Record one materializer `apply_op` duration (milliseconds).
///
/// No-op until [`register_instruments`] installs the histograms at
/// [`super::init`] time; free when observability is off (#2275).
pub fn record_op_apply_duration(ms: f64) {
    if let Some(h) = histograms() {
        h.op_apply_duration.record(ms, &[]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use opentelemetry_sdk::metrics::InMemoryMetricExporter;
    use opentelemetry_sdk::metrics::data::{AggregatedMetrics, MetricData};

    /// An observable counter built on the provider reflects the value the
    /// callback observes on each collection — the core M6 guarantee that the
    /// existing atomics become readable instruments. Uses a bare provider +
    /// in-memory exporter so the assertion is deterministic (force_flush
    /// triggers one collection).
    #[test]
    fn observable_counter_reflects_callback_value() {
        let exporter = InMemoryMetricExporter::default();
        let reader = PeriodicReader::builder(exporter.clone()).build();
        let provider = SdkMeterProvider::builder().with_reader(reader).build();

        let meter = provider.meter("agaric");
        // A fixed observed value stands in for the process-global atomic so the
        // test does not depend on cross-test atomic state.
        let _counter = meter
            .u64_observable_counter("agaric.test.observable")
            .with_callback(|observer| observer.observe(42, &[]))
            .build();

        provider.force_flush().expect("force_flush");

        let batches = exporter.get_finished_metrics().expect("finished metrics");
        let observed = batches
            .iter()
            .flat_map(opentelemetry_sdk::metrics::data::ResourceMetrics::scope_metrics)
            .flat_map(opentelemetry_sdk::metrics::data::ScopeMetrics::metrics)
            .find(|m| m.name() == "agaric.test.observable")
            .and_then(|m| match m.data() {
                AggregatedMetrics::U64(MetricData::Sum(sum)) => sum
                    .data_points()
                    .next()
                    .map(opentelemetry_sdk::metrics::data::SumDataPoint::value),
                _ => None,
            });
        assert_eq!(
            observed,
            Some(42),
            "the observable counter must report the value its callback observed"
        );
    }

    /// The collection callback keeps firing AFTER the returned instrument handle
    /// is dropped — the exact production shape, since [`register_instruments`]
    /// lets each `ObservableCounter` handle drop at function exit. SDK 0.32
    /// registers the callback on the meter's collection pipeline (the callback
    /// owns its own `Arc` to the observable), so a dropped handle does NOT
    /// unregister it. This guards against a future SDK bump — or a refactor that
    /// stored the callback on the handle — silently zeroing the counters.
    #[test]
    fn observable_counter_collects_after_handle_dropped() {
        let exporter = InMemoryMetricExporter::default();
        let reader = PeriodicReader::builder(exporter.clone()).build();
        let provider = SdkMeterProvider::builder().with_reader(reader).build();

        let meter = provider.meter("agaric");
        // Build, then IMMEDIATELY discard the handle (mirrors register_instruments
        // binding to `_`-prefixed locals that drop when the fn returns). The
        // instrument handle is not `Drop`, so bind-to-`_` rather than `drop()`.
        let _ = meter
            .u64_observable_counter("agaric.test.dropped")
            .with_callback(|observer| observer.observe(7, &[]))
            .build();

        provider.force_flush().expect("force_flush");

        let observed = exporter
            .get_finished_metrics()
            .expect("finished metrics")
            .iter()
            .flat_map(opentelemetry_sdk::metrics::data::ResourceMetrics::scope_metrics)
            .flat_map(opentelemetry_sdk::metrics::data::ScopeMetrics::metrics)
            .find(|m| m.name() == "agaric.test.dropped")
            .and_then(|m| match m.data() {
                AggregatedMetrics::U64(MetricData::Sum(sum)) => sum
                    .data_points()
                    .next()
                    .map(opentelemetry_sdk::metrics::data::SumDataPoint::value),
                _ => None,
            });
        assert_eq!(
            observed,
            Some(7),
            "the callback must still collect after the instrument handle is dropped"
        );
    }

    /// The IPC-metrics gate defaults OFF (observability-off build) and flips on
    /// via [`set_ipc_metrics_enabled`]. `record_ipc_duration` must be a safe
    /// no-op in the off state (it returns before allocating the `cmd` KeyValue)
    /// and must not panic once enabled — the on/off contract the `lib.rs` invoke
    /// wrapper relies on to skip its per-invoke command-name allocation.
    #[test]
    fn ipc_metrics_gate_toggles_and_record_is_safe_both_ways() {
        // Default: off. Recording is a cheap no-op (no meter needed).
        set_ipc_metrics_enabled(false);
        assert!(!ipc_metrics_enabled(), "gate defaults / resets to off");
        record_ipc_duration(1.5, "some_command"); // must not panic when off

        // Flip on: the getter reflects it and recording still doesn't panic even
        // with only the global no-op meter installed.
        set_ipc_metrics_enabled(true);
        assert!(ipc_metrics_enabled(), "gate reads back on once set");
        record_ipc_duration(2.5, "some_command");

        // Leave the process-global flag off so other tests see the default.
        set_ipc_metrics_enabled(false);
    }

    /// #2275 — the latency histograms are built from the OWNED provider at
    /// `register_instruments` time, not lazily from the global meter on first
    /// record. So a `record_op_apply_duration` that fires with no real provider
    /// installed is a safe no-op that CANNOT pin the no-op meter, and once
    /// instruments are registered against a real provider the record reaches it.
    /// Under the old lazy-from-global design the first record populated the
    /// OnceLock with the no-op meter forever — this test asserts that no longer
    /// happens (nextest runs each test in its own process, so the process-global
    /// HISTOGRAMS OnceLock is fresh here).
    #[test]
    fn record_before_register_does_not_pin_noop_meter() {
        // (a) Record BEFORE any provider/instruments are installed. This must
        // NOT populate the histogram cache (the old design pinned the no-op
        // meter here).
        record_op_apply_duration(1.0);
        assert!(
            HISTOGRAMS.get().is_none(),
            "a record before register_instruments must not populate (pin) the histogram cache",
        );

        // (b) Install a real provider + instruments, then record. The data
        // point must reach the real exporter.
        let exporter = InMemoryMetricExporter::default();
        let reader = PeriodicReader::builder(exporter.clone()).build();
        let provider = SdkMeterProvider::builder().with_reader(reader).build();
        register_instruments(&provider);

        record_op_apply_duration(12.5);
        provider.force_flush().expect("force_flush");

        let found = exporter
            .get_finished_metrics()
            .expect("finished metrics")
            .iter()
            .flat_map(opentelemetry_sdk::metrics::data::ResourceMetrics::scope_metrics)
            .flat_map(opentelemetry_sdk::metrics::data::ScopeMetrics::metrics)
            .any(|m| m.name() == "agaric.materializer.op_apply.duration");
        assert!(
            found,
            "after register_instruments, record_op_apply_duration must reach the real provider",
        );
    }
}
