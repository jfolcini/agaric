//! Org-mode emitter: converts an [`OrgDoc`] document model back into Org text.
//!
//! ## Escape handling (F08)
//!
//! The emitter escapes **exactly** the characters listed in
//! [`crate::serializer::ESCAPE_CHARS`] -- the same set consumed by the parser.
//!
//! ## Entity handling
//!
//! Entities are emitted as `\name` (e.g., `\alpha`), **not** as Unicode.

use crate::serializer::{
    InlineNode, OrgDoc, OrgMark, OrgParagraph, TextNode, ESCAPE_CHARS, REVERSE_ENTITIES,
};

/// Escape special Org-mode characters in plain text so they are not parsed as markup.
///
/// Handles `#[` → `\#[`, `[[` → `\[[`, and single-character escapes from [`ESCAPE_CHARS`].
fn escape_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(ch) = chars.next() {
        // `#[` -> `\#[`
        if ch == '#' && chars.peek() == Some(&'[') {
            out.push_str("\\#[");
            chars.next();
            continue;
        }
        // `[[` -> `\[[`
        if ch == '[' && chars.peek() == Some(&'[') {
            out.push_str("\\[[");
            chars.next();
            continue;
        }
        // Single-char escapes
        if ESCAPE_CHARS.contains(&ch) {
            out.push('\\');
            out.push(ch);
            continue;
        }
        out.push(ch);
    }
    out
}

/// Return the delimiter character for a given mark (e.g. `*` for bold).
fn mark_delimiter(mark: &OrgMark) -> char {
    match mark {
        OrgMark::Bold => '*',
        OrgMark::Italic => '/',
        OrgMark::Code => '~',
    }
}

/// Emit a [`TextNode`] as Org-mode text, wrapping in mark delimiters and escaping content.
///
/// Code spans are emitted verbatim (no escape) wrapped in `~`. Other marks nest outward.
fn emit_text_node(node: &TextNode) -> String {
    if node.marks.contains(&OrgMark::Code) {
        return format!("~{}~", node.text);
    }
    let mut result = escape_text(&node.text);
    for mark in node.marks.iter().rev() {
        let d = mark_delimiter(mark);
        result = format!("{d}{result}{d}");
    }
    result
}

/// Emit a single [`InlineNode`] as its Org-mode string representation.
fn emit_inline_node(node: &InlineNode) -> String {
    match node {
        InlineNode::Text(t) => emit_text_node(t),
        InlineNode::TagRef { id } => format!("#[{id}]"),
        InlineNode::BlockLink { id } => format!("[[{id}]]"),
        InlineNode::Entity { name, .. } => format!("\\{name}"),
        InlineNode::Timestamp(ts) => {
            let (o, c) = if ts.active { ('<', '>') } else { ('[', ']') };
            let day = compute_day_abbrev(&ts.date).unwrap_or_else(|| "Mon".into());
            match &ts.time {
                Some(t) => format!("{o}{} {day} {t}{c}", ts.date),
                None => format!("{o}{} {day}{c}", ts.date),
            }
        }
        InlineNode::FootnoteRef { label } => format!("[fn:{label}]"),
        InlineNode::HardBreak => "\n".to_string(),
    }
}

/// Emit a paragraph by concatenating all its inline nodes.
fn emit_paragraph(para: &OrgParagraph) -> String {
    para.content.iter().map(emit_inline_node).collect()
}

/// Compute 3-letter day abbreviation from "YYYY-MM-DD" (Tomohiko Sakamoto).
fn compute_day_abbrev(date: &str) -> Option<String> {
    let parts: Vec<&str> = date.split('-').collect();
    if parts.len() != 3 {
        return None;
    }
    let y: i32 = parts[0].parse().ok()?;
    let m: u32 = parts[1].parse().ok()?;
    let d: u32 = parts[2].parse().ok()?;
    if !(1..=12).contains(&m) || d == 0 || d > 31 {
        return None;
    }
    let t = [0u32, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
    let y_adj = if m < 3 { y - 1 } else { y };
    // rem_euclid ensures non-negative result (Rust `%` can be negative for negative dividends)
    let dow =
        (y_adj + y_adj / 4 - y_adj / 100 + y_adj / 400 + t[(m - 1) as usize] as i32 + d as i32)
            .rem_euclid(7);
    let days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    Some(days[dow as usize].to_string())
}

/// Emit Org-mode text from a document model.
pub fn emit(doc: &OrgDoc) -> String {
    if doc.paragraphs.is_empty() {
        return String::new();
    }
    doc.paragraphs
        .iter()
        .map(emit_paragraph)
        .collect::<Vec<_>>()
        .join("\n")
}

/// Look up entity name for a Unicode character.
pub fn unicode_to_entity(ch: &str) -> Option<&'static str> {
    REVERSE_ENTITIES.get(ch).copied()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::serializer::{InlineNode, OrgMark, OrgTimestamp, TextNode};

    fn text(s: &str) -> InlineNode {
        InlineNode::Text(TextNode {
            text: s.into(),
            marks: vec![],
        })
    }
    fn marked(s: &str, m: Vec<OrgMark>) -> InlineNode {
        InlineNode::Text(TextNode {
            text: s.into(),
            marks: m,
        })
    }
    fn doc(ps: Vec<Vec<InlineNode>>) -> OrgDoc {
        OrgDoc {
            paragraphs: ps
                .into_iter()
                .map(|c| OrgParagraph { content: c })
                .collect(),
        }
    }

    #[test]
    fn emit_empty() {
        assert_eq!(emit(&OrgDoc { paragraphs: vec![] }), "");
    }
    #[test]
    fn emit_plain() {
        assert_eq!(emit(&doc(vec![vec![text("hello")]])), "hello");
    }
    #[test]
    fn emit_multi() {
        assert_eq!(emit(&doc(vec![vec![text("a")], vec![text("b")]])), "a\nb");
    }
    #[test]
    fn emit_bold() {
        assert_eq!(
            emit(&doc(vec![vec![marked("hi", vec![OrgMark::Bold])]])),
            "*hi*"
        );
    }
    #[test]
    fn emit_italic() {
        assert_eq!(
            emit(&doc(vec![vec![marked("hi", vec![OrgMark::Italic])]])),
            "/hi/"
        );
    }
    #[test]
    fn emit_code() {
        assert_eq!(
            emit(&doc(vec![vec![marked("hi", vec![OrgMark::Code])]])),
            "~hi~"
        );
    }
    #[test]
    fn emit_esc_bold() {
        assert_eq!(emit(&doc(vec![vec![text("a*b")]])), "a\\*b");
    }
    #[test]
    fn emit_esc_italic() {
        assert_eq!(emit(&doc(vec![vec![text("a/b")]])), "a\\/b");
    }
    #[test]
    fn emit_esc_backslash() {
        assert_eq!(emit(&doc(vec![vec![text("a\\b")]])), "a\\\\b");
    }
    #[test]
    fn emit_esc_hash() {
        assert_eq!(emit(&doc(vec![vec![text("#[x]")]])), "\\#[x]");
    }
    #[test]
    fn emit_esc_bracket() {
        assert_eq!(emit(&doc(vec![vec![text("[[x]]")]])), "\\[[x]]");
    }
    #[test]
    fn emit_code_no_esc() {
        assert_eq!(
            emit(&doc(vec![vec![marked("*x*", vec![OrgMark::Code])]])),
            "~*x*~"
        );
    }
    #[test]
    fn emit_tag_ref() {
        assert_eq!(
            emit(&doc(vec![vec![InlineNode::TagRef {
                id: "01ARZ3NDEKTSV4RRFFQ69G5FAV".into()
            }]])),
            "#[01ARZ3NDEKTSV4RRFFQ69G5FAV]"
        );
    }
    #[test]
    fn emit_entity() {
        assert_eq!(
            emit(&doc(vec![vec![InlineNode::Entity {
                name: "alpha".into(),
                unicode: "x".into()
            }]])),
            "\\alpha"
        );
    }
    #[test]
    fn emit_active_ts() {
        assert_eq!(
            emit(&doc(vec![vec![InlineNode::Timestamp(OrgTimestamp {
                active: true,
                date: "2024-01-15".into(),
                time: None
            })]])),
            "<2024-01-15 Mon>"
        );
    }
    #[test]
    fn emit_footnote() {
        assert_eq!(
            emit(&doc(vec![vec![InlineNode::FootnoteRef {
                label: "1".into()
            }]])),
            "[fn:1]"
        );
    }
    #[test]
    fn day_computation() {
        assert_eq!(compute_day_abbrev("2024-01-15"), Some("Mon".into()));
        assert_eq!(compute_day_abbrev("2024-01-14"), Some("Sun".into()));
    }
    #[test]
    fn day_computation_invalid_month() {
        assert_eq!(compute_day_abbrev("2024-00-15"), None);
        assert_eq!(compute_day_abbrev("2024-13-15"), None);
    }
    #[test]
    fn day_computation_invalid_day() {
        assert_eq!(compute_day_abbrev("2024-01-00"), None);
        assert_eq!(compute_day_abbrev("2024-01-32"), None);
    }
    #[test]
    fn day_computation_malformed() {
        assert_eq!(compute_day_abbrev("not-a-date"), None);
        assert_eq!(compute_day_abbrev("2024-01"), None);
        assert_eq!(compute_day_abbrev(""), None);
    }
    #[test]
    fn unicode_to_entity_known() {
        assert_eq!(unicode_to_entity("\u{03B1}"), Some("alpha"));
    }
    #[test]
    fn unicode_to_entity_unknown() {
        assert_eq!(unicode_to_entity("x"), None);
    }
}
