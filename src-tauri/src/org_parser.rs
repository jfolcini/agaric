//! Org-mode parser: converts Org markup text into an [`OrgDoc`] document model.
//!
//! Supports a locked subset of Org syntax (ADR-20 phase 1):
//!   marks:      `*bold*`  `/italic/`  `~code~`
//!   tokens:     `#[ULID]`  `[[ULID]]`
//!   entities:   `\alpha` -> a  (see [`crate::serializer::ENTITIES`])
//!   timestamps: `<2024-01-15 Mon>` / `[2024-01-15 Mon]`
//!   footnotes:  `[fn:label]`
//!   escapes:    `\*` `\/` `\~` `\\` `\#` `\[`
//!
//! ## Unsupported Org constructs (Phase 1) -- F03-F05
//!
//! - Headings, Lists, Tables, Drawers, Blocks, LaTeX fragments
//! - Inline images / file links, Macros, Planning keywords, Comments
//!
//! ## Unicode normalization -- known limitation (F06)
//!
//! This parser does **not** apply NFC normalization.

use regex::Regex;
use std::sync::LazyLock;

use crate::serializer::{
    InlineNode, OrgDoc, OrgMark, OrgParagraph, OrgTimestamp, TextNode, ENTITIES,
};

// Hardcoded regex patterns — compilation cannot fail for these constant strings.
static ULID_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9A-Z]{26}$").unwrap());
static ACTIVE_TS_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^<(\d{4}-\d{2}-\d{2})\s+[A-Za-z]{2,3}(?:\s+(\d{2}:\d{2}))?>$").unwrap()
});
static INACTIVE_TS_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\[(\d{4}-\d{2}-\d{2})\s+[A-Za-z]{2,3}(?:\s+(\d{2}:\d{2}))?\]$").unwrap()
});
static FOOTNOTE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\[fn:([A-Za-z0-9_-]+)\]$").unwrap());

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

/// Byte-offset scanner over a source string for single-pass inline parsing.
struct Scanner<'a> {
    src: &'a str,
    pos: usize,
}

impl<'a> Scanner<'a> {
    /// Create a new scanner starting at position 0.
    fn new(src: &'a str) -> Self {
        Self { src, pos: 0 }
    }
    /// Return the next character without advancing, or `None` at end-of-input.
    fn peek(&self) -> Option<char> {
        self.src[self.pos..].chars().next()
    }
    /// Return the character `offset` positions ahead of current, or `None`.
    fn peek_at(&self, offset: usize) -> Option<char> {
        self.src[self.pos..].chars().nth(offset)
    }
    /// Return the number of bytes remaining in the source.
    fn remaining(&self) -> usize {
        self.src.len() - self.pos
    }
    /// Advance the scanner by `n` bytes, clamping at end-of-input.
    fn advance(&mut self, n: usize) {
        self.pos = (self.pos + n).min(self.src.len());
    }
    /// Return the remaining unscanned slice.
    fn rest(&self) -> &'a str {
        &self.src[self.pos..]
    }
}

// ---------------------------------------------------------------------------
// Token consumers
// ---------------------------------------------------------------------------

/// Try to consume a tag reference token `#[ULID]` (29 bytes: `#[` + 26-char ULID + `]`).
fn try_consume_tag_ref(s: &mut Scanner) -> Option<InlineNode> {
    if s.remaining() < 29 {
        return None;
    }
    let rest = s.rest();
    let b = rest.as_bytes();
    if b[0] != b'#' || b[1] != b'[' {
        return None;
    }
    let candidate = &rest[2..28];
    if candidate.len() == 26 && ULID_RE.is_match(candidate) && b.get(28) == Some(&b']') {
        s.advance(29);
        Some(InlineNode::TagRef {
            id: candidate.to_string(),
        })
    } else {
        None
    }
}

/// Try to consume a block link token `[[ULID]]` (30 bytes: `[[` + 26-char ULID + `]]`).
fn try_consume_block_link(s: &mut Scanner) -> Option<InlineNode> {
    if s.remaining() < 30 {
        return None;
    }
    let rest = s.rest();
    let b = rest.as_bytes();
    if b[0] != b'[' || b[1] != b'[' {
        return None;
    }
    let candidate = &rest[2..28];
    if candidate.len() == 26
        && ULID_RE.is_match(candidate)
        && b.get(28) == Some(&b']')
        && b.get(29) == Some(&b']')
    {
        s.advance(30);
        Some(InlineNode::BlockLink {
            id: candidate.to_string(),
        })
    } else {
        None
    }
}

/// Try to consume an Org entity `\name` (e.g. `\alpha`), looking up the name in [`ENTITIES`].
fn try_consume_entity(s: &mut Scanner) -> Option<InlineNode> {
    if s.peek() != Some('\\') {
        return None;
    }
    let rest = &s.rest()[1..];
    // Count ASCII-alphabetic characters. Since is_ascii_alphabetic matches only
    // single-byte ASCII chars, character count == byte count, so the slice below
    // is safe and will never split a multi-byte UTF-8 sequence.
    let name_len = rest.chars().take_while(|c| c.is_ascii_alphabetic()).count();
    if name_len < 2 {
        return None;
    }
    let name = &rest[..name_len];
    if let Some(unicode) = ENTITIES.get(name) {
        s.advance(1 + name_len);
        Some(InlineNode::Entity {
            name: name.to_string(),
            unicode: unicode.to_string(),
        })
    } else {
        None
    }
}

/// Try to consume an active Org timestamp `<YYYY-MM-DD Day>` or `<YYYY-MM-DD Day HH:MM>`.
fn try_consume_active_timestamp(s: &mut Scanner) -> Option<InlineNode> {
    if s.peek() != Some('<') {
        return None;
    }
    let rest = s.rest();
    let end = rest.find('>')?;
    let candidate = &rest[..=end];
    let caps = ACTIVE_TS_RE.captures(candidate)?;
    let date = caps.get(1)?.as_str().to_string();
    let time = caps.get(2).map(|m| m.as_str().to_string());
    s.advance(candidate.len());
    Some(InlineNode::Timestamp(OrgTimestamp {
        active: true,
        date,
        time,
    }))
}

/// Try to consume an inactive Org timestamp `[YYYY-MM-DD Day]` or `[YYYY-MM-DD Day HH:MM]`.
///
/// Returns `None` if the `[` is followed by another `[` (block link), avoiding ambiguity.
fn try_consume_inactive_timestamp(s: &mut Scanner) -> Option<InlineNode> {
    if s.peek() != Some('[') {
        return None;
    }
    if s.peek_at(1) == Some('[') {
        return None;
    }
    let rest = s.rest();
    let end = rest.find(']')?;
    let candidate = &rest[..=end];
    let caps = INACTIVE_TS_RE.captures(candidate)?;
    let date = caps.get(1)?.as_str().to_string();
    let time = caps.get(2).map(|m| m.as_str().to_string());
    s.advance(candidate.len());
    Some(InlineNode::Timestamp(OrgTimestamp {
        active: false,
        date,
        time,
    }))
}

/// Try to consume an Org footnote reference `[fn:label]`.
fn try_consume_footnote(s: &mut Scanner) -> Option<InlineNode> {
    if s.peek() != Some('[') {
        return None;
    }
    let rest = s.rest();
    if !rest.starts_with("[fn:") {
        return None;
    }
    let end = rest.find(']')?;
    let candidate = &rest[..=end];
    let caps = FOOTNOTE_RE.captures(candidate)?;
    let label = caps.get(1)?.as_str().to_string();
    s.advance(candidate.len());
    Some(InlineNode::FootnoteRef { label })
}

// ---------------------------------------------------------------------------
// Mark handling
// ---------------------------------------------------------------------------

/// Return the delimiter character for a given mark (e.g. `*` for bold).
fn mark_delimiter(mark: OrgMark) -> char {
    match mark {
        OrgMark::Bold => '*',
        OrgMark::Italic => '/',
        OrgMark::Code => '~',
    }
}

/// Map a character to its corresponding [`OrgMark`], or `None` if it is not a mark delimiter.
fn char_to_mark(ch: char) -> Option<OrgMark> {
    match ch {
        '*' => Some(OrgMark::Bold),
        '/' => Some(OrgMark::Italic),
        '~' => Some(OrgMark::Code),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Line parser
// ---------------------------------------------------------------------------

/// Parse a single line of Org-mode text into a sequence of inline nodes.
///
/// Handles mark toggles (bold/italic/code), escape sequences, entities,
/// tag references, block links, timestamps, and footnotes. Unclosed marks
/// are reverted to plain text at end-of-line.
fn parse_line(line: &str) -> Vec<InlineNode> {
    let mut s = Scanner::new(line);
    let mut nodes: Vec<InlineNode> = Vec::new();
    let mut buf = String::new();
    let mut active_marks: Vec<OrgMark> = Vec::new();
    let mut in_code = false;
    // (mark, scanner_pos, nodes_len)
    let mut mark_opens: Vec<(OrgMark, usize, usize)> = Vec::new();

    while s.pos < s.src.len() {
        let ch = match s.peek() {
            Some(c) => c,
            None => break,
        };

        // --- Code span: close ---
        if ch == '~' && in_code {
            flush_text(&mut buf, &active_marks, &mut nodes);
            in_code = false;
            active_marks.retain(|m| *m != OrgMark::Code);
            mark_opens.retain(|(m, _, _)| *m != OrgMark::Code);
            s.advance(1);
            continue;
        }
        // --- Code span: literal content ---
        if in_code {
            buf.push(ch);
            s.advance(ch.len_utf8());
            continue;
        }

        // --- Escape sequences (F08) ---
        if ch == '\\' && s.remaining() > 1 {
            if let Some(entity) = try_consume_entity(&mut s) {
                flush_text(&mut buf, &active_marks, &mut nodes);
                nodes.push(entity);
                continue;
            }
            if let Some(next) = s.peek_at(1) {
                if crate::serializer::ESCAPE_CHARS.contains(&next) {
                    buf.push(next);
                    s.advance(1 + next.len_utf8());
                    continue;
                }
            }
        }

        // --- Tokens ---
        if ch == '#' {
            if let Some(token) = try_consume_tag_ref(&mut s) {
                flush_text(&mut buf, &active_marks, &mut nodes);
                nodes.push(token);
                continue;
            }
        }
        if ch == '[' {
            if let Some(token) = try_consume_block_link(&mut s) {
                flush_text(&mut buf, &active_marks, &mut nodes);
                nodes.push(token);
                continue;
            }
            if let Some(token) = try_consume_footnote(&mut s) {
                flush_text(&mut buf, &active_marks, &mut nodes);
                nodes.push(token);
                continue;
            }
            if let Some(token) = try_consume_inactive_timestamp(&mut s) {
                flush_text(&mut buf, &active_marks, &mut nodes);
                nodes.push(token);
                continue;
            }
        }
        if ch == '<' {
            if let Some(token) = try_consume_active_timestamp(&mut s) {
                flush_text(&mut buf, &active_marks, &mut nodes);
                nodes.push(token);
                continue;
            }
        }

        // --- Mark toggles ---
        if let Some(mark) = char_to_mark(ch) {
            if mark == OrgMark::Code {
                // Open code span
                flush_text(&mut buf, &active_marks, &mut nodes);
                mark_opens.push((mark, s.pos, nodes.len()));
                active_marks.push(OrgMark::Code);
                in_code = true;
                s.advance(1);
                continue;
            }
            if active_marks.contains(&mark) {
                // Close mark
                flush_text(&mut buf, &active_marks, &mut nodes);
                active_marks.retain(|m| *m != mark);
                mark_opens.retain(|(m, _, _)| *m != mark);
                s.advance(1);
                continue;
            }
            // Open mark
            flush_text(&mut buf, &active_marks, &mut nodes);
            mark_opens.push((mark, s.pos, nodes.len()));
            active_marks.push(mark);
            s.advance(1);
            continue;
        }

        buf.push(ch);
        s.advance(ch.len_utf8());
    }

    // --- Unclosed mark revert ---
    if in_code {
        if let Some(pos) = mark_opens.iter().rposition(|(m, _, _)| *m == OrgMark::Code) {
            let (_, _, node_len) = mark_opens[pos];
            let reverted: Vec<InlineNode> = nodes.drain(node_len..).collect();
            buf = format!(
                "~{}{}",
                reverted.iter().map(node_to_plain_text).collect::<String>(),
                buf
            );
            mark_opens.remove(pos);
        }
        active_marks.retain(|m| *m != OrgMark::Code);
    }
    while let Some((mark, _, node_len)) = mark_opens.pop() {
        let reverted: Vec<InlineNode> = nodes.drain(node_len..).collect();
        buf = format!(
            "{}{}{}",
            mark_delimiter(mark),
            reverted.iter().map(node_to_plain_text).collect::<String>(),
            buf
        );
        active_marks.retain(|m| *m != mark);
    }

    // Flush remaining text
    if !buf.is_empty() {
        let merge = nodes
            .last()
            .map(|n| matches!(n, InlineNode::Text(t) if t.marks.is_empty()))
            .unwrap_or(false);
        if merge {
            if let Some(InlineNode::Text(ref mut t)) = nodes.last_mut() {
                t.text.push_str(&buf);
            }
        } else {
            nodes.push(InlineNode::Text(TextNode {
                text: buf,
                marks: Vec::new(),
            }));
        }
    }
    nodes
}

/// Flush the accumulated text buffer into a [`InlineNode::Text`] node with current marks.
fn flush_text(buf: &mut String, marks: &[OrgMark], nodes: &mut Vec<InlineNode>) {
    if !buf.is_empty() {
        nodes.push(InlineNode::Text(TextNode {
            text: std::mem::take(buf),
            marks: marks.to_vec(),
        }));
    }
}

/// Convert an inline node back to plain text (for unclosed-mark revert).
fn node_to_plain_text(node: &InlineNode) -> String {
    match node {
        InlineNode::Text(t) => t.text.clone(),
        InlineNode::TagRef { id } => format!("#[{id}]"),
        InlineNode::BlockLink { id } => format!("[[{id}]]"),
        InlineNode::Entity { name, .. } => format!("\\{name}"),
        InlineNode::Timestamp(ts) => {
            let (o, c) = if ts.active { ('<', '>') } else { ('[', ']') };
            match &ts.time {
                Some(t) => format!("{o}{} {t}{c}", ts.date),
                None => format!("{o}{}{c}", ts.date),
            }
        }
        InlineNode::FootnoteRef { label } => format!("[fn:{label}]"),
        InlineNode::HardBreak => "\n".to_string(),
    }
}

/// Parse Org-mode text into a document model.
pub fn parse(org: &str) -> OrgDoc {
    if org.is_empty() {
        return OrgDoc {
            paragraphs: Vec::new(),
        };
    }
    let paragraphs = org
        .split('\n')
        .map(|line| OrgParagraph {
            content: parse_line(line),
        })
        .collect();
    OrgDoc { paragraphs }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::serializer::{InlineNode, OrgMark, OrgTimestamp, TextNode};

    fn text(s: &str) -> InlineNode {
        InlineNode::Text(TextNode {
            text: s.to_string(),
            marks: Vec::new(),
        })
    }
    fn marked(s: &str, m: Vec<OrgMark>) -> InlineNode {
        InlineNode::Text(TextNode {
            text: s.to_string(),
            marks: m,
        })
    }

    #[test]
    fn parse_empty() {
        assert!(parse("").paragraphs.is_empty());
    }
    #[test]
    fn parse_plain() {
        assert_eq!(parse("hello").paragraphs[0].content, vec![text("hello")]);
    }
    #[test]
    fn parse_multi_para() {
        assert_eq!(parse("a\nb\nc").paragraphs.len(), 3);
    }
    #[test]
    fn parse_bold() {
        assert_eq!(
            parse("*hi*").paragraphs[0].content,
            vec![marked("hi", vec![OrgMark::Bold])]
        );
    }
    #[test]
    fn parse_italic() {
        assert_eq!(
            parse("/hi/").paragraphs[0].content,
            vec![marked("hi", vec![OrgMark::Italic])]
        );
    }
    #[test]
    fn parse_code() {
        assert_eq!(
            parse("~hi~").paragraphs[0].content,
            vec![marked("hi", vec![OrgMark::Code])]
        );
    }
    #[test]
    fn parse_bold_in_text() {
        assert_eq!(
            parse("a *b* c").paragraphs[0].content,
            vec![text("a "), marked("b", vec![OrgMark::Bold]), text(" c")]
        );
    }
    #[test]
    fn parse_unclosed_bold() {
        assert_eq!(parse("*x").paragraphs[0].content, vec![text("*x")]);
    }
    #[test]
    fn parse_unclosed_code() {
        assert_eq!(parse("~x").paragraphs[0].content, vec![text("~x")]);
    }
    #[test]
    fn parse_esc_bold() {
        assert_eq!(parse("\\*x\\*").paragraphs[0].content, vec![text("*x*")]);
    }
    #[test]
    fn parse_esc_italic() {
        assert_eq!(parse("\\/x\\/").paragraphs[0].content, vec![text("/x/")]);
    }
    #[test]
    fn parse_esc_backslash() {
        assert_eq!(parse("a\\\\b").paragraphs[0].content, vec![text("a\\b")]);
    }
    #[test]
    fn parse_tag_ref() {
        assert_eq!(
            parse("#[01ARZ3NDEKTSV4RRFFQ69G5FAV]").paragraphs[0].content,
            vec![InlineNode::TagRef {
                id: "01ARZ3NDEKTSV4RRFFQ69G5FAV".into()
            }]
        );
    }
    #[test]
    fn parse_block_link() {
        assert_eq!(
            parse("[[01ARZ3NDEKTSV4RRFFQ69G5FAV]]").paragraphs[0].content,
            vec![InlineNode::BlockLink {
                id: "01ARZ3NDEKTSV4RRFFQ69G5FAV".into()
            }]
        );
    }
    #[test]
    fn parse_entity() {
        assert_eq!(
            parse("\\alpha").paragraphs[0].content,
            vec![InlineNode::Entity {
                name: "alpha".into(),
                unicode: "\u{03B1}".into()
            }]
        );
    }
    #[test]
    fn parse_active_ts() {
        assert_eq!(
            parse("<2024-01-15 Mon>").paragraphs[0].content,
            vec![InlineNode::Timestamp(OrgTimestamp {
                active: true,
                date: "2024-01-15".into(),
                time: None
            })]
        );
    }
    #[test]
    fn parse_footnote() {
        assert_eq!(
            parse("[fn:1]").paragraphs[0].content,
            vec![InlineNode::FootnoteRef { label: "1".into() }]
        );
    }
    #[test]
    fn code_literal() {
        assert_eq!(
            parse("~*x*~").paragraphs[0].content,
            vec![marked("*x*", vec![OrgMark::Code])]
        );
    }

    // --- Tag ref early returns (lines 82, 87, 96) ---
    #[test]
    fn tag_ref_too_short() {
        let mut s = Scanner::new("#[AB]");
        assert!(
            try_consume_tag_ref(&mut s).is_none(),
            "input shorter than 29 bytes must not match as tag ref"
        );
        assert_eq!(s.pos, 0, "scanner must not advance on failed tag ref");
    }
    #[test]
    fn tag_ref_wrong_prefix() {
        // 29 bytes, passes length guard; second char is 'A' not '['
        let mut s = Scanner::new("#A01ARZ3NDEKTSV4RRFFQ69G5FAV]");
        assert!(
            try_consume_tag_ref(&mut s).is_none(),
            "tag ref with wrong prefix char should be rejected"
        );
    }
    #[test]
    fn tag_ref_invalid_ulid() {
        // Correct #[ ] framing but lowercase content fails ULID regex
        let mut s = Scanner::new("#[abcdefghijklmnopqrstuvwxyz]");
        assert!(
            try_consume_tag_ref(&mut s).is_none(),
            "tag ref with non-uppercase ULID content must be rejected"
        );
    }

    // --- Block link early returns (lines 108, 121) ---
    #[test]
    fn block_link_too_short() {
        let mut s = Scanner::new("[[AB]]");
        assert!(
            try_consume_block_link(&mut s).is_none(),
            "input shorter than 30 bytes must not match as block link"
        );
    }
    #[test]
    fn block_link_wrong_prefix() {
        // 30+ bytes, starts with '[' but second char is not '['
        let mut s = Scanner::new("[x01ARZ3NDEKTSV4RRFFQ69G5FAV]]");
        assert!(
            try_consume_block_link(&mut s).is_none(),
            "block link with wrong second bracket must be rejected"
        );
    }
    #[test]
    fn block_link_invalid_ulid() {
        // Correct [[ ]] framing but lowercase content fails ULID regex
        let mut s = Scanner::new("[[abcdefghijklmnopqrstuvwxyz]]");
        assert!(
            try_consume_block_link(&mut s).is_none(),
            "block link with non-uppercase ULID content must be rejected"
        );
    }

    // --- Entity early returns (lines 128, 146) ---
    #[test]
    fn entity_no_backslash() {
        let mut s = Scanner::new("alpha");
        assert!(
            try_consume_entity(&mut s).is_none(),
            "entity without leading backslash must not match"
        );
    }
    #[test]
    fn entity_unknown_name() {
        let mut s = Scanner::new("\\foobar");
        assert!(
            try_consume_entity(&mut s).is_none(),
            "unknown entity name must not match"
        );
    }

    // --- Active timestamp early return (line 153) ---
    #[test]
    fn active_ts_no_angle() {
        let mut s = Scanner::new("not a timestamp");
        assert!(
            try_consume_active_timestamp(&mut s).is_none(),
            "active timestamp without '<' must not match"
        );
    }

    // --- Inactive timestamps (lines 174, 177, 183-189, 309-310) ---
    #[test]
    fn inactive_ts_no_bracket() {
        let mut s = Scanner::new("not a timestamp");
        assert!(
            try_consume_inactive_timestamp(&mut s).is_none(),
            "inactive timestamp without '[' must not match"
        );
    }
    #[test]
    fn inactive_ts_rejects_double_bracket() {
        let mut s = Scanner::new("[[01ARZ3NDEKTSV4RRFFQ69G5FAV]]");
        assert!(
            try_consume_inactive_timestamp(&mut s).is_none(),
            "double bracket must be rejected to avoid block link ambiguity"
        );
    }
    #[test]
    fn inactive_ts_date_only() {
        let nodes = parse_line("[2025-01-15 Wed]");
        assert_eq!(
            nodes,
            vec![InlineNode::Timestamp(OrgTimestamp {
                active: false,
                date: "2025-01-15".into(),
                time: None,
            })]
        );
    }
    #[test]
    fn inactive_ts_with_time() {
        let nodes = parse_line("[2025-01-15 Wed 10:30]");
        assert_eq!(
            nodes,
            vec![InlineNode::Timestamp(OrgTimestamp {
                active: false,
                date: "2025-01-15".into(),
                time: Some("10:30".into()),
            })]
        );
    }
    #[test]
    fn inactive_ts_invalid() {
        let nodes = parse_line("[invalid]");
        assert_eq!(nodes, vec![text("[invalid]")]);
    }

    // --- Footnote early return (line 196) ---
    #[test]
    fn footnote_no_bracket() {
        let mut s = Scanner::new("not a footnote");
        assert!(
            try_consume_footnote(&mut s).is_none(),
            "footnote without '[' must not match"
        );
    }

    // --- Mark delimiters: italic and code (lines 218-219) ---
    #[test]
    fn parse_line_italic() {
        assert_eq!(
            parse_line("/italic/"),
            vec![marked("italic", vec![OrgMark::Italic])]
        );
    }
    #[test]
    fn parse_line_code() {
        assert_eq!(
            parse_line("~code~"),
            vec![marked("code", vec![OrgMark::Code])]
        );
    }
    #[test]
    fn parse_unclosed_italic() {
        // Exercises mark_delimiter(Italic) in the unclosed-mark revert path
        assert_eq!(parse_line("/x"), vec![text("/x")]);
    }

    // --- Text node merging (lines 385-386) ---
    #[test]
    fn text_merge_after_unclosed() {
        // "a *b" → plain "a " flushed, then unclosed bold reverts "*b",
        // trailing text merges with the preceding plain-text node.
        let nodes = parse_line("a *b");
        assert_eq!(nodes, vec![text("a *b")]);
    }

    // --- node_to_plain_text (lines 409-423) ---
    #[test]
    fn plain_text_of_tag_ref() {
        let n = InlineNode::TagRef {
            id: "01ARZ3NDEKTSV4RRFFQ69G5FAV".into(),
        };
        assert_eq!(node_to_plain_text(&n), "#[01ARZ3NDEKTSV4RRFFQ69G5FAV]");
    }
    #[test]
    fn plain_text_of_block_link() {
        let n = InlineNode::BlockLink {
            id: "01ARZ3NDEKTSV4RRFFQ69G5FAV".into(),
        };
        assert_eq!(node_to_plain_text(&n), "[[01ARZ3NDEKTSV4RRFFQ69G5FAV]]");
    }
    #[test]
    fn plain_text_of_entity() {
        let n = InlineNode::Entity {
            name: "alpha".into(),
            unicode: "\u{03B1}".into(),
        };
        assert_eq!(node_to_plain_text(&n), "\\alpha");
    }
    #[test]
    fn plain_text_of_active_ts() {
        let n = InlineNode::Timestamp(OrgTimestamp {
            active: true,
            date: "2024-01-15".into(),
            time: None,
        });
        assert_eq!(node_to_plain_text(&n), "<2024-01-15>");
    }
    #[test]
    fn plain_text_of_inactive_ts_no_time() {
        let n = InlineNode::Timestamp(OrgTimestamp {
            active: false,
            date: "2024-01-15".into(),
            time: None,
        });
        assert_eq!(node_to_plain_text(&n), "[2024-01-15]");
    }
    #[test]
    fn plain_text_of_inactive_ts_with_time() {
        let n = InlineNode::Timestamp(OrgTimestamp {
            active: false,
            date: "2024-01-15".into(),
            time: Some("10:30".into()),
        });
        assert_eq!(node_to_plain_text(&n), "[2024-01-15 10:30]");
    }
    #[test]
    fn plain_text_of_footnote() {
        let n = InlineNode::FootnoteRef {
            label: "abc".into(),
        };
        assert_eq!(node_to_plain_text(&n), "[fn:abc]");
    }
    #[test]
    fn plain_text_of_hard_break() {
        assert_eq!(node_to_plain_text(&InlineNode::HardBreak), "\n");
    }
}
