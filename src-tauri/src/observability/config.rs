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
/// [`crate::observability::init`]. Cheap to clone.
///
/// Note: this no longer derives `Copy` — the opt-in OTLP `endpoint`
/// (`Option<String>`, M8) owns a heap allocation, so the struct is move/clone
/// only. It is constructed once and borrowed (`&ObservabilityConfig`)
/// everywhere, so dropping `Copy` is invisible at the call sites.
#[derive(Debug, Clone, PartialEq)]
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

    /// Opt-in, loopback-only OTLP/HTTP collector endpoint (M8), or `None`.
    ///
    /// `None` (the default, when `AGARIC_OTEL_ENDPOINT` is unset) means NO OTLP
    /// exporter is built and the backend exports spans to the local file ONLY —
    /// byte-identical, zero-egress behaviour. When `Some(url)`, the URL has
    /// ALREADY been validated by [`validate_loopback_endpoint`] to be an
    /// `http`/`https` endpoint on a loopback host (`127.0.0.0/8`, `::1`, or
    /// `localhost`); the OTLP exporter is then built in addition to (never
    /// replacing) the file exporter. A non-loopback / malformed value is
    /// rejected at parse time and resolves to `None` (see [`from_env`]), so a
    /// user cannot accidentally egress spans off-machine.
    pub endpoint: Option<String>,
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
        // The default is the OFF state: a disabled, full-sampling,
        // no-egress (file-only) config.
        Self {
            enabled: false,
            sampling_ratio: 1.0,
            endpoint: None,
        }
    }
}

/// Read the three governing environment variables and resolve a config.
///
/// - `AGARIC_OTEL` — enables the pipeline iff set to `1`, `true`, or `on`
///   (case-insensitive). Unset or any other value ⇒ disabled (the default).
/// - `AGARIC_OTEL_SAMPLE` — sampling ratio parsed as `f64`, clamped to
///   `[0, 1]`. Unset or unparseable ⇒ `1.0`.
/// - `AGARIC_OTEL_ENDPOINT` (M8) — opt-in OTLP/HTTP collector URL. Unset ⇒
///   `None` (file-only, zero egress). When set, it is validated by
///   [`validate_loopback_endpoint`]: a loopback `http`/`https` endpoint is
///   accepted (normalized); ANY non-loopback / malformed value is REJECTED —
///   resolving to `None` AND emitting a `tracing::warn!` — so the app falls
///   back to file-only export and a user can never accidentally egress spans
///   off-machine.
///
/// This is the only impure entry point: it reads `std::env` and (for a rejected
/// endpoint) logs the warning. The pure decision logic lives in [`parse`];
/// loopback validation lives in the pure [`validate_loopback_endpoint`].
#[must_use]
pub fn from_env() -> ObservabilityConfig {
    let enabled = std::env::var("AGARIC_OTEL").ok();
    let sample = std::env::var("AGARIC_OTEL_SAMPLE").ok();
    let endpoint = std::env::var("AGARIC_OTEL_ENDPOINT").ok();

    // Validate the endpoint here (the impure wrapper) so the loopback-rejection
    // warning is emitted exactly once at boot, while `parse` stays pure and
    // side-effect-free. A non-empty value that fails loopback validation logs
    // and is dropped to `None`; an unset/blank value is silently `None`.
    if let Some(raw) = endpoint.as_deref() {
        let raw = raw.trim();
        if !raw.is_empty() && validate_loopback_endpoint(raw).is_none() {
            tracing::warn!(
                endpoint = %raw,
                "AGARIC_OTEL_ENDPOINT rejected: only loopback (127.0.0.0/8, ::1, \
                 localhost) collectors are allowed; falling back to local-file export"
            );
        }
    }

    parse(enabled.as_deref(), sample.as_deref(), endpoint.as_deref())
}

/// Pure resolver for [`ObservabilityConfig`] — testable without process env.
///
/// `rust_env` is the raw `AGARIC_OTEL` value (or `None` if unset); `sample` is
/// the raw `AGARIC_OTEL_SAMPLE` value; `endpoint` is the raw
/// `AGARIC_OTEL_ENDPOINT` value. See [`from_env`] for the parsing rules.
///
/// Side-effect-free: a rejected endpoint resolves to `None` here WITHOUT
/// logging — the one warning is emitted by the impure [`from_env`] wrapper so
/// `parse` stays unit-testable without capturing log output.
#[must_use]
pub fn parse(
    rust_env: Option<&str>,
    sample: Option<&str>,
    endpoint: Option<&str>,
) -> ObservabilityConfig {
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

    // Opt-in OTLP endpoint: accepted ONLY if it validates as loopback. Any
    // non-loopback / malformed value resolves to `None` (file-only).
    let endpoint = endpoint.and_then(validate_loopback_endpoint);

    ObservabilityConfig {
        enabled,
        sampling_ratio,
        endpoint,
    }
}

/// Validate `raw` as a loopback-only OTLP/HTTP endpoint — the core privacy
/// guarantee for M8.
///
/// Returns `Some(normalized_url)` IFF `raw` parses as a URL whose:
/// - scheme is `http` or `https` (plain `http` is the common loopback case —
///   no TLS is needed on the loopback interface; other schemes like `ftp`,
///   `grpc`, or a bare `file` are rejected), AND
/// - host is a LOOPBACK address — one of `localhost`, the IPv6 loopback `::1`
///   (with or without brackets), or any IPv4 in `127.0.0.0/8` (i.e. first
///   octet `127`, covering the canonical `127.0.0.1` and the whole reserved
///   loopback block).
///
/// Any other host — a LAN IP (`192.168.x`, `10.x`), a public IP, or ANY DNS
/// name (`example.com`, `otel.mycorp.net`) — is REJECTED (`None`). This is what
/// makes off-machine egress impossible to configure by accident: a span can
/// only ever be sent to a collector the user is running on this very machine.
///
/// Pure: never logs, never touches the network (no DNS resolution — a name
/// other than the literal `localhost` is rejected outright rather than
/// resolved, which both keeps this testable and closes a rebind-to-loopback
/// trick). The caller ([`from_env`]) logs the single rejection warning.
#[must_use]
pub fn validate_loopback_endpoint(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }

    // Parse with the `url` crate (already a direct dependency, used by the
    // deeplink module) for a spec-compliant scheme/host split rather than
    // hand-rolled string slicing.
    let parsed = url::Url::parse(raw).ok()?;

    // Scheme allow-list: only http/https. (`url` lowercases the scheme.)
    if !matches!(parsed.scheme(), "http" | "https") {
        return None;
    }

    // Host must be present and loopback. `url::Host` distinguishes a domain
    // from a parsed IP, so we never mistake `127.0.0.1.evil.com` (a domain)
    // for the loopback IP.
    match parsed.host()? {
        // The only domain we accept is the literal `localhost` (case-insensitive
        // per the URL spec, which `url` already lowercases). Every other name
        // is rejected without DNS resolution.
        url::Host::Domain(name) => {
            if name.eq_ignore_ascii_case("localhost") {
                Some(parsed.into())
            } else {
                None
            }
        }
        // IPv4 in 127.0.0.0/8 — the entire reserved loopback block, keyed on
        // the first octet being 127 (covers 127.0.0.1 and any 127.x.y.z).
        url::Host::Ipv4(addr) => (addr.octets()[0] == 127).then(|| parsed.into()),
        // IPv6 loopback only (::1). `Ipv6Addr::is_loopback()` is exactly `::1`.
        url::Host::Ipv6(addr) => addr.is_loopback().then(|| parsed.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_unset_is_disabled_with_full_sampling() {
        let cfg = parse(None, None, None);
        assert!(!cfg.enabled, "unset AGARIC_OTEL must be disabled");
        assert_eq!(cfg.sampling_ratio, 1.0, "default sampling must be 1.0");
        assert_eq!(
            cfg.endpoint, None,
            "unset AGARIC_OTEL_ENDPOINT must be None"
        );
    }

    #[test]
    fn parse_truthy_values_enable() {
        for v in ["1", "true", "on", "TRUE", "On", " true "] {
            assert!(parse(Some(v), None, None).enabled, "{v:?} must enable");
        }
    }

    #[test]
    fn parse_falsey_or_garbage_values_stay_disabled() {
        for v in ["0", "false", "off", "no", "", "yes", "2", "enabled"] {
            assert!(
                !parse(Some(v), None, None).enabled,
                "{v:?} must stay disabled"
            );
        }
    }

    #[test]
    fn parse_invalid_sample_falls_back_to_default() {
        assert_eq!(
            parse(Some("1"), Some("not-a-number"), None).sampling_ratio,
            1.0
        );
        assert_eq!(parse(Some("1"), Some(""), None).sampling_ratio, 1.0);
        assert_eq!(parse(Some("1"), Some("NaN"), None).sampling_ratio, 1.0);
    }

    #[test]
    fn parse_sample_is_clamped_to_unit_interval() {
        assert_eq!(parse(Some("1"), Some("-0.5"), None).sampling_ratio, 0.0);
        assert_eq!(parse(Some("1"), Some("1.5"), None).sampling_ratio, 1.0);
        assert_eq!(parse(Some("1"), Some("2"), None).sampling_ratio, 1.0);
        assert_eq!(parse(Some("1"), Some("0.25"), None).sampling_ratio, 0.25);
        assert_eq!(parse(Some("1"), Some("0"), None).sampling_ratio, 0.0);
    }

    #[test]
    fn parse_sample_resolves_independently_of_enabled() {
        // A sample ratio is parsed even when disabled (harmless; the pipeline
        // is a no-op anyway, but the value should still be well-formed).
        assert_eq!(parse(None, Some("0.5"), None).sampling_ratio, 0.5);
    }

    // ---- M8: opt-in, loopback-only OTLP endpoint -------------------------

    #[test]
    fn parse_endpoint_unset_is_none() {
        // The default (env unset) is file-only, zero egress.
        assert_eq!(parse(Some("1"), None, None).endpoint, None);
        // Blank / whitespace-only is also `None` (treated as unset).
        assert_eq!(parse(Some("1"), None, Some("")).endpoint, None);
        assert_eq!(parse(Some("1"), None, Some("   ")).endpoint, None);
    }

    #[test]
    fn loopback_hosts_are_accepted() {
        // The canonical local collector cases must all validate. The returned
        // value is the normalized URL (the `url` crate may append a trailing
        // `/` for an empty path), so we only assert acceptance + scheme/host.
        for raw in [
            "http://127.0.0.1:4318",
            "http://127.0.0.1",
            "http://localhost:4318",
            "http://localhost",
            "https://localhost:4318",
            "http://[::1]:4318",
            "https://127.0.0.1:4318",
            // Anywhere in 127.0.0.0/8 is loopback.
            "http://127.1.2.3:4318",
            "http://127.0.0.1:4318/v1/traces",
        ] {
            let got = validate_loopback_endpoint(raw);
            assert!(got.is_some(), "{raw:?} is loopback and must be accepted");
            // And it round-trips through `parse` into the config.
            assert_eq!(
                parse(Some("1"), None, Some(raw)).endpoint,
                got,
                "{raw:?} must reach the config endpoint"
            );
        }
    }

    #[test]
    fn non_loopback_hosts_are_rejected() {
        // LAN IPs, public IPs, ANY DNS name, non-http schemes, and garbage all
        // resolve to `None` — the core privacy guarantee. None of these may
        // ever produce an endpoint a span could egress to.
        for raw in [
            "http://192.168.1.5:4318", // private LAN
            "http://10.0.0.1",         // private LAN
            "http://172.16.0.1:4318",  // private LAN
            "https://example.com",     // public DNS name
            "http://otel.mycorp.net",  // internal DNS name
            "http://8.8.8.8:4318",     // public IP
            "http://0.0.0.0:4318",     // wildcard, not loopback
            "http://[::]:4318",        // IPv6 unspecified, not ::1
            "http://[fe80::1]:4318",   // link-local, not loopback
            "ftp://127.0.0.1",         // wrong scheme
            "grpc://127.0.0.1:4317",   // wrong scheme
            "file:///etc/passwd",      // wrong scheme, no host
            "127.0.0.1:4318",          // no scheme ⇒ not a valid absolute URL
            "localhost:4318",          // parses with scheme `localhost`, not http
            "garbage",                 // not a URL
            "",                        // empty
            "   ",                     // whitespace
            // A loopback-looking domain that is actually a public subdomain.
            "http://127.0.0.1.evil.com:4318",
        ] {
            assert_eq!(
                validate_loopback_endpoint(raw),
                None,
                "{raw:?} is NOT loopback and must be rejected"
            );
            assert_eq!(
                parse(Some("1"), None, Some(raw)).endpoint,
                None,
                "{raw:?} must not reach the config endpoint"
            );
        }
    }

    #[test]
    fn endpoint_is_trimmed_before_validation() {
        // Surrounding whitespace (e.g. from a shell export) must not defeat
        // validation of an otherwise-valid loopback endpoint.
        assert!(
            validate_loopback_endpoint("  http://127.0.0.1:4318  ").is_some(),
            "a trimmable loopback endpoint must be accepted"
        );
    }
}
