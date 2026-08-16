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

    /// The byte length of the lexical element starting at `at` whose INTERIOR
    /// must not be inspected — a string, raw-string, byte-string or char
    /// literal, or a line / block comment — and `None` when `at` is ordinary
    /// code. Never returns `Some(0)`.
    ///
    /// This is what makes [`balanced`] and [`top_level_parts`] literal-aware,
    /// and the first of the two mattered for correctness in the direction
    /// that counts (#3980 round-three notes 1 and 5). A `)` inside the span
    /// NAME — `info_span!("n)", page_title = t)` — used to truncate the group
    /// at the wrong byte, after which `span_macro_field_keys` saw no fields
    /// at all and `page_title` went UNSCANNED. The comma case only ever
    /// over-flagged: `info_span!("n", k = "a,b")` split mid-literal and
    /// invented a `b"` key, which reddens CI at an innocent site.
    ///
    /// `'x'` is a char literal but `'a` alone is a LIFETIME, and the two are
    /// told apart by what follows the char — get that wrong and every generic
    /// bound in the workspace opens a literal that never closes.
    ///
    /// `at` must be a char boundary; the returned length always lands on one.
    fn opaque_prefix_len(src: &str, at: usize) -> Option<usize> {
        let b = src.as_bytes();
        let rest = &b[at..];

        if rest.starts_with(b"//") {
            return Some(src[at..].find('\n').unwrap_or(src.len() - at));
        }
        // Block comments NEST in Rust, so this counts depth rather than
        // stopping at the first `*/`.
        if rest.starts_with(b"/*") {
            let mut depth = 0_usize;
            let mut j = at;
            while j + 1 < b.len() {
                if &b[j..j + 2] == b"/*" {
                    depth += 1;
                    j += 2;
                } else if &b[j..j + 2] == b"*/" {
                    depth -= 1;
                    j += 2;
                    if depth == 0 {
                        return Some(j - at);
                    }
                } else {
                    j += 1;
                }
            }
            return Some(b.len() - at);
        }

        // `b` prefixes a byte string, `r` a raw string; `br#"…"#` takes both.
        let mut j = at;
        if b.get(j) == Some(&b'b') {
            j += 1;
        }
        if b.get(j) == Some(&b'r') {
            let hashes_at = j + 1;
            let mut k = hashes_at;
            while b.get(k) == Some(&b'#') {
                k += 1;
            }
            if b.get(k) == Some(&b'"') {
                let hashes = k - hashes_at;
                let mut scan = k + 1;
                loop {
                    let Some(rel) = src[scan..].find('"') else {
                        return Some(b.len() - at);
                    };
                    let after = scan + rel + 1;
                    if b[after..].iter().take_while(|c| **c == b'#').count() >= hashes {
                        return Some(after + hashes - at);
                    }
                    scan = after;
                }
            }
        }
        if b.get(j) == Some(&b'"') {
            let mut k = j + 1;
            while k < b.len() {
                match b[k] {
                    b'\\' => k += 2,
                    b'"' => return Some(k + 1 - at),
                    _ => k += 1,
                }
            }
            return Some(b.len() - at);
        }

        if b.get(at) == Some(&b'\'') {
            // `'\n'`, `'\''` — an escape is always a char literal.
            if b.get(at + 1) == Some(&b'\\') {
                return src[at + 2..].find('\'').map(|rel| at + 2 + rel + 1 - at);
            }
            // One char then a closing quote is a char literal; anything else
            // (`'a,`, `'static>`) is a lifetime and stays ordinary code.
            if let Some(c) = src[at + 1..].chars().next() {
                let after = at + 1 + c.len_utf8();
                if b.get(after) == Some(&b'\'') {
                    return Some(after + 1 - at);
                }
            }
        }
        None
    }

    /// Return the substring of `src` inside the delimiter group that opens at
    /// `open`, balancing nesting of that same pair and skipping literals and
    /// comments ([`opaque_prefix_len`]). `open` may index any of the three
    /// macro-invocation delimiters — `(`, `[` or `{` — because `m!(…)`,
    /// `m![…]` and `m!{…}` are all legal spellings of the same invocation and
    /// a scan that assumes parens misses two thirds of them (#3980 note 2).
    /// `None` when the group is unbalanced (a truncated read) or `open` does
    /// not index an opening delimiter.
    fn balanced(src: &str, open: usize) -> Option<&str> {
        let bytes = src.as_bytes();
        let (opener, closer) = match bytes.get(open)? {
            b'(' => (b'(', b')'),
            b'[' => (b'[', b']'),
            b'{' => (b'{', b'}'),
            _ => return None,
        };
        let mut depth = 0_usize;
        let mut i = open;
        while i < bytes.len() {
            if let Some(skip) = opaque_prefix_len(src, i) {
                debug_assert!(skip > 0, "opaque element must consume at least one byte");
                i += skip;
                continue;
            }
            if bytes[i] == opener {
                depth += 1;
            } else if bytes[i] == closer {
                depth -= 1;
                if depth == 0 {
                    return src.get(open + 1..i);
                }
            }
            i += src[i..].chars().next().map_or(1, char::len_utf8);
        }
        None
    }

    /// Byte index at which the identifier ENDING at `end` starts.
    ///
    /// The delimiting char before an identifier is not necessarily one byte
    /// wide, and `rfind(…).map_or(0, |n| n + 1)` assumed it was (#3980
    /// round-three note 3). A multibyte char immediately before a `span!`
    /// marker or a `.record("` receiver made the following slice panic with
    /// "byte index is not a char boundary" — an opaque failure for a guard
    /// whose entire job is to be legible to whoever it fails on. Note the
    /// `span!` arm takes this slice BEFORE [`delimiter_after`] runs, so the
    /// anchor does not shield it.
    fn ident_start(src: &str, end: usize) -> usize {
        src[..end]
            .char_indices()
            .rev()
            .find(|(_, c)| !(c.is_alphanumeric() || *c == '_'))
            .map_or(0, |(n, c)| n + c.len_utf8())
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
    /// verbatim (untrimmed). Commas inside a literal or a comment are not
    /// top-level ([`opaque_prefix_len`], #3980 round-three note 5).
    fn top_level_parts(args: &str) -> Vec<String> {
        let bytes = args.as_bytes();
        let mut parts: Vec<String> = Vec::new();
        let mut depth = 0_i32;
        let mut start = 0_usize;
        let mut i = 0_usize;
        while i < bytes.len() {
            if let Some(skip) = opaque_prefix_len(args, i) {
                debug_assert!(skip > 0, "opaque element must consume at least one byte");
                i += skip;
                continue;
            }
            match bytes[i] {
                b'(' | b'[' | b'{' => depth += 1,
                b')' | b']' | b'}' => depth -= 1,
                b',' if depth == 0 => {
                    parts.push(args[start..i].to_owned());
                    start = i + 1;
                }
                _ => {}
            }
            i += args[i..].chars().next().map_or(1, char::len_utf8);
        }
        parts.push(args[start..].to_owned());
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
    /// An earlier revision of this list closed with "every one of these
    /// OVER-flags or is a review question; none of them lets a field through
    /// unscanned". That sentence was FALSE when it was written, and it is
    /// worth saying so rather than quietly deleting it: `balanced` was not
    /// literal-aware, so `info_span!("n)", page_title = t)` truncated the
    /// group at the `)` inside the span name and the fields after it were
    /// never looked at (#3980 round-three note 1). A guard's list of
    /// admitted weaknesses is the artefact people trust when they decide how
    /// hard to look at a new span, and this one asserted a property the code
    /// did not have — the same overclaim, one layer in, that #3712 was filed
    /// for. `opaque_prefix_len` now closes that case; the list below is what
    /// is left, and it is sorted by direction rather than by topic.
    ///
    /// UNDER-flags — a real field the scan does not see. The known ones are
    /// all in the `.record("` marker: `.record_all(…)` and a non-literal
    /// first argument (`span.record(key_var, …)`) have no literal key to
    /// check; and the marker requires the quote IMMEDIATELY after the paren,
    /// so a call rustfmt has broken across lines — `span.record(` then a
    /// newline then `    "key",` — does not match (#3980 round-three note 2).
    /// All are pre-existing. This sub-list is maintained by review, not
    /// proved exhaustive — that is precisely the distinction the deleted
    /// sentence blurred — but it is kept because a residual list that omits
    /// its own under-flags is worse than no list at all.
    ///
    /// SKIPS — deliberate, and only as narrow as their list: a `Span`
    /// recorded through a receiver whose trailing identifier is on
    /// [`NON_SPAN_RECORD_RECEIVERS`]. Trailing identifier means the exclusion
    /// also covers a field access ending in that name
    /// (`holder.recorder.record(…)`), which is wider than it reads; keep the
    /// list to one entry.
    ///
    /// OVER-flags — safe, but they redden CI at an innocent site: a string
    /// literal or block comment that spells a full invocation,
    /// `"…span!(k = v)…"`, is read as one (a bare `span!` in a string no
    /// longer is, see [`delimiter_after`]); and any macro whose name merely
    /// ends in `span!` is scanned.
    ///
    /// REVIEW QUESTIONS, not mechanical ones: a field whose key is
    /// allowlisted but whose VALUE later changes to carry user content, and
    /// the name-generic allowlist entries called out on
    /// [`ALLOWED_SPAN_FIELDS`].
    ///
    /// What the guard no longer depends on: what the span binding is called;
    /// which of the three delimiters the invocation is spelled with (#3980
    /// note 2 — `find('(')` skipped past a `!{…}` or `![…]` invocation to an
    /// unrelated paren group and the real fields went unscanned); whether a
    /// delimiter or comma sits inside a literal or comment (round-three notes
    /// 1 and 5); and whether the byte before an identifier is one byte wide
    /// ([`ident_start`], round-three note 3).
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
                    let macro_name = &src[ident_start(&src, idx)..after];
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

                let ident = &src[ident_start(&src, idx)..idx];
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

    /// #3980 round-three note 1 — the UNDER-flag, pinned at the layer that
    /// had it. A closing delimiter inside the span NAME truncated the group,
    /// and `page_title` — the exact field this whole guard exists for — was
    /// then never looked at. The end-to-end proof was a probe macro in
    /// `commands/bug_report.rs` that the guard passed over in silence; this
    /// is the same property without the probe.
    #[test]
    fn a_closing_delimiter_inside_a_literal_does_not_truncate_the_group() {
        // The `(` of the invocation is at index 10.
        let src = r#"info_span!("n)", page_title = t);"#;
        assert_eq!(
            balanced(src, 10),
            Some(r#""n)", page_title = t"#),
            "a `)` inside the span name must not end the argument list"
        );
        assert_eq!(
            span_macro_field_keys(balanced(src, 10).expect("balanced")),
            vec!["page_title".to_owned()],
            "the field after the literal must still be scanned"
        );

        // The other two delimiter spellings, and the other two closers.
        assert_eq!(
            balanced(r#"info_span!{"n}", page_title = t}"#, 10),
            Some(r#""n}", page_title = t"#)
        );
        assert_eq!(
            balanced(r#"info_span!["n]", page_title = t]"#, 10),
            Some(r#""n]", page_title = t"#)
        );
    }

    /// #3980 round-three note 5 — the same blindness pointing the safe way.
    /// A comma inside a field VALUE split the argument list mid-literal and
    /// invented a `b"` key, which would redden CI at a legitimate site.
    #[test]
    fn a_comma_inside_a_literal_is_not_a_top_level_separator() {
        assert_eq!(
            top_level_parts(r#""n", k = "a,b""#),
            vec![r#""n""#.to_owned(), r#" k = "a,b""#.to_owned()]
        );
        assert_eq!(
            span_macro_field_keys(r#""n", k = "a,b""#),
            vec!["k".to_owned()],
            "no `b\"` key may be invented from inside the value literal"
        );
    }

    /// A lifetime is not a char literal. Getting this backwards would open a
    /// literal that never closes and swallow the rest of every generic-bound
    /// argument list — an under-flag, so it is pinned rather than assumed.
    #[test]
    fn a_lifetime_is_ordinary_code_but_a_char_literal_is_not() {
        assert_eq!(
            balanced(r#"info_span!("n", k = f::<'a>(x), j = ')')"#, 10),
            Some(r#""n", k = f::<'a>(x), j = ')'"#)
        );
        assert_eq!(
            span_macro_field_keys(r#""n", k = f::<'a>(x), j = ')'"#),
            vec!["k".to_owned(), "j".to_owned()]
        );
    }

    /// #3980 round-three note 3 — a multibyte char immediately before the
    /// identifier. `rfind(…).map_or(0, |n| n + 1)` landed mid-char and the
    /// slice that followed panicked with "byte index is not a char boundary".
    #[test]
    fn ident_start_lands_on_a_char_boundary_after_a_multibyte_delimiter() {
        let src = "…info_span";
        let start = ident_start(src, src.len());
        assert_eq!(&src[start..], "info_span");

        let rec = "…holder";
        assert_eq!(&rec[ident_start(rec, rec.len())..], "holder");

        // An identifier at byte 0 still reports 0, and a one-byte delimiter
        // is unaffected — the fix widens the step, it does not shift it.
        assert_eq!(ident_start("info_span", 9), 0);
        assert_eq!(&"a.holder"[ident_start("a.holder", 8)..], "holder");
    }
}
