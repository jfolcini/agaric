//! Runtime-adjustable head sampler (#2110, M5).
//!
//! The M1 tracer provider installed a *fixed* `ParentBased(TraceIdRatioBased)`
//! sampler — the ratio was frozen at provider-build time. M5 needs a single
//! **runtime** toggle between full-tracing and sampling that applies to the
//! whole app, so this replaces it with [`RuntimeSampler`]: identical
//! `ParentBased(TraceIdRatioBased(ratio))` semantics, except `ratio` is read
//! from a process-global atomic on every root decision. Flipping the ratio
//! (via the `set_trace_sampling` command → [`set_sampling_ratio`]) takes effect
//! immediately, with no provider teardown.
//!
//! Pairing: the frontend half holds the same ratio in `config.ts`; the
//! `set_trace_sampling` command drives both from one call, so "sample 10%" or
//! "trace everything" is a single, app-wide switch.
//!
//! Parent-based behaviour is preserved so a trace is sampled whole: a child of
//! a sampled span is always recorded; a child of a dropped span is always
//! dropped; only roots consult the ratio. This means lowering the ratio thins
//! *new* traces without splitting in-flight ones.

use std::sync::atomic::{AtomicU64, Ordering};

use opentelemetry::trace::{Link, SpanKind, TraceContextExt, TraceId};
use opentelemetry::{Context, KeyValue};
use opentelemetry_sdk::trace::{SamplingDecision, SamplingResult, ShouldSample};

/// Process-global head-sampling ratio, stored as `f64` bits. Read on every root
/// sampling decision via a relaxed load (no ordering needed — a momentarily
/// stale ratio across a toggle only mis-samples a span or two, never corrupts).
/// Initialised to `1.0` so that, before [`set_sampling_ratio`] runs, an enabled
/// pipeline traces everything rather than silently dropping.
static SAMPLING_RATIO_BITS: AtomicU64 = AtomicU64::new(0x3FF0_0000_0000_0000); // 1.0_f64

/// Set the runtime head-sampling ratio, clamped to `[0.0, 1.0]`.
///
/// `1.0` = full tracing (every root sampled); `0.0` = drop every new root
/// (in-flight sampled traces still complete via parent inheritance). Takes
/// effect on the next root span — no provider rebuild.
pub fn set_sampling_ratio(ratio: f64) {
    let clamped = if ratio.is_nan() {
        0.0
    } else {
        ratio.clamp(0.0, 1.0)
    };
    SAMPLING_RATIO_BITS.store(clamped.to_bits(), Ordering::Relaxed);
}

/// Current runtime head-sampling ratio in `[0.0, 1.0]`.
#[must_use]
pub fn sampling_ratio() -> f64 {
    f64::from_bits(SAMPLING_RATIO_BITS.load(Ordering::Relaxed))
}

/// Root-span ratio decision — mirrors the SDK's `sample_based_on_probability`
/// (compare the high 63 bits of the trace id's low 8 bytes against the ratio
/// threshold) so behaviour matches the stock `TraceIdRatioBased` sampler.
fn sample_root(ratio: f64, trace_id: TraceId) -> SamplingDecision {
    if ratio >= 1.0 {
        return SamplingDecision::RecordAndSample;
    }
    // `ratio` is in [0, 1) here (the `ratio >= 1.0` early return above and the
    // `.max(0.0)` floor bound it), so `ratio * 2^63` is in [0, 2^63) — it always
    // fits in a u64 and is never negative. The cast is therefore exact.
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let upper_bound = (ratio.max(0.0) * (1u64 << 63) as f64) as u64;
    let bytes = trace_id.to_bytes();
    let low = u64::from_be_bytes(bytes[8..16].try_into().expect("8 bytes"));
    if (low >> 1) < upper_bound {
        SamplingDecision::RecordAndSample
    } else {
        SamplingDecision::Drop
    }
}

/// A `ParentBased(TraceIdRatioBased(ratio))` sampler whose `ratio` is the
/// runtime-adjustable [`sampling_ratio`]. Cloneable + `Debug` as the
/// `ShouldSample` trait requires; it is a unit type because all state lives in
/// the process-global atomic.
#[derive(Debug, Clone, Copy)]
pub struct RuntimeSampler;

impl ShouldSample for RuntimeSampler {
    fn should_sample(
        &self,
        parent_context: Option<&Context>,
        trace_id: TraceId,
        _name: &str,
        _span_kind: &SpanKind,
        _attributes: &[KeyValue],
        _links: &[Link],
    ) -> SamplingResult {
        // Parent-based: inherit a valid parent's decision; only roots consult
        // the ratio. Mirrors `Sampler::ParentBased` in the SDK.
        let decision = parent_context
            .filter(|cx| cx.has_active_span())
            .map_or_else(
                || sample_root(sampling_ratio(), trace_id),
                |ctx| {
                    if ctx.span().span_context().is_sampled() {
                        SamplingDecision::RecordAndSample
                    } else {
                        SamplingDecision::Drop
                    }
                },
            );
        let trace_state = parent_context
            .map(|cx| cx.span().span_context().trace_state().clone())
            .unwrap_or_default();
        SamplingResult {
            decision,
            attributes: Vec::new(),
            trace_state,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use opentelemetry::trace::{SpanContext, SpanId, TraceFlags, TraceState};
    use std::sync::Mutex;

    /// Serialises the ratio-mutating tests. They all write the process-global
    /// [`SAMPLING_RATIO_BITS`], so under plain `cargo test` — which runs a
    /// module's tests as threads in ONE process — they race (one test's
    /// `set_sampling_ratio` clobbers another's expectation mid-flight).
    /// `cargo nextest` isolates each test in its own process and hides the
    /// race, so it is invisible there. There is no `serial_test` dependency in
    /// this crate, so the zero-dep fix (mirroring the module-local `static
    /// Mutex` precedent in `lib.rs`) is this lock: every test that calls
    /// `set_sampling_ratio` acquires it first. A poisoned lock (from a
    /// panicking test) is recovered via `into_inner` rather than cascading
    /// into spurious failures (root AGENTS.md pitfall #9).
    static RATIO_LOCK: Mutex<()> = Mutex::new(());

    /// Build a `TraceId` whose LOW 8 bytes encode `low` (big-endian) and whose
    /// HIGH 8 bytes are all `0xFF`. The ratio sampler consults only the low 8
    /// bytes, so a non-zero high half proves those bytes are ignored.
    fn tid_with_low(low: u64) -> TraceId {
        let mut bytes = [0xFFu8; 16];
        bytes[8..16].copy_from_slice(&low.to_be_bytes());
        TraceId::from_bytes(bytes)
    }

    #[test]
    fn ratio_clamps_and_round_trips() {
        let _guard = RATIO_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        set_sampling_ratio(0.25);
        assert!((sampling_ratio() - 0.25).abs() < f64::EPSILON);
        set_sampling_ratio(2.0);
        assert!((sampling_ratio() - 1.0).abs() < f64::EPSILON);
        set_sampling_ratio(-1.0);
        assert_eq!(sampling_ratio(), 0.0);
        set_sampling_ratio(f64::NAN);
        assert_eq!(sampling_ratio(), 0.0);
        // Restore the default so other tests see full tracing.
        set_sampling_ratio(1.0);
    }

    #[test]
    fn ratio_one_samples_every_root_zero_drops() {
        let tid = TraceId::from_bytes([0xFF; 16]);
        assert_eq!(sample_root(1.0, tid), SamplingDecision::RecordAndSample);
        assert_eq!(sample_root(0.0, tid), SamplingDecision::Drop);
    }

    /// Table-driven check that `sample_root` reproduces stock
    /// `TraceIdRatioBased` semantics at ratio 0.5. The expected decisions are
    /// derived from the OTel spec / SDK algorithm, NOT by mirroring the code
    /// under test:
    ///
    ///   1. `upper_bound = (ratio * 2^63) as u64`. At 0.5 → `2^62`
    ///      (`0x4000_0000_0000_0000`).
    ///   2. Read the LOW 8 bytes of the 16-byte trace id as a big-endian
    ///      `u64` → `low`.
    ///   3. `rnd = low >> 1` (drop the LSB → a 63-bit value: the spec uses the
    ///      top 63 bits of trace-id randomness).
    ///   4. Sample iff `rnd < upper_bound`.
    ///
    /// At ratio 0.5 this reduces to "sample iff `low < 2^63`", i.e. iff the top
    /// bit of the low half is clear — matching the intuitive "half of trace
    /// space" meaning. The two middle cases sit exactly on either side of the
    /// `< upper_bound` boundary.
    #[test]
    fn sample_root_matches_trace_id_ratio_based_at_half() {
        // Lock the upper-bound derivation independently of the implementation.
        // Exact cast: 0.5 * 2^63 = 2^62 is a small power of two (same rationale
        // as the production `sample_root` allow).
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let derived = (0.5_f64 * (1u64 << 63) as f64) as u64;
        assert_eq!(derived, 1u64 << 62, "ratio 0.5 upper_bound must be 2^62");

        let cases = [
            // low, expected, rationale
            (
                0u64,
                SamplingDecision::RecordAndSample,
                "low=0 → rnd=0 < 2^62",
            ),
            (
                u64::MAX,
                SamplingDecision::Drop,
                "low=MAX → rnd=2^63-1 >= 2^62",
            ),
            (
                (1u64 << 63) - 1,
                SamplingDecision::RecordAndSample,
                "boundary: rnd=2^62-1 < 2^62 (largest sampled)",
            ),
            (
                1u64 << 63,
                SamplingDecision::Drop,
                "boundary: rnd=2^62 NOT < 2^62 (smallest dropped)",
            ),
        ];
        for (low, expected, why) in cases {
            assert_eq!(
                sample_root(0.5, tid_with_low(low)),
                expected,
                "ratio 0.5, low={low:#018x}: {why}"
            );
        }
    }

    #[test]
    fn runtime_sampler_is_parent_based_for_roots() {
        let _guard = RATIO_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        set_sampling_ratio(1.0);
        let result = RuntimeSampler.should_sample(
            None,
            TraceId::from_bytes([1; 16]),
            "root",
            &SpanKind::Internal,
            &[],
            &[],
        );
        assert_eq!(result.decision, SamplingDecision::RecordAndSample);
        set_sampling_ratio(0.0);
        let dropped = RuntimeSampler.should_sample(
            None,
            TraceId::from_bytes([1; 16]),
            "root",
            &SpanKind::Internal,
            &[],
            &[],
        );
        assert_eq!(dropped.decision, SamplingDecision::Drop);
        set_sampling_ratio(1.0);
    }

    /// A valid parent's sampled flag is inherited whole — roots consult the
    /// ratio, children never do. Proven by forcing the ratio OPPOSITE to each
    /// parent decision: a SAMPLED parent still yields `RecordAndSample` at
    /// ratio 0.0 (which drops every root), and a DROPPED parent still yields
    /// `Drop` at ratio 1.0 (which samples every root).
    #[test]
    fn parent_decision_is_inherited_regardless_of_ratio() {
        let _guard = RATIO_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);

        set_sampling_ratio(0.0);
        let sampled_parent = Context::new().with_remote_span_context(SpanContext::new(
            TraceId::from_bytes([1; 16]),
            SpanId::from_bytes([1; 8]),
            TraceFlags::SAMPLED,
            true,
            TraceState::default(),
        ));
        let child = RuntimeSampler.should_sample(
            Some(&sampled_parent),
            TraceId::from_bytes([2; 16]),
            "child",
            &SpanKind::Internal,
            &[],
            &[],
        );
        assert_eq!(
            child.decision,
            SamplingDecision::RecordAndSample,
            "sampled parent ⇒ child sampled even at ratio 0.0"
        );

        set_sampling_ratio(1.0);
        let dropped_parent = Context::new().with_remote_span_context(SpanContext::new(
            TraceId::from_bytes([3; 16]),
            SpanId::from_bytes([3; 8]),
            TraceFlags::NOT_SAMPLED,
            true,
            TraceState::default(),
        ));
        let child = RuntimeSampler.should_sample(
            Some(&dropped_parent),
            TraceId::from_bytes([4; 16]),
            "child",
            &SpanKind::Internal,
            &[],
            &[],
        );
        assert_eq!(
            child.decision,
            SamplingDecision::Drop,
            "dropped parent ⇒ child dropped even at ratio 1.0"
        );

        // Restore the default so other tests see full tracing.
        set_sampling_ratio(1.0);
    }
}
