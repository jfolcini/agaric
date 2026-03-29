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

struct Scanner<'a> {
    src: &'a str,
    pos: usize,
}

impl<'a> Scanner<'a> {
    fn new(src: &'a str) -> Self {
        Self { src, pos: 0 }
    }
    fn peek(&self) -> Option<char> {
        self.src[self.pos..].chars().next()
    }
    fn peek_at(&self, offset: usize) -> Option<char> {
        self.src[self.pos..].chars().nth(offset)
    }
    fn remaining(&self) -> usize {
        self.src.len() - self.pos
    }
    fn advance(&mut self, n: usize) {
        self.pos = (self.pos + n).min(self.src.len());
    }
    fn rest(&self) -> &'a str {
        &self.src[self.pos..]
    }
}

// ---------------------------------------------------------------------------
// Token consumers
// ---------------------------------------------------------------------------

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

fn try_consume_entity(s: &mut Scanner) -> Option<InlineNode> {
    if s.peek() != Some('\\') {
        return None;
    }
    let rest = &s.rest()[1..];
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

fn mark_delimiter(mark: OrgMark) -> char {
    match mark {
        OrgMark::Bold => '*',
        OrgMark::Italic => '/',
        OrgMark::Code => '~',
    }
}

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

fn flush_text(buf: &mut String, marks: &[OrgMark], nodes: &mut Vec<InlineNode>) {
    if !buf.is_empty() {
        nodes.push(InlineNode::Text(TextNode {
            text: std::mem::take(buf),
            marks: marks.to_vec(),
        }));
    }
}

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
}
