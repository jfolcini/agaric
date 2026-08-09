//! OpenTelemetry observability command handlers (#2110, M3b).
//!
//! Hosts [`ingest_otel_spans`], the single IPC entry point the frontend tracer
//! uses to ship its interaction spans to the backend's local trace sink. The
//! command is pure-additive, zero-egress (writes a local file only), and a
//! silent no-op when observability is disabled — see
//! [`agaric_observability::FrontendSpanIngestor`].

use tracing::instrument;

use agaric_core::error::AppError;
use agaric_observability::{FrontendSpan, FrontendSpanIngestor};

/// Ingest a batch of frontend-produced spans into the local trace sink.
///
/// Writes each [`FrontendSpan`] as one line into `<log_dir>/traces/`'s
/// frontend-trace file, so frontend interaction spans land in the same local
/// sink as the backend trace spans and can be joined by `trace_id`. A no-op
/// when observability is disabled (the managed [`FrontendSpanIngestor`] holds no
/// sink). Fire-and-forget on the frontend side; always returns `Ok(())`.
///
/// `#[instrument(skip_all, fields(count = spans.len()))]` records only the batch
/// size — never the span payload — satisfying the M2a command-instrumentation
/// guard while keeping content/PII out of the span.
#[tauri::command]
#[instrument(skip_all, fields(count = spans.len()))]
#[specta::specta]
pub async fn ingest_otel_spans(
    ingestor: tauri::State<'_, FrontendSpanIngestor>,
    spans: Vec<FrontendSpan>,
) -> Result<(), AppError> {
    ingestor.ingest(&spans);
    Ok(())
}

/// Set the runtime trace head-sampling ratio (#2110, M5).
///
/// One call toggles the whole app between full-tracing and sampling: the
/// backend's runtime sampler reads the new ratio on the next root span (see
/// [`agaric_observability::set_sampling_ratio`]), and the frontend tracer sets
/// the same ratio locally — so "sample 10%" or "trace everything" is a single
/// app-wide switch. `ratio` is clamped to `[0.0, 1.0]`; `1.0` = full tracing,
/// `0.0` = drop new roots.
///
/// No-op-safe when observability is disabled: the ratio is just a process-global
/// number; with no provider installed nothing samples regardless. The `ratio`
/// is a bare number (no content/PII), so the span records it directly.
#[tauri::command]
#[instrument]
#[specta::specta]
pub fn set_trace_sampling(ratio: f64) -> Result<(), AppError> {
    agaric_observability::set_sampling_ratio(ratio);
    Ok(())
}

#[cfg(test)]
mod tests {
    /// Span-attribute keys the backend is allowed to attach to an OTel span.
    ///
    /// Every entry must be OPAQUE — an id (ULID / device id), an enum tag or
    /// discriminant, a count, a length, a duration, or a boolean. Never note
    /// content, a page/tag/property name, a search query, a file path, or an
    /// error message: those are user data, and a span attribute is the one
    /// place in the observability stack where user data has no redaction
    /// boundary in front of it (see the module doc on
    /// `agaric_observability::otlp`).
    ///
    /// Adding a key here is the review point. If a field cannot be described
    /// in one of the shapes above, it does not belong on a span — log it
    /// instead, where the bug-report redactor's deny-by-default pass covers it.
    const ALLOWED_SPAN_FIELDS: &[&str] = &[
        "block_id",
        "block_type",
        "blocks_total",
        "content_len",
        "count",
        "depth",
        "device_id",
        "has_parent",
        "has_tag_filter",
        "index",
        "is_undo",
        "limit",
        "msg",
        "ops_count",
        "page_id",
        "parent_id",
        "peer",
        "queue",
        "retention_days",
        "seq",
        "space",
        "space_id",
        "state",
        "target_seq",
        "undo_depth",
        "undo_seq",
        "window_ms",
    ];

    /// Collect every `.rs` file under a directory tree.
    fn collect_rs(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
        for entry in std::fs::read_dir(dir).expect("read_dir").flatten() {
            let path = entry.path();
            if path.is_dir() {
                collect_rs(&path, out);
            } else if path.extension().and_then(|e| e.to_str()) == Some("rs") {
                out.push(path);
            }
        }
    }

    /// The app crate's `src/` plus every sibling workspace member's `src/`.
    /// Discovered by structure (a subdir with both `Cargo.toml` and `src/`) so
    /// a future crate extraction needs no edit here — same convention as the
    /// `STABLE_MESSAGES` drift guard in `commands::bug_report`.
    fn workspace_src_roots() -> Vec<std::path::PathBuf> {
        let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let mut roots = vec![manifest_dir.join("src")];
        for entry in std::fs::read_dir(manifest_dir)
            .expect("read_dir manifest")
            .flatten()
        {
            let dir = entry.path();
            if dir.is_dir() && dir.join("Cargo.toml").is_file() && dir.join("src").is_dir() {
                roots.push(dir.join("src"));
            }
        }
        roots
    }

    /// Return the substring of `src` inside the parentheses that open at
    /// `open` (the index of the `(`), balancing nesting. `None` when the
    /// parens are unbalanced (a truncated read).
    fn balanced(src: &str, open: usize) -> Option<&str> {
        let bytes = src.as_bytes();
        debug_assert_eq!(bytes[open], b'(');
        let mut depth = 0_usize;
        for (i, b) in bytes.iter().enumerate().skip(open) {
            match b {
                b'(' => depth += 1,
                b')' => {
                    depth -= 1;
                    if depth == 0 {
                        return src.get(open + 1..i);
                    }
                }
                _ => {}
            }
        }
        None
    }

    /// Split a `fields(...)` body on TOP-LEVEL commas and return each entry's
    /// key (the identifier before `=`, or the whole entry for a shorthand
    /// field like `fields(page_id, limit)`).
    fn field_keys(fields: &str) -> Vec<String> {
        let mut parts: Vec<String> = Vec::new();
        let mut depth = 0_i32;
        let mut cur = String::new();
        for c in fields.chars() {
            match c {
                '(' | '[' | '{' => depth += 1,
                ')' | ']' | '}' => depth -= 1,
                _ => {}
            }
            if c == ',' && depth == 0 {
                parts.push(std::mem::take(&mut cur));
            } else {
                cur.push(c);
            }
        }
        parts.push(cur);
        parts
            .into_iter()
            .filter_map(|p| {
                let key = p.split('=').next().unwrap_or("").trim().to_owned();
                (!key.is_empty()).then_some(key)
            })
            .collect()
    }

    /// #3317 — the PII leak-guard that actually looks at the codebase.
    ///
    /// `agaric_observability`'s in-crate leak guard
    /// (`span_pipeline_emits_safe_attributes_only`) asserts an allowlist over a
    /// span the TEST ITSELF builds, so it can never see a real
    /// `#[instrument]` site. That is how
    /// `import_markdown_with_progress` came to record the user's page title
    /// into a `page_title` span attribute — exported verbatim into
    /// `traces/agaric-traces.log` and, when the user opts into a collector,
    /// over OTLP — while a test named "emits safe attributes only" stayed
    /// green and SECURITY.md promised "opaque ids / counts / enums / durations
    /// / booleans only, never note content".
    ///
    /// This guard reads the source instead: every `#[instrument(… fields(…))]`
    /// key and every `span.record("…")` / `Span::current().record("…")` key
    /// across the workspace must appear on [`ALLOWED_SPAN_FIELDS`]. A future
    /// attribute carrying user content fails here, at the site that adds it.
    ///
    /// Scope note: this covers span ATTRIBUTES. Span EVENTS — the `tracing`
    /// events `tracing-opentelemetry` folds into the enclosing span, including
    /// the `err` line — carry their fields verbatim too and are NOT covered
    /// (that would mean allowlisting every log field in the codebase). They
    /// reach no local file (`format_span` does not serialize events) and are
    /// contained on-box by the loopback + no-proxy + no-redirect OTLP client;
    /// the bug-report bundle redacts them deny-by-default.
    #[test]
    fn span_fields_stay_on_the_pii_allowlist() {
        let mut files = Vec::new();
        for root in workspace_src_roots() {
            collect_rs(&root, &mut files);
        }
        assert!(!files.is_empty(), "found no .rs files to scan");

        let mut offenders: Vec<String> = Vec::new();

        for path in &files {
            let src = std::fs::read_to_string(path).expect("read source file");
            let rel = path
                .strip_prefix(env!("CARGO_MANIFEST_DIR"))
                .unwrap_or(path)
                .display()
                .to_string();

            // Skip this guard's own source: its marker literals and its doc
            // comment quote the very shapes it searches for.
            if rel == file!() {
                continue;
            }

            // `#[instrument(... fields(...))]` — attribute macro form.
            for marker in ["#[instrument", "#[tracing::instrument"] {
                let mut from = 0_usize;
                while let Some(rel_idx) = src[from..].find(marker) {
                    let idx = from + rel_idx;
                    from = idx + marker.len();
                    // Skip mentions inside a doc comment / comment line.
                    let line_start = src[..idx].rfind('\n').map_or(0, |n| n + 1);
                    if src[line_start..idx].trim_start().starts_with("//") {
                        continue;
                    }
                    let Some(open) = src[idx..].find('(').map(|o| idx + o) else {
                        continue;
                    };
                    // A bare `#[instrument]` has no parens before the `]`.
                    if src[idx..open].contains(']') {
                        continue;
                    }
                    let Some(args) = balanced(&src, open) else {
                        continue;
                    };
                    let Some(fields_at) = args.find("fields(") else {
                        continue;
                    };
                    let Some(fields) = balanced(args, fields_at + "fields".len()) else {
                        continue;
                    };
                    for key in field_keys(fields) {
                        if !ALLOWED_SPAN_FIELDS.contains(&key.as_str()) {
                            offenders.push(format!("{rel}: #[instrument] field `{key}`"));
                        }
                    }
                }
            }

            // `span.record("key", …)` / `Span::current().record("key", …)` —
            // the back-fill form. Other `.record(` receivers (histograms,
            // dirty-set trackers, DNS recorders) take no leading string
            // literal, so keying on the `span` receiver keeps this specific.
            for marker in ["span.record(\"", "Span::current().record(\""] {
                let mut from = 0_usize;
                while let Some(rel_idx) = src[from..].find(marker) {
                    let idx = from + rel_idx;
                    from = idx + marker.len();
                    // `batch_span.record(` etc. are a different receiver.
                    if marker.starts_with("span.")
                        && src[..idx]
                            .chars()
                            .next_back()
                            .is_some_and(|c| c.is_alphanumeric() || c == '_')
                    {
                        continue;
                    }
                    // Mentions inside a comment are prose, not a call site.
                    let line_start = src[..idx].rfind('\n').map_or(0, |n| n + 1);
                    if src[line_start..idx].trim_start().starts_with("//") {
                        continue;
                    }
                    let rest = &src[from..];
                    let Some(end) = rest.find('"') else { continue };
                    let key = &rest[..end];
                    if !ALLOWED_SPAN_FIELDS.contains(&key) {
                        offenders.push(format!("{rel}: Span::record key `{key}`"));
                    }
                }
            }
        }

        assert!(
            offenders.is_empty(),
            "span attribute(s) not on the PII allowlist. A span attribute has NO \
             redaction boundary in front of it — it is written verbatim to \
             traces/*.log and exported over OTLP. Add the key to \
             ALLOWED_SPAN_FIELDS only after confirming it is opaque (id / enum / \
             count / length / duration / bool); if it carries user content, move \
             it to a `tracing::*!` field instead. Offenders: {offenders:#?}"
        );
    }
}
