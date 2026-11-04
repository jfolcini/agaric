//! Giving the blocks of a text edited outside Agaric the ids they had when it
//! was last written (#6277 decision 6): [`pair_unanchored_lines`].
//!
//! A file carries an id only on a block something addresses (its `^ID`
//! anchor); every other block is found again by its text, against the text
//! and line ids last written for the page. Content alone is compared, so a
//! block that only changed depth keeps its id.

use std::collections::{HashMap, HashSet};

use super::{id_lines, import};

/// The ids for the lines of `text`, a page's source as the save reads it
/// (anchor-free, `line_ids` holding the ids its anchors gave, one entry per
/// line), with every block that carries none paired against `base_text`, the
/// text last written for the page, whose `base_line_ids` give every block's
/// id on the line it starts on.
///
/// An id `line_ids` carries is kept and taken out of the pairing. The other
/// blocks pair, in order: the longest common subsequence of identical blocks;
/// then an identical block elsewhere, as a move; then, between two pairs, a
/// run of changed blocks as long as the run it replaced, block for block, as
/// edits in place. A block left over is new and gets no id; so a block moved
/// and edited at once, or one of several identical blocks, may come back new.
/// The result is `line_ids` with the paired blocks' ids added on the lines
/// they start on, ready for [`super::apply_page_source_inner`].
pub fn pair_unanchored_lines(
    base_text: &str,
    base_line_ids: &[Option<String>],
    text: &str,
    line_ids: &[Option<String>],
) -> Vec<Option<String>> {
    let anchored: HashSet<&str> = line_ids.iter().flatten().map(String::as_str).collect();
    let base: Vec<Block> = blocks(base_text, base_line_ids)
        .into_iter()
        .filter(|block| block.id.is_some_and(|id| !anchored.contains(id)))
        .collect();
    let edited: Vec<Block> = blocks(text, line_ids)
        .into_iter()
        .filter(|block| block.id.is_none())
        .collect();
    let pairs = pair(&base, &edited);
    let mut out = line_ids.to_vec();
    for (b, e) in pairs {
        if let Some(slot) = out.get_mut(edited[e].line - 1) {
            *slot = base[b].id.map(str::to_owned);
        }
    }
    out
}

/// A block of a text: the line it starts on, counted from 1, the id that
/// line carries and what it holds.
struct Block<'a> {
    line: usize,
    id: Option<&'a str>,
    key: (String, Vec<(String, String)>),
}

fn blocks<'a>(text: &str, line_ids: &'a [Option<String>]) -> Vec<Block<'a>> {
    import::parse_document_text(text, &id_lines(line_ids))
        .blocks
        .into_iter()
        .filter_map(|block| {
            let line = block.line?;
            Some(Block {
                line,
                id: line_ids.get(line - 1).and_then(Option::as_deref),
                key: (block.content, block.properties),
            })
        })
        .collect()
}

/// The `(base, edited)` index pairs, by the three passes
/// [`pair_unanchored_lines`] gives.
fn pair(base: &[Block], edited: &[Block]) -> Vec<(usize, usize)> {
    let mut pairs = common_subsequence(base, edited);
    let (mut base_used, mut edited_used): (HashSet<usize>, HashSet<usize>) =
        pairs.iter().copied().unzip();
    let mut unpaired: HashMap<&(String, Vec<(String, String)>), Vec<usize>> = HashMap::new();
    for (b, block) in base.iter().enumerate().rev() {
        if !base_used.contains(&b) {
            unpaired.entry(&block.key).or_default().push(b);
        }
    }
    let mut moves = Vec::new();
    for (e, block) in edited.iter().enumerate() {
        if edited_used.contains(&e) {
            continue;
        }
        if let Some(b) = unpaired.get_mut(&block.key).and_then(Vec::pop) {
            moves.push((b, e));
        }
    }
    base_used.extend(moves.iter().map(|&(b, _)| b));
    edited_used.extend(moves.iter().map(|&(_, e)| e));
    let mut bounds = pairs.clone();
    bounds.push((base.len(), edited.len()));
    let mut from = (0, 0);
    for (b_end, e_end) in bounds {
        let gap_base: Vec<usize> = (from.0..b_end).filter(|b| !base_used.contains(b)).collect();
        let gap_edited: Vec<usize> = (from.1..e_end)
            .filter(|e| !edited_used.contains(e))
            .collect();
        if gap_base.len() == gap_edited.len() {
            pairs.extend(gap_base.into_iter().zip(gap_edited));
        }
        from = (b_end + 1, e_end + 1);
    }
    pairs.extend(moves);
    pairs
}

/// The longest common subsequence of `base` and `edited` by block content,
/// as `(base, edited)` index pairs in order.
/// The table is quadratic, so the common head and tail, all of a typical edit
/// but its changed blocks, are paired before it is built.
fn common_subsequence(base: &[Block], edited: &[Block]) -> Vec<(usize, usize)> {
    let head = base
        .iter()
        .zip(edited)
        .take_while(|(b, e)| b.key == e.key)
        .count();
    let tail = base[head..]
        .iter()
        .rev()
        .zip(edited[head..].iter().rev())
        .take_while(|(b, e)| b.key == e.key)
        .count();
    let (base_mid, edited_mid) = (
        &base[head..base.len() - tail],
        &edited[head..edited.len() - tail],
    );
    let mut pairs: Vec<(usize, usize)> = (0..head).map(|i| (i, i)).collect();
    pairs.extend(
        table_subsequence(base_mid, edited_mid)
            .into_iter()
            .map(|(b, e)| (head + b, head + e)),
    );
    pairs.extend((0..tail).map(|k| (base_mid.len() + head + k, edited_mid.len() + head + k)));
    pairs
}

fn table_subsequence(base: &[Block], edited: &[Block]) -> Vec<(usize, usize)> {
    let (n, m) = (base.len(), edited.len());
    // `len[i][j]`: the subsequence's length over `base[i..]` and `edited[j..]`.
    let mut len = vec![vec![0_usize; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            len[i][j] = if base[i].key == edited[j].key {
                len[i + 1][j + 1] + 1
            } else {
                len[i + 1][j].max(len[i][j + 1])
            };
        }
    }
    let mut pairs = Vec::new();
    let (mut i, mut j) = (0, 0);
    while i < n && j < m {
        if base[i].key == edited[j].key {
            pairs.push((i, j));
            i += 1;
            j += 1;
        } else if len[i + 1][j] >= len[i][j + 1] {
            i += 1;
        } else {
            j += 1;
        }
    }
    pairs
}

#[cfg(test)]
#[path = "markdown_source_pair_tests.rs"]
mod tests;
