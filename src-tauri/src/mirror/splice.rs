//! A page's new render written over its file block by block (#5363 slice 2,
//! #6277 H2): [`splice`].
//!
//! A file can hold what Agaric would write differently but reads the same: a
//! user's `*` bullets, `1)` markers, 4-space indents, front matter keys in
//! their own order. A write keeps those bytes for every block the render did
//! not change, and takes the render's lines only for the blocks that differ.

use std::collections::HashMap;

use agaric_engine::import::{self, ParseOutput, ParsedBlock};

/// `new`, a page's render with the id of the block starting on each of its
/// lines, written over `old`, the file as it stands with its own line ids:
/// the render's blocks in its order, each with `old`'s lines where `old` holds
/// that block as the render reads it, and the render's lines otherwise; the
/// front matter likewise. Returns the text and its line ids. When the result
/// would not read back as the render does, block for block, it is the render.
pub fn splice(
    old: &str,
    old_ids: &[Option<String>],
    new: &str,
    new_ids: &[Option<String>],
) -> (String, Vec<Option<String>>) {
    let rendered = || (new.to_owned(), new_ids.to_vec());
    let (Some(old), Some(new)) = (Laid::of(old, old_ids), Laid::of(new, new_ids)) else {
        return rendered();
    };
    let by_id: HashMap<&str, &Segment> = old
        .segments
        .iter()
        .rev()
        .filter_map(|segment| Some((segment.id.as_deref()?, segment)))
        .collect();
    let mut lines: Vec<&str> = Vec::new();
    let mut ids: Vec<Option<String>> = Vec::new();
    let front = if same_front(&old.parsed, &new.parsed) {
        &old.lines[..old.front_end]
    } else {
        &new.lines[..new.front_end]
    };
    lines.extend(front);
    ids.resize(lines.len(), None);
    for segment in &new.segments {
        let kept = segment
            .id
            .as_deref()
            .and_then(|id| by_id.get(id))
            .filter(|kept| same_block(&old, kept, &new, segment));
        let body = match kept {
            Some(kept) => &old.lines[kept.start..kept.body_end],
            None => &new.lines[segment.start..segment.body_end],
        };
        ids.push(segment.id.clone());
        ids.resize(lines.len() + body.len(), None);
        lines.extend(body);
        lines.extend(&new.lines[segment.body_end..segment.end]);
        ids.resize(lines.len(), None);
    }
    let text = lines.join("\n");
    match Laid::of(&text, &ids) {
        Some(written) if written.reads_as(&new) => (text, ids),
        _ => rendered(),
    }
}

/// A text laid out by its blocks.
struct Laid<'a> {
    lines: Vec<&'a str>,
    /// The lines before the first block: the front matter.
    front_end: usize,
    segments: Vec<Segment>,
    parsed: ParseOutput,
}

/// A block's lines: from its first, `start`, to `body_end`, its last line
/// that is not blank, plus one; the blank lines after it run to `end`, the
/// next block's first.
struct Segment {
    id: Option<String>,
    block: ParsedBlock,
    start: usize,
    body_end: usize,
    end: usize,
}

impl<'a> Laid<'a> {
    /// `None` when the ids are not one per line or a block has no line, so
    /// nothing can be kept from the text.
    fn of(text: &'a str, line_ids: &[Option<String>]) -> Option<Self> {
        let lines: Vec<&str> = text.split('\n').collect();
        if line_ids.len() != lines.len() {
            return None;
        }
        let mut parsed = import::parse_document_outline(text);
        let starts: Vec<usize> = parsed
            .blocks
            .iter()
            .map(|block| block.line?.checked_sub(1))
            .collect::<Option<_>>()?;
        if starts.windows(2).any(|pair| pair[0] >= pair[1])
            || starts.last().is_some_and(|&last| last >= lines.len())
        {
            return None;
        }
        let blocks = std::mem::take(&mut parsed.blocks);
        let segments = blocks
            .into_iter()
            .zip(&starts)
            .enumerate()
            .map(|(k, (block, &start))| {
                let end = starts.get(k + 1).copied().unwrap_or(lines.len());
                let mut body_end = end;
                while body_end > start + 1 && lines[body_end - 1].trim().is_empty() {
                    body_end -= 1;
                }
                Segment {
                    id: line_ids[start].clone(),
                    block,
                    start,
                    body_end,
                    end,
                }
            })
            .collect();
        Some(Self {
            front_end: starts.first().copied().unwrap_or(lines.len()),
            lines,
            segments,
            parsed,
        })
    }

    /// Whether this reads as `other` does: the same front matter and the
    /// same blocks, each under the same id, in the same order.
    fn reads_as(&self, other: &Laid) -> bool {
        same_front(&self.parsed, &other.parsed)
            && self.segments.len() == other.segments.len()
            && self
                .segments
                .iter()
                .zip(&other.segments)
                .all(|(a, b)| a.id == b.id && same_block(self, a, other, b))
    }
}

fn same_front(a: &ParseOutput, b: &ParseOutput) -> bool {
    a.frontmatter == b.frontmatter
        && a.frontmatter_list_items == b.frontmatter_list_items
        && a.frontmatter_refusal.is_none()
        && b.frontmatter_refusal.is_none()
}

/// Whether two blocks read the same, list number included: a number the
/// render changed is written, though the reader ignores it.
fn same_block(a_text: &Laid, a: &Segment, b_text: &Laid, b: &Segment) -> bool {
    let (x, y) = (&a.block, &b.block);
    x.content == y.content
        && x.depth == y.depth
        && x.properties == y.properties
        && x.is_code == y.is_code
        && x.block_anchor == y.block_anchor
        && list_number(a_text.lines[a.start]) == list_number(b_text.lines[b.start])
}

/// The number an ordered list item's line starts with.
fn list_number(line: &str) -> Option<&str> {
    let rest = line.trim_start();
    let digits = rest.len() - rest.trim_start_matches(|c: char| c.is_ascii_digit()).len();
    let after = rest[digits..].chars().next();
    (digits > 0 && matches!(after, Some('.' | ')'))).then(|| &rest[..digits])
}

#[cfg(test)]
#[path = "splice_tests.rs"]
mod tests;
