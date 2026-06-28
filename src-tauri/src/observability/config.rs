//! Pure, env-driven configuration for the OpenTelemetry trace pipeline.
//!
//! The parsing logic is split into a side-effect-free [`parse`] helper (which
//! takes the already-read env values as `Option<&str>`) and the thin
//! [`from_env`] wrapper that reads the process environment. This mirrors the
//! `build_log_directives` / `init_logging` split in `lib.rs`: the *decision*
//! is unit-testable without touching `std::env`, and only the wrapper is
//! impure.

/// Resolved observability settings for one app boot.
///
/// Constructed once at startup (see [`from_env`]) and threaded into
/// [`crate::observability::init`]. Cheap to clone / copy.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ObservabilityConfig {
    /// Master on/off switch for the entire trace pipeline.
    ///
    /// `false` (the default, when `AGARIC_OTEL` is unset) means
    /// [`crate::observability::init`] returns a no-op `Observability` with no
    /// trace layer and no guard — the existing logging behaviour is then
    /// byte-identical and OTel adds ~zero overhead.
    pub enabled: bool,

    /// Head-based trace sampling ratio in the closed interval `[0.0, 1.0]`.
    ///
    /// `1.0` (the default) samples every trace; `0.0` samples none. Wired into
    /// `Sampler::TraceIdRatioBased` via a `ParentBased` wrapper in
    /// [`crate::observability::provider`]. Values outside `[0, 1]` are clamped
    /// by [`parse`] so the SDK never sees an out-of-range probability.
    pub sampling_ratio: f64,
}

impl ObservabilityConfig {
    /// Read the governing environment variables and resolve a config.
    ///
    /// Thin inherent-method alias for the free [`from_env`] function so call
    /// sites can use the more discoverable `ObservabilityConfig::from_env()`.
    #[must_use]
    pub fn from_env() -> Self {
        from_env()
    }
}

impl Default for ObservabilityConfig {
    fn default() -> Self {
        // The default is the OFF state: a disabled, full-sampling config.
        Self {
            enabled: false,
            sampling_ratio: 1.0,
        }
    }
}

/// Read the two governing environment variables and resolve a config.
///
/// - `AGARIC_OTEL` — enables the pipeline iff set to `1`, `true`, or `on`
///   (case-insensitive). Unset or any other value ⇒ disabled (the default).
/// - `AGARIC_OTEL_SAMPLE` — sampling ratio parsed as `f64`, clamped to
///   `[0, 1]`. Unset or unparseable ⇒ `1.0`.
///
/// This is the only impure entry point; the actual logic lives in [`parse`].
#[must_use]
pub fn from_env() -> ObservabilityConfig {
    let enabled = std::env::var("AGARIC_OTEL").ok();
    let sample = std::env::var("AGARIC_OTEL_SAMPLE").ok();
    parse(enabled.as_deref(), sample.as_deref())
}

/// Pure resolver for [`ObservabilityConfig`] — testable without process env.
///
/// `rust_env` is the raw `AGARIC_OTEL` value (or `None` if unset); `sample` is
/// the raw `AGARIC_OTEL_SAMPLE` value. See [`from_env`] for the parsing rules.
#[must_use]
pub fn parse(rust_env: Option<&str>, sample: Option<&str>) -> ObservabilityConfig {
    let enabled = matches!(
        rust_env.map(|v| v.trim().to_ascii_lowercase()).as_deref(),
        Some("1" | "true" | "on")
    );

    // Default to full sampling; clamp anything out of range so the SDK only
    // ever receives a probability in [0, 1]. Unparseable ⇒ default.
    let sampling_ratio = sample
        .and_then(|s| s.trim().parse::<f64>().ok())
        .filter(|r| r.is_finite())
        .map_or(1.0, |r| r.clamp(0.0, 1.0));

    ObservabilityConfig {
        enabled,
        sampling_ratio,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_unset_is_disabled_with_full_sampling() {
        let cfg = parse(None, None);
        assert!(!cfg.enabled, "unset AGARIC_OTEL must be disabled");
        assert_eq!(cfg.sampling_ratio, 1.0, "default sampling must be 1.0");
    }

    #[test]
    fn parse_truthy_values_enable() {
        for v in ["1", "true", "on", "TRUE", "On", " true "] {
            assert!(parse(Some(v), None).enabled, "{v:?} must enable");
        }
    }

    #[test]
    fn parse_falsey_or_garbage_values_stay_disabled() {
        for v in ["0", "false", "off", "no", "", "yes", "2", "enabled"] {
            assert!(!parse(Some(v), None).enabled, "{v:?} must stay disabled");
        }
    }

    #[test]
    fn parse_invalid_sample_falls_back_to_default() {
        assert_eq!(parse(Some("1"), Some("not-a-number")).sampling_ratio, 1.0);
        assert_eq!(parse(Some("1"), Some("")).sampling_ratio, 1.0);
        assert_eq!(parse(Some("1"), Some("NaN")).sampling_ratio, 1.0);
    }

    #[test]
    fn parse_sample_is_clamped_to_unit_interval() {
        assert_eq!(parse(Some("1"), Some("-0.5")).sampling_ratio, 0.0);
        assert_eq!(parse(Some("1"), Some("1.5")).sampling_ratio, 1.0);
        assert_eq!(parse(Some("1"), Some("2")).sampling_ratio, 1.0);
        assert_eq!(parse(Some("1"), Some("0.25")).sampling_ratio, 0.25);
        assert_eq!(parse(Some("1"), Some("0")).sampling_ratio, 0.0);
    }

    #[test]
    fn parse_sample_resolves_independently_of_enabled() {
        // A sample ratio is parsed even when disabled (harmless; the pipeline
        // is a no-op anyway, but the value should still be well-formed).
        assert_eq!(parse(None, Some("0.5")).sampling_ratio, 0.5);
    }
}
