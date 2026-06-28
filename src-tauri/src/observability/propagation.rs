//! W3C trace-context extraction at the IPC boundary (issue #2110, M3).
//!
//! The frontend tracer injects a W3C `traceparent` (and optional `tracestate`)
//! HTTP header into every Tauri `invoke` (see the `invoke` shim in M3b). This
//! module turns those headers back into an [`opentelemetry::Context`] so the
//! invoke wrapper in `lib.rs` can re-parent the per-request span onto the
//! frontend's trace — making the backend command + subsystem spans children of
//! the originating frontend interaction, one trace across the IPC boundary.
//!
//! Extraction is read-only and never panics: a missing or malformed
//! `traceparent` yields `None` and the command simply starts a fresh root
//! trace, exactly as before M3.

use opentelemetry::propagation::{Extractor, TextMapPropagator};
use opentelemetry::trace::TraceContextExt as _;
use opentelemetry_sdk::propagation::TraceContextPropagator;

/// The header carrying the W3C trace context. Cheap presence check before
/// doing any propagation work, so a non-traced invoke costs one map lookup.
const TRACEPARENT: &str = "traceparent";

/// Adapts Tauri's (`http` crate) `HeaderMap` to the OpenTelemetry [`Extractor`]
/// trait so the standard `TraceContextPropagator` can read `traceparent` /
/// `tracestate` out of an invoke's headers.
struct HeaderExtractor<'a>(&'a tauri::http::HeaderMap);

impl Extractor for HeaderExtractor<'_> {
    fn get(&self, key: &str) -> Option<&str> {
        self.0.get(key).and_then(|v| v.to_str().ok())
    }

    fn keys(&self) -> Vec<&str> {
        self.0.keys().map(|k| k.as_str()).collect()
    }
}

/// Extract the W3C trace context from an invoke's headers.
///
/// Returns `Some(cx)` only when a `traceparent` header is present AND parses
/// into a **valid** remote span context — so the caller never re-parents onto a
/// garbage/zero context. Returns `None` (no parenting; fresh root trace) when
/// the header is absent or malformed. This is the only place that knows the W3C
/// wire format; everything upstream just sets a header.
#[must_use]
pub fn extract_trace_context(headers: &tauri::http::HeaderMap) -> Option<opentelemetry::Context> {
    // Fast path: the overwhelming majority of invokes (and every invoke when
    // observability is off, since the frontend shim only sets the header when
    // enabled) carry no traceparent. One lookup, then bail.
    if !headers.contains_key(TRACEPARENT) {
        return None;
    }

    let cx = TraceContextPropagator::new().extract(&HeaderExtractor(headers));

    // Guard against a present-but-invalid traceparent: only adopt a context
    // that actually carries a usable remote span to parent onto.
    if cx.span().span_context().is_valid() {
        Some(cx)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::http::HeaderMap;

    /// A well-formed `traceparent` is extracted into a context whose span
    /// carries the same (remote) trace + span ids — the foundation of cross-IPC
    /// correlation.
    #[test]
    fn extracts_valid_traceparent() {
        let mut headers = HeaderMap::new();
        // version-00, trace-id, parent-id, sampled.
        headers.insert(
            "traceparent",
            "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
                .parse()
                .expect("valid header value"),
        );

        let cx = extract_trace_context(&headers).expect("valid traceparent ⇒ Some");
        let span = cx.span();
        let sc = span.span_context();
        assert!(sc.is_valid(), "extracted span context must be valid");
        assert_eq!(
            sc.trace_id().to_string(),
            "4bf92f3577b34da6a3ce929d0e0e4736",
            "trace id must round-trip from the header"
        );
        assert_eq!(
            sc.span_id().to_string(),
            "00f067aa0ba902b7",
            "the frontend span id becomes the remote parent"
        );
        assert!(sc.is_remote(), "the parent context must be marked remote");
    }

    #[test]
    fn absent_traceparent_is_none() {
        let headers = HeaderMap::new();
        assert!(
            extract_trace_context(&headers).is_none(),
            "no traceparent ⇒ no parenting (fresh root trace)"
        );
    }

    #[test]
    fn malformed_traceparent_is_none() {
        let mut headers = HeaderMap::new();
        headers.insert("traceparent", "not-a-valid-traceparent".parse().unwrap());
        assert!(
            extract_trace_context(&headers).is_none(),
            "malformed traceparent ⇒ None, never a garbage parent"
        );
    }
}
