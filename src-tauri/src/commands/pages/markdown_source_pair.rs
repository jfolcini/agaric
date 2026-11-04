//! Giving the blocks of a text edited outside Agaric the ids they had when it
//! was last written (#6277 decision 6): [`pair_unanchored_lines`].
//!
//! A file carries an id only on a block something addresses (its `^ID`
//! anchor); every other block is found again by its content and properties,
//! against the text and line ids last written for the page. Depth is not
//! compared, so a block that only moved under a neighbour keeps its id.

use std::collections::{HashMap, HashSet};

use agaric_core::word_diff::equal_pairs;

use super::{id_lines, import};

/// The ids for the lines of `text`, a page's source as the save reads it
/// (anchor-free, `line_ids` holding the ids its anchors gave, one entry per
/// line), with every block that carries none paired against `base_text`, the
/// text last written for the page, whose `base_line_ids` give every block's
/// id on the line it starts on.
///
/// An anchored block stays where its id puts it and only pairs with the block
/// of that id. The other blocks pair, in order: the longest common
/// subsequence of identical blocks, anchored ones included; then an identical
/// block elsewhere, as a move; then, between two pairs, a run of changed
/// blocks as long as the run it replaced, block for block, as edits in place.
/// A block left over is new and gets no id; so a block moved and edited at
/// once, or one of several identical blocks, may come back new. The result is
/// `line_ids` with the paired blocks' ids added on the lines they start on,
/// ready for [`super::apply_page_source_inner`].
pub fn pair_unanchored_lines(
    base_text: &str,
    base_line_ids: &[Option<String>],
    text: &str,
    line_ids: &[Option<String>],
) -> Vec<Option<String>> {
    let anchored: HashSet<&str> = line_ids.iter().flatten().map(String::as_str).collect();
    let base: Vec<Block> = blocks(base_text, base_line_ids, &anchored)
        .into_iter()
        .filter(|block| block.id.is_some())
        .collect();
    let edited = blocks(text, line_ids, &anchored);
    let mut out = line_ids.to_vec();
    for (b, e) in pair(&base, &edited) {
        if let Some(slot @ None) = out.get_mut(edited[e].line - 1) {
            *slot = base[b].id.map(str::to_owned);
        }
    }
    out
}

/// What a block is compared by: the id an anchor of the edited text gives it,
/// or else its content and properties.
#[derive(PartialEq, Eq, Hash)]
enum Key<'a> {
    Anchored(&'a str),
    Text(String, Vec<(String, String)>),
}

/// A block of a text: the line it starts on, counted from 1, the id that
/// line carries and what it is compared by.
struct Block<'a> {
    line: usize,
    id: Option<&'a str>,
    key: Key<'a>,
}

fn blocks<'a>(
    text: &str,
    line_ids: &'a [Option<String>],
    anchored: &HashSet<&str>,
) -> Vec<Block<'a>> {
    import::parse_document_text(text, &id_lines(line_ids))
        .blocks
        .into_iter()
        .filter_map(|block| {
            let line = block.line?;
            let id = line_ids.get(line - 1).and_then(Option::as_deref);
            let key = match id {
                Some(id) if anchored.contains(id) => Key::Anchored(id),
                _ => Key::Text(block.content, block.properties),
            };
            Some(Block { line, id, key })
        })
        .collect()
}

fn keys<'b>(blocks: &'b [Block<'_>]) -> Vec<&'b Key<'b>> {
    blocks.iter().map(|block| &block.key).collect()
}

/// The `(base, edited)` index pairs, by the three passes
/// [`pair_unanchored_lines`] gives.
fn pair(base: &[Block], edited: &[Block]) -> Vec<(usize, usize)> {
    let mut pairs = equal_pairs(&keys(base), &keys(edited));
    let (mut base_used, mut edited_used): (HashSet<usize>, HashSet<usize>) =
        pairs.iter().copied().unzip();
    let mut unpaired: HashMap<&Key, Vec<usize>> = HashMap::new();
    for (b, block) in base.iter().enumerate().rev() {
        if !base_used.contains(&b) {
            unpaired.entry(&block.key).or_default().push(b);
        }
    }
    let moves: Vec<(usize, usize)> = edited
        .iter()
        .enumerate()
        .filter(|(e, _)| !edited_used.contains(e))
        .filter_map(|(e, block)| Some((unpaired.get_mut(&block.key)?.pop()?, e)))
        .collect();
    base_used.extend(moves.iter().map(|&(b, _)| b));
    edited_used.extend(moves.iter().map(|&(_, e)| e));
    // An anchored block pairs only by its id, never by its place.
    edited_used.extend((0..edited.len()).filter(|&e| edited[e].id.is_some()));
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

#[cfg(test)]
#[path = "markdown_source_pair_tests.rs"]
mod tests;
