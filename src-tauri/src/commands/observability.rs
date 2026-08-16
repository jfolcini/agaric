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

    /// `(file, receiver)` pairs whose `.record("literal", …)` is provably NOT
    /// a `tracing::Span::record` — the only exclusions the `.record(` scan
    /// makes. Everything else is treated as a span and its key must be on
    /// [`ALLOWED_SPAN_FIELDS`]: deny-by-default, because a receiver-NAME
    /// allowlist fails OPEN on exactly the span this guard exists to catch.
    ///
    /// The FILE is half the key, and that is the point (#3988 note 3). Keyed
    /// on the bare name alone, the entry below excused every `recorder` in
    /// the workspace — so a real `Span` bound to `recorder` in any file went
    /// unscanned, a name-keyed hole in the one guard whose whole thesis is
    /// that name-keyed matching fails open. Paired with the file that was
    /// actually reviewed, the exclusion covers the call sites someone looked
    /// at and nothing else; a `recorder` in a second file is a new review,
    /// not an inherited pass.
    ///
    /// Path, not module path: the scan reads files, and the relative path is
    /// what it already has (`file!()`-shaped, as used to skip this file).
    /// Spell it with `/` on every platform — the scan normalises the
    /// separator out of `Path::display` before comparing, so a Windows
    /// checkout matches the same entries a Linux one does.
    /// Every entry must match a real call site — a stale one is asserted
    /// against in [`span_fields_stay_on_the_pii_allowlist`], so a moved file
    /// reddens CI instead of quietly widening back into a name-keyed pass.
    ///
    /// Keep this list as short as the workspace allows, and only add a pair
    /// after confirming at that call site that the receiver's type is not a
    /// `Span`. Adding a pair here is the review point.
    const NON_SPAN_RECORD_RECEIVERS: &[(&str, &str)] = &[
        // `agaric_sync::transport::endpoint`'s DNS query recorder (test
        // helper): `recorder.record("before-panic.example")`. Takes a leading
        // string literal exactly like `Span::record`, which is why argument
        // SHAPE cannot tell the two apart and the receiver must be named.
        ("agaric-sync/src/transport/endpoint.rs", "recorder"),
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
            //
            // The search for the closing quote must start PAST the escaped
            // char, not past the backslash: on `'\''` the escaped char IS a
            // quote, and searching from `at + 2` found it, reported 3 bytes
            // and left the real closing quote in code position (#3988 note
            // 1). Skipping exactly one char also carries the multi-byte
            // escape bodies — `'\x41'`, `'\u{1F600}'` — since none of them
            // can contain a `'`.
            if b.get(at + 1) == Some(&b'\\') {
                let escaped = src[at + 2..].chars().next()?;
                let body = at + 2 + escaped.len_utf8();
                return src[body..].find('\'').map(|rel| body + rel + 1 - at);
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

    /// Every `<receiver>.record("key", …)` key in one file, and the
    /// [`NON_SPAN_RECORD_RECEIVERS`] entries that file actually exercised.
    ///
    /// Split out of [`span_fields_stay_on_the_pii_allowlist`] so both of the
    /// properties #3988 closed can be pinned without a probe left in a
    /// production file.
    ///
    /// The marker is `.record(` and the key literal is located by SKIPPING
    /// WHITESPACE AND COMMENTS after it, rather than being required against
    /// the paren. `.record("` missed a call rustfmt had broken across lines
    /// — `span .record(` then a newline then `    "key",` — which is what
    /// rustfmt does to this call as soon as it grows past the width, so a
    /// field could leave the guard by being renamed longer (#3988 note 2).
    /// A whitespace-only skip then missed the same call with a `// note`
    /// between the paren and the key; comments are consumed by the same
    /// [`opaque_prefix_len`] the rest of this scan lexes with.
    ///
    /// `.record_all(` still does not match the marker, since `(` must follow
    /// `record` immediately (so does the exotic `.record /* c */ ("k", v)`);
    /// and a first argument that is not a PLAIN string literal is not read,
    /// which covers a non-literal expression AND the raw / byte-string key
    /// spellings. Those under-flags are real and stay on the list.
    fn record_keys(rel: &str, src: &str) -> (Vec<String>, Vec<&'static str>) {
        let bytes = src.as_bytes();
        let marker = ".record(";
        let mut keys: Vec<String> = Vec::new();
        let mut used: Vec<&'static str> = Vec::new();
        let mut from = 0_usize;

        while let Some(rel_idx) = src[from..].find(marker) {
            let idx = from + rel_idx;
            from = idx + marker.len();

            // Mentions inside a comment are prose, not a call site.
            let line_start = src[..idx].rfind('\n').map_or(0, |n| n + 1);
            if src[line_start..idx].trim_start().starts_with("//") {
                continue;
            }

            // Whitespace and comments both sit between the paren and the key,
            // and both are equally not-the-key. The first spelling of this
            // skip advanced over whitespace only, so a `// note` line between
            // the two landed `at` on `/`, failed the `"` check below, and
            // dropped the call — the wrap fix's own new under-flag, in the
            // one direction this guard exists to prevent.
            // [`opaque_prefix_len`] already measures either comment spelling,
            // so it does the consuming; it is asked only at a comment opener,
            // because at the key it would happily measure the literal too and
            // skip straight past what we came to read.
            let mut at = from;
            loop {
                if matches!(bytes.get(at), Some(c) if c.is_ascii_whitespace()) {
                    at += 1;
                    continue;
                }
                if !(src[at..].starts_with("//") || src[at..].starts_with("/*")) {
                    break;
                }
                let Some(skip) = opaque_prefix_len(src, at) else {
                    break;
                };
                debug_assert!(skip > 0, "opaque element must consume at least one byte");
                at += skip;
            }

            // The exclusion is decided by the RECEIVER, so it is decided
            // before the key is looked at. Checked after, a `.record(` on an
            // excused receiver whose first argument is not a string literal
            // left the entry marked unused, and the staleness assertion in
            // [`span_fields_stay_on_the_pii_allowlist`] fired at a call site
            // that had not moved at all.
            let ident = &src[ident_start(src, idx)..idx];
            if let Some((_, name)) = NON_SPAN_RECORD_RECEIVERS
                .iter()
                .find(|(file, name)| *file == rel && *name == ident)
            {
                used.push(name);
                continue;
            }

            // A first argument that is not a plain string literal has no key
            // this scan can read: a non-literal expression
            // (`span.record(key_var, …)`), and the raw / byte-string
            // spellings (`span.record(r"key", …)`), which ARE literals but
            // are not read. Both are on the residual under-flag list.
            if bytes.get(at) != Some(&b'"') {
                continue;
            }

            // Measure the literal rather than scanning to the next `"`, so an
            // escaped quote inside the key does not cut it short. A length
            // that cannot hold two quotes means a truncated read; skip it,
            // exactly as `balanced` skips an unbalanced group.
            let Some(len) = opaque_prefix_len(src, at) else {
                continue;
            };
            let Some(key) = src.get(at + 1..at + len - 1) else {
                continue;
            };
            keys.push(key.to_owned());
        }

        (keys, used)
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
    /// only the `(file, receiver)` pairs on [`NON_SPAN_RECORD_RECEIVERS`]
    /// are skipped.
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
    /// all in the `.record(` marker, and there are three. `.record_all(…)`
    /// does not match it, because `(` must follow `record` immediately (nor
    /// does the exotic `.record /* c */ ("k", v)`, for the same reason). A
    /// non-literal first argument — `span.record(key_var, …)` — has no
    /// literal key to read. And the RAW and BYTE-STRING key spellings —
    /// `span.record(r"key", v)`, `b"key"`, `br#"key"#` — are skipped: the
    /// key must be a plain `"…"` literal, so "not a literal" is the wrong
    /// summary of that clause and it is spelled out here instead. All three
    /// are pre-existing. This sub-list is maintained by review, not proved
    /// exhaustive — that is precisely the distinction the deleted sentence
    /// blurred — but it is kept because a residual list that omits its own
    /// under-flags is worse than no list at all.
    ///
    /// Two entries stood here until #3988 and its review. The marker was
    /// `.record("`, requiring the quote IMMEDIATELY after the paren, so a
    /// call rustfmt had broken across lines dropped out of the guard — a
    /// field could leave the scan by being renamed long enough to wrap. The
    /// whitespace skip that fixed it then stopped at the `/` of a comment,
    /// so a `// note` between the paren and the key dropped the call the same
    /// way. The skip now consumes whitespace AND comments, pinned by
    /// [`a_record_key_on_the_next_line_is_still_scanned`] and
    /// [`a_comment_between_the_paren_and_the_key_does_not_hide_it`].
    ///
    /// SKIPS — deliberate, and only as narrow as their list: a `Span`
    /// recorded in a FILE on [`NON_SPAN_RECORD_RECEIVERS`] through a receiver
    /// whose trailing identifier is that entry's name. Until #3988 the pair
    /// was a bare name, which excused every `recorder` in the workspace; the
    /// file is now half the key, so the excuse covers the call sites someone
    /// reviewed and nothing else, and an entry matching no call site fails
    /// the test rather than lingering. Trailing identifier still means the
    /// exclusion covers a field access ending in that name within that file
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
    /// ([`ident_start`], round-three note 3). #3988 adds three: whether a
    /// char literal escapes its own closing quote ([`opaque_prefix_len`],
    /// note 1); whether rustfmt has wrapped a `.record(` onto the next line
    /// or a comment sits between its paren and its key ([`record_keys`], note
    /// 2 and its review); and — for every file but the one reviewed —
    /// what a non-span `.record` receiver happens to be called (note 3).
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
        let mut used_skips: Vec<(String, &'static str)> = Vec::new();

        for path in &files {
            let src = std::fs::read_to_string(path).expect("read source file");
            // `/`-separated, always. `Path::display` emits the platform
            // separator, so on Windows every `rel` would come out with `\`
            // and match neither `file!()` below nor a
            // [`NON_SPAN_RECORD_RECEIVERS`] entry — turning the new
            // must-match assertion into a hard failure for a developer whose
            // checkout is fine. CI is ubuntu-only, so nothing would have
            // caught it there.
            let rel = path
                .strip_prefix(env!("CARGO_MANIFEST_DIR"))
                .unwrap_or(path)
                .display()
                .to_string()
                .replace('\\', "/");

            // Skip this guard's own source: its marker literals and its doc
            // comment quote the very shapes it searches for.
            if rel == file!().replace('\\', "/") {
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
            let (keys, used) = record_keys(&rel, &src);
            for key in keys {
                if !ALLOWED_SPAN_FIELDS.contains(&key.as_str()) {
                    offenders.push(format!("{rel}: .record key `{key}`"));
                }
            }
            for name in used {
                used_skips.push((rel.clone(), name));
            }
        }

        // A stale exclusion is a hole with nobody looking at it: if the file
        // is renamed or the call goes away, the pair matches nothing and the
        // scan carries an excuse it no longer needs — the quiet drift that
        // makes a residual list untrustworthy. Every entry must be earning
        // its place at a real call site.
        //
        // The trigger is exactly "no `<name>.record(` in that file", and
        // deliberately not "no `<name>.record("literal"` in that file":
        // [`record_keys`] decides the exclusion on the receiver BEFORE it
        // looks at the argument, so an excused call rewritten to
        // `.record(&format!(…), …)` still marks the entry used. Keyed on the
        // literal, that rewrite would redden CI with a message about a file
        // that had not moved and a call that had not gone away.
        for (file, name) in NON_SPAN_RECORD_RECEIVERS {
            assert!(
                used_skips
                    .iter()
                    .any(|(u_file, u_name)| u_file == file && u_name == name),
                "NON_SPAN_RECORD_RECEIVERS entry (`{file}`, `{name}`) matched no \
                 `{name}.record(` call site in `{file}`. The file moved or the \
                 call went away: re-point the entry, or delete it."
            );
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

    /// #3988 note 1 — the lexer written not to be fooled by literals, fooled
    /// by a literal. The escaped-char arm searched for the closing quote from
    /// just past the backslash, so on `'\''` it found the ESCAPED quote,
    /// reported 3 bytes, and handed the literal's REAL closing quote back to
    /// the caller as ordinary code.
    ///
    /// A stray `'` in code position re-opens a char literal whenever the
    /// next-but-one byte is also a quote, and then the arm one layer up —
    /// "one char, then a close" — swallows whatever sits between them. When
    /// that swallowed byte is a delimiter, the group truncates at the wrong
    /// place and every field after it goes UNSCANNED: #3980 round-three note
    /// 1 again, reached through the fix for it. The shape needs `'\''`
    /// immediately followed by `,` and then `'`, which rustfmt spaces apart
    /// in an argument list it formats — but not inside a macro body it
    /// declines to enter, and not under `#[rustfmt::skip]`, and this scan
    /// reads the bytes on disk either way.
    #[test]
    fn an_escaped_quote_char_literal_consumes_its_real_closing_quote() {
        assert_eq!(
            opaque_prefix_len(r"'\''", 0),
            Some(4),
            "all four bytes of `'\\''` are the literal"
        );

        // The other escapes, whose closing quote is not itself a quote: the
        // arm must not start over-consuming to buy the case above.
        assert_eq!(opaque_prefix_len(r"'\n'", 0), Some(4));
        assert_eq!(opaque_prefix_len(r"'\\'", 0), Some(4));
        assert_eq!(opaque_prefix_len(r"'\x41'", 0), Some(6));
        assert_eq!(opaque_prefix_len(r"'\u{1F600}'", 0), Some(11));

        // End to end: with the short length, the leftover `'` plus `,` plus
        // `'` lexed as a char literal, the `)` that followed became ordinary
        // code, and `balanced` returned a group that ended mid-expression.
        let src = r#"info_span!("n", k = f('\'',')'), page_title = t)"#;
        let args = balanced(src, 10).expect("the group must balance");
        assert!(
            args.ends_with("page_title = t"),
            "the group must not truncate at the `)` inside `')'`: {args}"
        );
        assert_eq!(
            span_macro_field_keys(args),
            vec!["k".to_owned(), "page_title".to_owned()],
            "the field after the char literals must still be scanned"
        );
    }

    /// #3988 note 2 — the `.record("` marker required the key literal to sit
    /// against the paren, so the guard lost a call the moment rustfmt broke
    /// it across lines. Demonstrated end-to-end before the fix by a wrapped
    /// `span.record(` probe carrying a disallowed key in
    /// `commands/pages/markdown.rs`, which the scan passed over in silence.
    #[test]
    fn a_record_key_on_the_next_line_is_still_scanned() {
        let wrapped = "    span.record(\n        \"page_title\",\n        t,\n    );\n";
        assert_eq!(
            record_keys("src/probe.rs", wrapped).0,
            vec!["page_title".to_owned()]
        );

        // The under-flags this does NOT close, pinned so the residual list
        // stays honest — all three of them, in the same order the list on
        // [`span_fields_stay_on_the_pii_allowlist`] and SECURITY.md give
        // them. `(` must follow `record` immediately; a first argument that
        // is not a literal has nothing to read; and the RAW and BYTE-STRING
        // key spellings are literals but are still not read, which is why
        // "non-literal key" alone was the wrong summary of that clause.
        assert!(
            record_keys("src/probe.rs", "span.record_all(\"page_title\", t);")
                .0
                .is_empty()
        );
        assert!(
            record_keys("src/probe.rs", "span.record(key_var, t);")
                .0
                .is_empty()
        );
        for raw in [
            r#"span.record(r"page_title", t);"#,
            r##"span.record(r#"page_title"#, t);"##,
            r#"span.record(b"page_title", t);"#,
            r##"span.record(br#"page_title"#, t);"##,
        ] {
            assert!(
                record_keys("src/probe.rs", raw).0.is_empty(),
                "the raw / byte-string key spellings are a documented \
                 under-flag; if this now reads the key, move the spelling off \
                 the residual list in BOTH the test doc comment and \
                 SECURITY.md: {raw}"
            );
        }

        // An escaped quote inside the key must not cut it short — the same
        // literal-awareness as everywhere else in this scan.
        assert_eq!(
            record_keys("src/probe.rs", r#"span.record("a\"b", t);"#).0,
            vec![r#"a\"b"#.to_owned()]
        );
    }

    /// A comment between the paren and the key is not the key. The whitespace
    /// skip that closed #3988 note 2 stopped at the `/` of a comment, so
    /// `.record(` then a newline then `// note` then a newline then
    /// `"page_title",` landed `at` on `/`, failed the `"` check, and the key
    /// was SILENTLY SKIPPED — a new under-flag arriving with the wrap fix, in
    /// the one direction this guard exists to prevent. `opaque_prefix_len`
    /// already measures both comment spellings, so the skip loop consumes
    /// them exactly as it consumes whitespace.
    #[test]
    fn a_comment_between_the_paren_and_the_key_does_not_hide_it() {
        let commented =
            "    span.record(\n        // note\n        \"page_title\",\n        t,\n    );\n";
        assert_eq!(
            record_keys("src/probe.rs", commented).0,
            vec!["page_title".to_owned()],
            "a line comment before the key must be consumed like whitespace"
        );

        // Both block-comment spellings, inline and wrapped. Nesting too:
        // `opaque_prefix_len` counts depth, so an inner `/*` cannot end it.
        assert_eq!(
            record_keys(
                "src/probe.rs",
                r#"span.record(/* note */ "page_title", t);"#
            )
            .0,
            vec!["page_title".to_owned()]
        );
        assert_eq!(
            record_keys(
                "src/probe.rs",
                "span.record(\n    /* a /* b */ c */\n    \"page_title\", t);"
            )
            .0,
            vec!["page_title".to_owned()]
        );
    }

    /// #3988 note 3 — the exclusion was keyed on the bare receiver name, so
    /// a real `Span` bound to `recorder` in ANY file was skipped without
    /// review: a name-keyed pass inside the guard whose whole argument is
    /// that name-keyed matching fails open. Keyed on `(file, receiver)`, the
    /// excuse reaches the reviewed call sites and stops there.
    #[test]
    fn a_non_span_receiver_is_excused_only_in_the_file_that_was_reviewed() {
        let (file, name) = NON_SPAN_RECORD_RECEIVERS[0];
        let call = format!("    {name}.record(\"page_title\");\n");

        assert_eq!(record_keys(file, &call), (vec![], vec![name]));
        assert_eq!(
            record_keys("src/commands/pages/markdown.rs", &call).0,
            vec!["page_title".to_owned()],
            "the same receiver name in another file is a new review"
        );

        // Field access still resolves to the trailing segment, so the pair
        // covers `holder.recorder.record(…)` in that file too — wider than
        // it reads, which is why the list stays at one entry.
        assert_eq!(
            record_keys(file, &format!("holder.{name}.record(\"page_title\");")),
            (vec![], vec![name])
        );

        // The entry is marked USED by the receiver, not by the argument. The
        // exclusion check used to sit behind the string-literal test, so an
        // excused call rewritten to a non-literal argument marked nothing —
        // and the staleness assertion in
        // [`span_fields_stay_on_the_pii_allowlist`] then fired with "the file
        // moved or the call went away" at a call site that had done neither.
        assert_eq!(
            record_keys(file, &format!("{name}.record(&format!(\"{{x}}\"), v);")),
            (vec![], vec![name]),
            "a non-literal argument on an excused receiver still exercises the entry"
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
