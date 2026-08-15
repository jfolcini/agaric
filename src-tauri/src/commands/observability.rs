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
    ///
    /// The allowlist is keyed on the NAME, so a shape-generic name is only as
    /// safe as its current sites. `kind` (today: the two literals `"fg"` /
    /// `"bg"` on `mat_batch`) and `size` are the ones to watch — a second site
    /// adopting either name inherits the allowance without review, which is
    /// precisely what an allowlisted key cannot do for `page_title`. Re-read
    /// the emitting sites, not just this list, when one of these gains a
    /// second home. (`child_count` is emitted only by
    /// `agaric_observability`'s own in-crate leak-guard test, not by any
    /// production span; it is here because the scan covers test sources too.)
    ///
    /// Both of those carve-outs are held by this comment and NOTHING ELSE
    /// (#3980 note 7). No test asserts that `child_count` still has no
    /// production emitter, and none asserts that `kind` still has exactly one
    /// site: the guard checks that a key is on this list, never how many
    /// places spell it or what they put in it. So the entry that a future
    /// `kind = user_input` would need already exists, and it would pass. That
    /// is the cost of a name-keyed allowlist, and re-reading the sites is the
    /// only control over it.
    const ALLOWED_SPAN_FIELDS: &[&str] = &[
        "block_id",
        "block_type",
        "blocks_total",
        "child_count",
        "content_len",
        "count",
        "deduped",
        "depth",
        "device_id",
        "has_parent",
        "has_tag_filter",
        "index",
        "is_undo",
        "kind",
        "limit",
        "msg",
        "ops_count",
        "page_id",
        "parent_id",
        "peer",
        "queue",
        "retention_days",
        "seq",
        "size",
        "space",
        "space_id",
        "state",
        "target_seq",
        "undo_depth",
        "undo_seq",
        "window_ms",
    ];

    /// Receiver identifiers whose `.record("literal", …)` is provably NOT a
    /// `tracing::Span::record` — the only exclusions the `.record(` scan
    /// makes. Everything else is treated as a span and its key must be on
    /// [`ALLOWED_SPAN_FIELDS`]: deny-by-default, because a receiver-NAME
    /// allowlist fails OPEN on exactly the span this guard exists to catch.
    ///
    /// Keep this list as short as the workspace allows, and only add a name
    /// after confirming at the call site that its receiver's type is not a
    /// `Span`. Adding a name here is the review point.
    const NON_SPAN_RECORD_RECEIVERS: &[&str] = &[
        // `agaric_sync::transport::endpoint`'s DNS query recorder (test
        // helper): `recorder.record("before-panic.example")`. Takes a leading
        // string literal exactly like `Span::record`, which is why argument
        // SHAPE cannot tell the two apart and the receiver name must.
        "recorder",
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

    /// Return the substring of `src` inside the delimiter group that opens at
    /// `open`, balancing nesting of that same pair. `open` may index any of
    /// the three macro-invocation delimiters — `(`, `[` or `{` — because
    /// `m!(…)`, `m![…]` and `m!{…}` are all legal spellings of the same
    /// invocation and a scan that assumes parens misses two thirds of them
    /// (#3980 note 2). `None` when the group is unbalanced (a truncated read)
    /// or `open` does not index an opening delimiter.
    fn balanced(src: &str, open: usize) -> Option<&str> {
        let bytes = src.as_bytes();
        let (opener, closer) = match bytes.get(open)? {
            b'(' => (b'(', b')'),
            b'[' => (b'[', b']'),
            b'{' => (b'{', b'}'),
            _ => return None,
        };
        let mut depth = 0_usize;
        for (i, b) in bytes.iter().enumerate().skip(open) {
            if *b == opener {
                depth += 1;
            } else if *b == closer {
                depth -= 1;
                if depth == 0 {
                    return src.get(open + 1..i);
                }
            }
        }
        None
    }

    /// The index of the macro-invocation delimiter that immediately follows
    /// `at` (skipping only whitespace, which `m! (…)` is allowed to contain),
    /// or `None` when the next non-whitespace byte is not `(`, `[` or `{`.
    ///
    /// This is the `span!` scan's ANCHOR, and it does two jobs at once
    /// (#3980 notes 1 and 2). It admits all three delimiter spellings, and —
    /// because a bare marker inside a string literal is followed by the
    /// closing quote, never by a delimiter — it rejects the guard's own
    /// vocabulary. Anchoring on `!(` alone would have fixed note 1 while
    /// re-introducing note 2; requiring "a delimiter, any of the three"
    /// is the anchor that satisfies both.
    fn delimiter_after(src: &str, at: usize) -> Option<usize> {
        let bytes = src.as_bytes();
        let mut i = at;
        while matches!(bytes.get(i), Some(b) if b.is_ascii_whitespace()) {
            i += 1;
        }
        matches!(bytes.get(i), Some(b'(' | b'[' | b'{')).then_some(i)
    }

    /// Split an argument list on TOP-LEVEL commas, preserving each entry
    /// verbatim (untrimmed).
    fn top_level_parts(args: &str) -> Vec<String> {
        let mut parts: Vec<String> = Vec::new();
        let mut depth = 0_i32;
        let mut cur = String::new();
        for c in args.chars() {
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
    }

    /// The key of one field entry: the identifier before `=`, or the whole
    /// entry for a shorthand field like `fields(page_id, limit)`.
    fn entry_key(part: &str) -> Option<String> {
        let key = part.split('=').next().unwrap_or("").trim().to_owned();
        (!key.is_empty()).then_some(key)
    }

    /// Split a `fields(...)` body on TOP-LEVEL commas and return each entry's
    /// key.
    fn field_keys(fields: &str) -> Vec<String> {
        top_level_parts(fields)
            .iter()
            .filter_map(|p| entry_key(p))
            .collect()
    }

    /// Field keys of a `…span!(…)` invocation's argument list, after dropping
    /// the leading POSITIONAL arguments every span macro takes ahead of its
    /// fields: the optional `Level` / `parent:` / `target:` prefix that the
    /// generic `tracing::span!` and the `{info,…}_span!` shorthands accept,
    /// then the mandatory string-literal span NAME.
    ///
    /// A positional is recognised by having no top-level `=`. Dropping stops
    /// AT AND INCLUDING the first string literal, so a shorthand field that
    /// follows the name — `info_span!("n", page_id)`, which also has no `=` —
    /// is kept and checked. (`tracing` requires the name to be a literal, so
    /// the string literal is always present in a compiling invocation.)
    fn span_macro_field_keys(args: &str) -> Vec<String> {
        let parts = top_level_parts(args);
        let mut rest = parts.as_slice();
        while let Some((first, tail)) = rest.split_first() {
            let t = first.trim();
            if t.is_empty() {
                rest = tail;
                continue;
            }
            if t.contains('=') {
                break;
            }
            rest = tail;
            if t.starts_with('"') {
                break;
            }
        }
        rest.iter().filter_map(|p| entry_key(p)).collect()
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
    /// This guard reads the source instead: every
    /// `#[instrument(… fields(…))]` key, every `…span!("name", …)` inline
    /// field — the generic `tracing::span!` and all five
    /// `{info,debug,trace,warn,error}_span!` shorthands, in all three legal
    /// delimiter spellings `(…)` / `[…]` / `{…}` — and every
    /// `<receiver>.record("…", …)` key across the workspace must appear on
    /// [`ALLOWED_SPAN_FIELDS`]. A future attribute carrying user content
    /// fails here, at the site that adds it.
    ///
    /// Both scans are DENY-BY-DEFAULT, which is the whole design. #3712's
    /// first pass tried the other polarity — treat a `.record(` receiver as
    /// a `Span` only when it is `Span::current()` or an identifier that IS
    /// `span` or ENDS WITH `_span`, "the codebase's naming convention for a
    /// held span binding". That is an allowlist of NAMES standing in for a
    /// type check, and it fails OPEN on precisely the span this guard exists
    /// to catch: a probe of `s`, `sp`, `tracing_ctx`, `make_span().record(…)`,
    /// `spans[0].record(…)`, `holder.sp.record(…)` and a `let s: Span`
    /// binding all evaded it while `page_title` sailed through. So the
    /// polarity is inverted: EVERY `.record("literal", …)` is checked, and
    /// only receivers named in [`NON_SPAN_RECORD_RECEIVERS`] are skipped.
    /// Argument shape cannot substitute for that list — the DNS query
    /// recorder in `agaric_sync::transport::endpoint` also takes a leading
    /// string literal, so shape alone cannot tell the two apart.
    ///
    /// Residual limits, stated exactly (it is a text scan, not a compile).
    /// Every one of these OVER-flags or is a review question; none of them
    /// lets a field through unscanned, which is the only direction that
    /// costs privacy:
    /// a `Span` recorded through a receiver whose trailing identifier is on
    /// [`NON_SPAN_RECORD_RECEIVERS`] is skipped; `.record_all(…)` and a
    /// non-literal first argument (`span.record(key_var, …)`) have no
    /// literal key to check and are not seen; a string literal or block
    /// comment that spells a full invocation — `"…span!(k = v)…"` — is read
    /// as one and over-flags (a bare `span!` in a string no longer does, see
    /// [`delimiter_after`]); and a field whose key is allowlisted but whose
    /// VALUE is later changed to carry user content is a review question,
    /// not a mechanical one. What the guard does NOT depend on any more is
    /// what the span binding is called, or which of the three delimiters the
    /// invocation is spelled with (#3980 note 2: `find('(')` from the marker
    /// silently skipped past a `!{…}` or `![…]` invocation to an unrelated
    /// paren group later in the file, so the real fields went UNSCANNED —
    /// the one residual in this guard that pointed the wrong way).
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

            // `…span!("name", key = val, …)` — the macro form
            // (`#[instrument]`'s sibling that #3712 found this guard did not
            // scan). Bare `key` shorthand (no `=`) is also a field.
            //
            // ONE marker, `span!`, deliberately: it is a substring of the
            // generic `tracing::span!(Level::INFO, "name", …)` AND of every
            // `{info,debug,trace,warn,error}_span!` shorthand, qualified or
            // imported. Enumerating only the five shorthands (as the first
            // #3712 pass did) leaves the base macro they all expand to
            // unscanned — the same blind spot one level down. Any other
            // macro whose name happens to end in `span!` is over-flagged,
            // which is the safe direction.
            //
            // The marker must be ANCHORED to a following delimiter
            // ([`delimiter_after`]) rather than to the next `(` anywhere
            // downstream. Unanchored, the scan fabricated an offender out of
            // any source file that merely spells `span!` inside a string
            // literal — the next `(` further down the file supplied an
            // unrelated argument list, and the first `key = value` in it was
            // reported as a span field of a macro that is not there (#3980
            // note 1; reproduced against `commands/bug_report.rs`). Anchored
            // on `(`/`[`/`{`, the invocation's OWN argument list is the only
            // thing that can be read (#3980 note 2).
            {
                let marker = "span!";
                let mut from = 0_usize;
                while let Some(rel_idx) = src[from..].find(marker) {
                    let idx = from + rel_idx;
                    let after = idx + marker.len();
                    from = after;
                    let line_start = src[..idx].rfind('\n').map_or(0, |n| n + 1);
                    if src[line_start..idx].trim_start().starts_with("//") {
                        continue;
                    }
                    // Report the macro by its full name, not the marker.
                    let name_start = src[..idx]
                        .rfind(|c: char| !(c.is_alphanumeric() || c == '_'))
                        .map_or(0, |n| n + 1);
                    let macro_name = &src[name_start..after];
                    let Some(open) = delimiter_after(&src, after) else {
                        continue;
                    };
                    let Some(args) = balanced(&src, open) else {
                        continue;
                    };
                    for key in span_macro_field_keys(args) {
                        if !ALLOWED_SPAN_FIELDS.contains(&key.as_str()) {
                            offenders.push(format!("{rel}: {macro_name} field `{key}`"));
                        }
                    }
                }
            }

            // `<receiver>.record("key", …)` — the back-fill form, checked
            // DENY-BY-DEFAULT: the receiver is not inspected for span-ness at
            // all beyond skipping the explicit
            // [`NON_SPAN_RECORD_RECEIVERS`] list. #3712 first tried the
            // opposite polarity (receiver must be `span` / `<x>_span` /
            // `Span::current()`) and it failed open on every span held under
            // any other name or reached through any expression — see the
            // test's doc comment for the probe that demonstrated it.
            let marker = ".record(\"";
            let mut from = 0_usize;
            while let Some(rel_idx) = src[from..].find(marker) {
                let idx = from + rel_idx;
                from = idx + marker.len();

                // Mentions inside a comment are prose, not a call site.
                let line_start = src[..idx].rfind('\n').map_or(0, |n| n + 1);
                if src[line_start..idx].trim_start().starts_with("//") {
                    continue;
                }

                let ident_start = src[..idx]
                    .rfind(|c: char| !(c.is_alphanumeric() || c == '_'))
                    .map_or(0, |n| n + 1);
                let ident = &src[ident_start..idx];
                if NON_SPAN_RECORD_RECEIVERS.contains(&ident) {
                    continue;
                }
                let rest = &src[from..];
                let Some(end) = rest.find('"') else { continue };
                let key = &rest[..end];
                if !ALLOWED_SPAN_FIELDS.contains(&key) {
                    offenders.push(format!("{rel}: .record key `{key}`"));
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
