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

    #[test]
    fn ratio_clamps_and_round_trips() {
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

    #[test]
    fn runtime_sampler_is_parent_based_for_roots() {
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
}
