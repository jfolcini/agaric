//! Shared YAML scalar/flow emit + parse helpers for the markdown
//! import/export round-trip (#1920).
//!
//! These helpers are the symmetric pair that keeps the exporter
//! (`markdown::export_page_markdown_inner`) and the importer
//! (`import::parse_frontmatter`) in agreement about how a frontmatter scalar
//! is quoted on the way out and unquoted on the way in. They live in one
//! module so the emit side and the parse side cannot drift. The parser is a
//! deliberately narrow YAML *subset* (no YAML crate) — see
//! `import::parse_frontmatter` for the frozen grammar.

/// `true` when `s` is a YAML token that would round-trip as something OTHER
/// than a plain string (a boolean/null spelling, a number, inf/nan, or a
/// hex/octal literal). The exporter quotes such a value so it survives a
/// re-import as a string rather than a typed scalar.
fn yaml_looks_like_special_token(s: &str) -> bool {
    // YAML 1.1 boolean / null tokens (the common spellings parsers accept).
    const RESERVED: &[&str] = &[
        "null", "Null", "NULL", "~", "true", "True", "TRUE", "false", "False", "FALSE", "yes",
        "Yes", "YES", "no", "No", "NO", "on", "On", "ON", "off", "Off", "OFF",
    ];
    if RESERVED.contains(&s) {
        return true;
    }
    // Numeric-looking scalars (int / float / hex / octal / inf / nan).
    // A bare numeric value would round-trip as a number, not a string, so
    // we quote it. Be conservative: any token that parses as i64 or f64,
    // or matches the common hex / sexagesimal-free special forms.
    if s.parse::<i64>().is_ok() || s.parse::<f64>().is_ok() {
        return true;
    }
    matches!(
        s,
        ".inf" | ".Inf" | ".INF" | "-.inf" | "+.inf" | ".nan" | ".NaN" | ".NAN"
    ) || s
        .strip_prefix("0x")
        .is_some_and(|h| !h.is_empty() && h.chars().all(|c| c.is_ascii_hexdigit() || c == '_'))
        || s.strip_prefix("0o").is_some_and(|o| {
            !o.is_empty() && o.chars().all(|c| ('0'..='7').contains(&c) || c == '_')
        })
}

/// Emit one item of a YAML flow sequence (`[a, b]`). Emitted *bare* only when
/// it is unambiguously a plain string in flow context — i.e. it does not look
/// like a YAML scalar token ([`yaml_looks_like_special_token`]), does not start
/// with a YAML indicator, has no surrounding whitespace, and contains no
/// flow-significant or control characters. Anything else is a YAML
/// double-quoted scalar with `\`, `"` and all control characters (`\n`, `\t`,
/// `\r`, and `\xNN`/`\uNNNN` for the rest) escaped, which is valid for *any*
/// string.
fn yaml_flow_item(s: &str) -> String {
    let plain_safe = !s.is_empty()
        && s == s.trim()
        && !yaml_looks_like_special_token(s)
        // First char must not be a YAML indicator that changes meaning.
        && !s.starts_with([
            '-', '?', ':', ',', '[', ']', '{', '}', '#', '&', '*', '!', '|', '>', '\'', '"',
            '%', '@', '`', ' ',
        ])
        // No flow-significant, comment, mapping, or control characters.
        && s.chars().all(|c| {
            !matches!(c, ',' | '[' | ']' | '{' | '}' | ':' | '#' | '"' | '\'')
                && !c.is_control()
        });
    if plain_safe {
        return s.to_string();
    }
    let mut escaped = String::with_capacity(s.len() + 2);
    escaped.push('"');
    for c in s.chars() {
        match c {
            '\\' => escaped.push_str("\\\\"),
            '"' => escaped.push_str("\\\""),
            '\n' => escaped.push_str("\\n"),
            '\t' => escaped.push_str("\\t"),
            '\r' => escaped.push_str("\\r"),
            c if c.is_control() => {
                // YAML double-quoted escapes: `\xNN` (8-bit) covers C0 and
                // DEL; C1 controls (U+0080..=U+009F) need `\uNNNN`.
                let cp = c as u32;
                if cp <= 0xFF {
                    escaped.push_str(&format!("\\x{cp:02X}"));
                } else {
                    escaped.push_str(&format!("\\u{cp:04X}"));
                }
            }
            c => escaped.push(c),
        }
    }
    escaped.push('"');
    escaped
}

/// Emit a full YAML flow sequence (`[a, b, c]`) from `items`, quoting each item
/// via [`yaml_flow_item`] as needed.
pub(crate) fn yaml_flow_sequence(items: &[String]) -> String {
    let inner: Vec<String> = items.iter().map(|s| yaml_flow_item(s)).collect();
    format!("[{}]", inner.join(", "))
}

/// `true` when a single-line frontmatter scalar `value` is unambiguously a
/// plain string that re-imports (via `import::parse_frontmatter`) to itself
/// when emitted verbatim as `key: value` — i.e. none of the importer's
/// value transforms (leading/trailing `trim`, one-layer quote stripping via
/// `strip_yaml_quotes`, block-scalar / flow-sequence / flow-mapping detection)
/// would alter it. Anything that fails these tests is emitted quoted or as a
/// block scalar by [`yaml_scalar_emit`]. Conservative by design: a value it
/// rejects is merely quoted (never mis-emitted), so over-rejection is harmless.
fn yaml_scalar_is_plain_safe(value: &str) -> bool {
    !value.is_empty()
        // Surrounding whitespace is eaten by the importer's `trim`.
        && value == value.trim()
        // A leading YAML indicator changes how the value re-parses (block
        // scalar `|`/`>`, flow `[`/`{`, quote, comment, anchor, tag, the
        // `-`/`?`/`:` document/mapping indicators, …).
        && !value.starts_with([
            '-', '?', ':', ',', '[', ']', '{', '}', '#', '&', '*', '!', '|', '>', '\'', '"',
            '%', '@', '`', ' ',
        ])
        // A quote char anywhere risks a one-layer strip; a `: ` reads oddly to
        // a human and (defensively) is quoted; control chars force quoting.
        && !value.contains(['"', '\''])
        && !value.contains(": ")
        && !value.chars().any(char::is_control)
}

/// #2715 — emit one frontmatter `key: value` line (terminated with `\n`) that
/// re-imports to the byte-identical `value`. Three shapes, in agreement with
/// the import-side `parse_frontmatter` grammar:
///
/// * `value` contains a newline → a YAML **literal block scalar** (`key: |`
///   then each line indented two spaces). `parse_frontmatter` re-joins the
///   literal-block lines with `\n` after stripping the uniform two-space
///   content indent, recovering `value` exactly. This is the shape that stops
///   an embedded `\n---` from breaking out of the frontmatter fence, or an
///   embedded `\nkey: v` from injecting a spurious property (#2715).
/// * single-line but not [`yaml_scalar_is_plain_safe`] → a **double-quoted**
///   scalar, emitted WITHOUT escaping the interior. The import-side inverse
///   ([`strip_yaml_quotes`](agaric_core::text_utils::strip_yaml_quotes))
///   removes exactly the outer quote pair and decodes nothing, so a verbatim
///   double-wrapped value round-trips for ANY single-line interior — colons,
///   quotes, backslashes, a leading `---`, surrounding spaces.
/// * otherwise → verbatim `key: value`.
///
/// NOTE (reconciliation): the importer's block-scalar reader auto-detects the
/// content indent from the FIRST continuation line and its continuation branch
/// cannot preserve leading whitespace on a value's first line. Values whose
/// first line begins with whitespace therefore do not round-trip their leading
/// whitespace; such values are pathological for a page property and are not a
/// regression target here.
pub(crate) fn yaml_scalar_emit(key: &str, value: &str) -> String {
    if value.contains('\n') {
        let mut out = format!("{key}: |\n");
        for line in value.split('\n') {
            out.push_str("  ");
            out.push_str(line);
            out.push('\n');
        }
        out
    } else if yaml_scalar_is_plain_safe(value) {
        format!("{key}: {value}\n")
    } else {
        format!("{key}: \"{value}\"\n")
    }
}

/// `true` when `line` (a `key:: value` candidate) matches the importer's
/// property-line shape: a `:: `-separated pair whose key matches the same
/// `^[A-Za-z0-9_-]{1,64}$` alphabet `import::is_property_key` enforces. Kept in
/// lockstep with that importer predicate so the export escape and the import
/// classification agree.
fn looks_like_property_line(line: &str) -> bool {
    line.split_once(":: ").is_some_and(|(k, _)| {
        let k = k.trim();
        !k.is_empty()
            && k.len() <= 64
            && k.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    })
}

/// #2716/#2725 — `true` when `line`, taken verbatim as a block-content
/// CONTINUATION line, would be MISCLASSIFIED by the importer's line grammar:
/// it opens a list bullet (`- ` / a bare `-`) or matches the `key:: value`
/// property shape. The exporter backslash-escapes such a continuation line
/// (outside code fences) so `import::parse_logseq_markdown` folds it as literal
/// continuation instead of spawning a new block / property; the importer's
/// continuation branch reverses the escape. Shared by the two export-side bugs.
pub(crate) fn content_line_is_ambiguous(line: &str) -> bool {
    let t = line.trim_start();
    t == "-" || t.starts_with("- ") || looks_like_property_line(t)
}

// #2621 (wave E4-import) — the `strip_yaml_quotes` frontmatter helper moved
// into `agaric_core::text_utils` (a pure string helper) so the query-free
// import parser can reach it without depending on the app crate. The remaining
// consumers here are this module's own round-trip tests (which import it
// directly from `agaric_core`).

#[cfg(test)]
mod tests {
    use super::*;
    use agaric_core::text_utils::strip_yaml_quotes;

    /// #1920 — the quote/unquote pair must round-trip: a value that
    /// `yaml_flow_item` decides to QUOTE (because it is a special token) must
    /// be recovered exactly by `strip_yaml_quotes`. We feed the emitted item
    /// (sans the outer `[` `]`) back through the unquoter.
    #[test]
    fn yaml_quote_unquote_round_trips_special_tokens() {
        // A plain string is emitted bare and survives untouched.
        assert_eq!(yaml_flow_item("PlainPage"), "PlainPage");
        assert_eq!(strip_yaml_quotes("PlainPage"), "PlainPage");

        // A bare number / boolean / null spelling is quoted on emit; the
        // unquoter recovers the original text.
        for special in ["123", "3.14", "true", "false", "null", "yes", "no", "0xFF"] {
            let emitted = yaml_flow_item(special);
            assert!(
                emitted.starts_with('"') && emitted.ends_with('"'),
                "special token {special:?} must be quoted; got {emitted:?}"
            );
            assert_eq!(
                strip_yaml_quotes(&emitted),
                special,
                "strip_yaml_quotes must recover {special:?} from {emitted:?}"
            );
        }
    }

    /// #1920 — `yaml_looks_like_special_token` happy + edge cases: numbers,
    /// booleans, null/inf/nan, hex/octal are special; plain names are not.
    #[test]
    fn special_token_detection_edges() {
        // Special.
        for s in [
            "true", "False", "NULL", "~", "yes", "off", "42", "-7", "3.14", ".inf", "-.inf",
            ".nan", "0xDEAD", "0o755",
        ] {
            assert!(
                yaml_looks_like_special_token(s),
                "{s:?} should be a special token"
            );
        }
        // Not special.
        for s in [
            "Project",
            "Backend API",
            "my-page",
            "0xZZ",   // not valid hex
            "0o9",    // not valid octal
            "truthy", // not a boolean spelling
            "",
        ] {
            assert!(
                !yaml_looks_like_special_token(s),
                "{s:?} should NOT be a special token"
            );
        }
    }

    /// #1920 — a value containing a flow-significant char (comma) or whitespace
    /// is double-quoted on emit and recovered by `strip_yaml_quotes` (one
    /// layer); the inner comma is preserved verbatim.
    #[test]
    fn yaml_flow_item_quotes_flow_significant_value() {
        let emitted = yaml_flow_item("Beta, Inc");
        assert_eq!(emitted, "\"Beta, Inc\"");
        assert_eq!(strip_yaml_quotes(&emitted), "Beta, Inc");
    }

    /// #2715 — `yaml_scalar_emit` produces a shape that `parse_frontmatter`
    /// re-imports byte-identically. Here we assert the EMITTED text (the DB
    /// round-trip is pinned in `page_cmd_tests`), plus the quote/unquote
    /// symmetry for single-line ambiguous values.
    #[test]
    fn yaml_scalar_emit_shapes_2715() {
        // Plain value: emitted verbatim.
        assert_eq!(yaml_scalar_emit("k", "plain"), "k: plain\n");
        assert_eq!(yaml_scalar_emit("k", "2026-03-04"), "k: 2026-03-04\n");
        assert_eq!(yaml_scalar_emit("k", "true"), "k: true\n");
        assert_eq!(yaml_scalar_emit("k", "Linked Target"), "k: Linked Target\n");

        // Colon-bearing → double-quoted; `strip_yaml_quotes` recovers it.
        let colon = yaml_scalar_emit("k", "ratio 3: 2");
        assert_eq!(colon, "k: \"ratio 3: 2\"\n");
        assert_eq!(strip_yaml_quotes("\"ratio 3: 2\""), "ratio 3: 2");

        // Leading `---` → double-quoted (a would-be document/fence marker).
        let dashes = yaml_scalar_emit("k", "---");
        assert_eq!(dashes, "k: \"---\"\n");
        assert_eq!(strip_yaml_quotes("\"---\""), "---");

        // Quote-bearing → double-wrapped WITHOUT interior escaping; the
        // one-layer `strip_yaml_quotes` inverse recovers the exact interior.
        let quoted = yaml_scalar_emit("k", "he said \"hi\"");
        assert_eq!(quoted, "k: \"he said \"hi\"\"\n");
        assert_eq!(strip_yaml_quotes("\"he said \"hi\"\""), "he said \"hi\"");

        // Newline-bearing → literal block scalar; each line indented two
        // spaces, which `parse_frontmatter` strips + re-joins with `\n`.
        let multi = yaml_scalar_emit("k", "line one\n---\ntail: end");
        assert_eq!(multi, "k: |\n  line one\n  ---\n  tail: end\n");
    }

    /// #2716 — `content_line_is_ambiguous` flags exactly the continuation
    /// lines the importer would misclassify (bullets + `key:: value`
    /// properties), and nothing else.
    #[test]
    fn content_line_is_ambiguous_2716() {
        assert!(content_line_is_ambiguous("- looks like a bullet"));
        assert!(content_line_is_ambiguous("-"));
        assert!(content_line_is_ambiguous("  - indented bullet"));
        assert!(content_line_is_ambiguous("key:: value"));
        assert!(content_line_is_ambiguous("todo_state:: TODO"));
        // Not ambiguous: plain prose, a mid-line colon-colon that isn't a
        // valid key, an already-escaped bullet.
        assert!(!content_line_is_ambiguous("just prose"));
        assert!(!content_line_is_ambiguous("see http://x :: y")); // key has spaces
        assert!(!content_line_is_ambiguous("\\- already escaped"));
        assert!(!content_line_is_ambiguous("dash-in-middle - here"));
    }

    /// #1920 — `yaml_flow_sequence` joins quoted/bare items with `, ` inside
    /// `[...]`.
    #[test]
    fn yaml_flow_sequence_mixes_bare_and_quoted() {
        // `Alpha` is plain-safe (bare); `42` is a numeric special token
        // (quoted); `a, b` carries a flow-significant comma (quoted). An
        // interior space alone is NOT flow-significant, so `x y` stays bare.
        let seq = yaml_flow_sequence(&[
            "Alpha".to_string(),
            "42".to_string(),
            "a, b".to_string(),
            "x y".to_string(),
        ]);
        assert_eq!(seq, "[Alpha, \"42\", \"a, b\", x y]");
    }
}
