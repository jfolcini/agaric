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

/// Strip a single layer of matching surrounding quotes (`"…"` or `'…'`)
/// from a frontmatter scalar value — the symmetric counterpart of
/// [`yaml_flow_item`]'s quoting. YAML quoting is preserved on export only when
/// a value needs it; Agaric's exporter currently emits bare scalars, but
/// accepting quoted values keeps the importer tolerant of hand-edited /
/// third-party frontmatter without pulling in a YAML crate.
pub(crate) fn strip_yaml_quotes(value: &str) -> &str {
    let bytes = value.as_bytes();
    if bytes.len() >= 2
        && ((bytes[0] == b'"' && bytes[bytes.len() - 1] == b'"')
            || (bytes[0] == b'\'' && bytes[bytes.len() - 1] == b'\''))
    {
        &value[1..value.len() - 1]
    } else {
        value
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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

    /// #1920 — `strip_yaml_quotes` only strips a MATCHING pair; mismatched or
    /// single-sided quotes are left verbatim (mirrors the import-side test).
    #[test]
    fn strip_yaml_quotes_only_strips_matching_pair() {
        assert_eq!(strip_yaml_quotes("\"abc\""), "abc");
        assert_eq!(strip_yaml_quotes("'abc'"), "abc");
        assert_eq!(strip_yaml_quotes("\"abc'"), "\"abc'");
        assert_eq!(strip_yaml_quotes("\"abc"), "\"abc");
        assert_eq!(strip_yaml_quotes("\""), "\"");
        assert_eq!(strip_yaml_quotes("plain"), "plain");
    }
}
