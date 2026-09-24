//! Folding the changes a page took after its source was read into the buffer
//! edited from that source (#5140): [`merge_outlines`].
//!
//! The three parses (the source the edit started from, the page's source now,
//! and the buffer) pair block by block on their `^ID` anchor, so a block is
//! merged against itself wherever each side put it, and the false conflicts a
//! line merge of the whole buffer would raise (two adjacent one-line blocks,
//! a block moved on one side and edited on the other, a block moved on both)
//! do not arise. Lines are merged only inside one block's content. Where both
//! sides changed a block differently, both versions are kept, the buffer's as
//! a new block directly before the page's, so no change is lost, and the save
//! reports it.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use agaric_core::word_diff::merge_lines;

use super::{AppError, import, outline_parents};

/// The buffer `mine`, edited from `base`, with the changes between `base` and
/// `current`, the page's source now, folded in: each block's content and
/// properties three-way merged, its parent and its place among its siblings
/// taken from whichever side moved it, and blocks either side added or kept
/// changed placed where that side put them. Every kept block of `current`
/// keeps its anchor; a block deleted on the page and changed or moved to
/// another parent in the buffer, and the buffer's version of a block both
/// sides changed differently, come back as new blocks, without one. Each event
/// the merge could not keep as written adds one warning.
///
/// # Errors
///
/// [`AppError::Validation`] — an anchor is written on two blocks of `mine`.
pub(super) fn merge_outlines(
    base: Vec<import::ParsedBlock>,
    current: &[import::ParsedBlock],
    mine: Vec<import::ParsedBlock>,
    warnings: &mut Vec<String>,
) -> Result<Vec<import::ParsedBlock>, AppError> {
    let mine = Side::new(mine, true);
    let mut seen = HashSet::new();
    if let Some(Key::Anchor(anchor)) = mine.keys.iter().find(|key| !seen.insert(*key)) {
        return Err(AppError::validation(format!(
            "^{anchor} is written on more than one block"
        )));
    }
    let mut merge = Merge {
        base: Side::new(base, false),
        current: Side::new(current.to_vec(), false),
        mine,
        kept: HashMap::new(),
        parents: HashMap::new(),
        warnings,
    };
    let keys: Vec<Key> = merge
        .current
        .keys
        .iter()
        .chain(
            merge
                .mine
                .keys
                .iter()
                .filter(|key| !merge.current.at.contains_key(key)),
        )
        .cloned()
        .collect();
    for key in &keys {
        if let Some(kept) = merge.keep(key) {
            merge.kept.insert(key.clone(), kept);
        }
    }
    merge.place(&keys);
    Ok(merge.emit())
}

/// What a block is merged as: its anchor, or, for a bullet of the buffer with
/// none, its place there.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum Key {
    Anchor(String),
    New(usize),
}

/// One of the three outlines, keyed.
struct Side {
    blocks: Vec<import::ParsedBlock>,
    keys: Vec<Key>,
    parents: Vec<Option<usize>>,
    at: HashMap<Key, usize>,
}

impl Side {
    /// `blocks` keyed by anchor. A bullet with none is a key of its own when
    /// `unanchored_are_new`, the buffer's case; on the other two sides, which
    /// the page rendered with an anchor on every block, it is dropped.
    fn new(mut blocks: Vec<import::ParsedBlock>, unanchored_are_new: bool) -> Self {
        blocks.iter_mut().for_each(import::restore_text_anchor);
        if !unanchored_are_new {
            blocks.retain(|block| block.block_anchor.is_some());
        }
        let keys: Vec<Key> = blocks
            .iter()
            .enumerate()
            .map(|(i, block)| match &block.block_anchor {
                Some(anchor) => Key::Anchor(anchor.clone()),
                None => Key::New(i),
            })
            .collect();
        Self {
            at: keys
                .iter()
                .enumerate()
                .map(|(i, key)| (key.clone(), i))
                .collect(),
            parents: outline_parents(&blocks),
            blocks,
            keys,
        }
    }

    fn block(&self, key: &Key) -> Option<&import::ParsedBlock> {
        self.at.get(key).map(|&i| &self.blocks[i])
    }

    /// `key`'s parent on this side: `None` when the side lacks the key,
    /// `Some(None)` when the block is at the top level.
    fn parent(&self, key: &Key) -> Option<Option<&Key>> {
        self.at
            .get(key)
            .map(|&i| self.parents[i].map(|parent| &self.keys[parent]))
    }

    /// `parent`, or, when it is not kept, the nearest ancestor of it on this
    /// side that is; `None` is the page.
    fn lift<'a>(&'a self, mut parent: Option<&'a Key>, kept: &HashMap<Key, Kept>) -> Option<Key> {
        while let Some(key) = parent
            && !kept.contains_key(key)
        {
            parent = self.parent(key).flatten();
        }
        parent.cloned()
    }

    /// Each parent's kept children this side has an opinion on: those under
    /// it here, once their parent here is lifted, that the merge put under it
    /// too, in this side's order.
    fn children(
        &self,
        kept: &HashMap<Key, Kept>,
        parents: &HashMap<Key, Option<Key>>,
    ) -> HashMap<Option<Key>, Vec<Key>> {
        let mut lists: HashMap<Option<Key>, Vec<Key>> = HashMap::new();
        for (i, key) in self.keys.iter().enumerate() {
            if !kept.contains_key(key) {
                continue;
            }
            let under = self.lift(self.parents[i].map(|parent| &self.keys[parent]), kept);
            if parents[key] == under {
                lists.entry(under).or_default().push(key.clone());
            }
        }
        lists
    }
}

/// A block the merge keeps: its fields merged, and, when both sides changed
/// it differently, the buffer's version, kept directly before it.
struct Kept {
    block: import::ParsedBlock,
    fork: Option<import::ParsedBlock>,
}

struct Merge<'a> {
    base: Side,
    current: Side,
    mine: Side,
    kept: HashMap<Key, Kept>,
    parents: HashMap<Key, Option<Key>>,
    warnings: &'a mut Vec<String>,
}

impl Merge<'_> {
    /// Whether `key`'s block is kept, and as what. A block one side deleted
    /// goes unless the other side changed it or moved it to another parent; a
    /// block both sides changed differently is kept twice.
    fn keep(&mut self, key: &Key) -> Option<Kept> {
        let (b, c, m) = (
            self.base.block(key),
            self.current.block(key),
            self.mine.block(key),
        );
        let fork = |c: &import::ParsedBlock, m: &import::ParsedBlock| Kept {
            block: c.clone(),
            fork: Some(unanchored(m.clone())),
        };
        match (b, c, m) {
            (Some(b), Some(c), Some(m)) => {
                if let Some(block) = merge_block(b, c, m) {
                    return Some(Kept { block, fork: None });
                }
                warn(
                    self.warnings,
                    c,
                    "was changed here and on the page; both versions kept",
                );
                Some(fork(c, m))
            }
            (Some(b), Some(c), None) => {
                if same(b, c) && self.current.parent(key) == self.base.parent(key) {
                    return None;
                }
                warn(
                    self.warnings,
                    c,
                    "changed on the page; your delete was not applied",
                );
                Some(Kept {
                    block: c.clone(),
                    fork: None,
                })
            }
            (Some(b), None, Some(m)) => {
                if same(b, m) && self.mine.parent(key) == self.base.parent(key) {
                    return None;
                }
                warn(
                    self.warnings,
                    m,
                    "was deleted on the page; saved as a new block",
                );
                Some(Kept {
                    block: unanchored(m.clone()),
                    fork: None,
                })
            }
            (None, Some(c), Some(m)) if !same(c, m) => {
                warn(
                    self.warnings,
                    c,
                    "was changed here and on the page; both versions kept",
                );
                Some(fork(c, m))
            }
            (None, Some(c), _) => Some(Kept {
                block: c.clone(),
                fork: None,
            }),
            (None, None, Some(m)) => Some(Kept {
                block: m.clone(),
                fork: None,
            }),
            (_, None, None) => None,
        }
    }

    /// Give each kept block its parent: the page's for a block the page holds,
    /// lifted over parents no longer kept, the buffer's for the rest; then, in
    /// the buffer's order, the buffer's where the buffer moved the block and
    /// the page did not, unless that would make a block its own ancestor,
    /// which is how both sides moving two blocks under each other comes out.
    /// The page's parents are a tree and every move is checked against the
    /// parents as they stand, so the result is one too.
    fn place(&mut self, keys: &[Key]) {
        for key in keys.iter().filter(|key| self.kept.contains_key(key)) {
            let parent = match self.current.parent(key) {
                Some(parent) => self.current.lift(parent, &self.kept),
                None => self.mine.lift(self.mine.parent(key).flatten(), &self.kept),
            };
            self.parents.insert(key.clone(), parent);
        }
        for key in self.mine.keys.clone() {
            if !self.kept.contains_key(&key) || !self.current.at.contains_key(&key) {
                continue;
            }
            let Some(wanted) = self.buffer_parent(&key) else {
                continue;
            };
            if wanted == self.parents[&key] {
                continue;
            }
            if self.is_ancestor(&key, wanted.as_ref()) {
                self.warn_moved(&key);
                continue;
            }
            self.parents.insert(key, wanted);
        }
    }

    /// Where the buffer's move of `key` stands: `Some` of the parent it gives
    /// the block, lifted, when the page left the block where it was; `None`
    /// to keep the page's parent, with a warning when both sides moved the
    /// block apart.
    fn buffer_parent(&mut self, key: &Key) -> Option<Option<Key>> {
        let (Some(cp), Some(mp)) = (self.current.parent(key), self.mine.parent(key)) else {
            return None;
        };
        if cp == mp {
            return None;
        }
        match self.base.parent(key) {
            Some(bp) if cp == bp => Some(self.mine.lift(mp, &self.kept)),
            Some(bp) if mp == bp => None,
            _ => {
                self.warn_moved(key);
                None
            }
        }
    }

    fn warn_moved(&mut self, key: &Key) {
        if let Some(block) = self.current.block(key) {
            warn(
                self.warnings,
                block,
                "was moved here and on the page; the page's place kept",
            );
        }
    }

    /// Whether `key` is `parent` or above it.
    fn is_ancestor<'a>(&'a self, key: &Key, mut parent: Option<&'a Key>) -> bool {
        while let Some(p) = parent {
            if p == key {
                return true;
            }
            parent = self.parents.get(p).and_then(Option::as_ref);
        }
        false
    }

    /// The kept blocks in depth-first order under the merged tree, each at its
    /// depth there, a fork directly before the block it forked from.
    fn emit(mut self) -> Vec<import::ParsedBlock> {
        let lists = [&self.base, &self.current, &self.mine]
            .map(|side| side.children(&self.kept, &self.parents));
        let mut out = Vec::new();
        let top = self.order(None, &lists);
        let mut stack: Vec<(Key, usize)> = top.into_iter().rev().map(|key| (key, 0)).collect();
        while let Some((key, depth)) = stack.pop() {
            let Kept { block, fork } = self
                .kept
                .remove(&key)
                .expect("a kept block is ordered under its one parent");
            for mut block in fork.into_iter().chain([block]) {
                block.depth = depth;
                out.push(block);
            }
            let children = self.order(Some(&key), &lists);
            stack.extend(children.into_iter().rev().map(|key| (key, depth + 1)));
        }
        out
    }

    /// `parent`'s kept children in order. The blocks all three sides have
    /// under it set which side's order is taken whole: the page's when the
    /// buffer kept the order they had, else the buffer's, with a warning when
    /// the page reordered them too, another way. Each block only the other
    /// side has under it goes after the nearest block before it on that side
    /// that is placed, or first.
    fn order(
        &mut self,
        parent: Option<&Key>,
        lists: &[HashMap<Option<Key>, Vec<Key>>; 3],
    ) -> Vec<Key> {
        let empty = Vec::new();
        let [in_base, in_current, in_mine] = lists
            .each_ref()
            .map(|lists| lists.get(&parent.cloned()).unwrap_or(&empty));
        let common: HashSet<&Key> = in_base
            .iter()
            .filter(|key| in_current.contains(key) && in_mine.contains(key))
            .collect();
        let [b, c, m] = [in_base, in_current, in_mine].map(|list| {
            list.iter()
                .filter(|key| common.contains(key))
                .collect::<Vec<_>>()
        });
        let (skeleton, other) = if m == b {
            (in_current, in_mine)
        } else {
            if c != b && c != m {
                let under = parent.and_then(|key| self.current.block(key).or(self.mine.block(key)));
                self.warnings.push(match under {
                    Some(block) => format!(
                        "the blocks under '{}' were reordered here and on the page; your order kept",
                        label(block)
                    ),
                    None => "the page's blocks were reordered here and on the page; your order kept".into(),
                });
            }
            (in_mine, in_current)
        };
        let mut order = skeleton.clone();
        for (i, key) in other.iter().enumerate() {
            if order.contains(key) {
                continue;
            }
            let after = other[..i]
                .iter()
                .rev()
                .find_map(|before| order.iter().position(|placed| placed == before));
            order.insert(after.map_or(0, |at| at + 1), key.clone());
        }
        order
    }
}

/// `c` and `m`, both edited from `b`, merged field by field: a field one side
/// left takes the other's value; content both changed is merged line by line.
/// `None` when a field was changed both ways and cannot be merged.
fn merge_block(
    b: &import::ParsedBlock,
    c: &import::ParsedBlock,
    m: &import::ParsedBlock,
) -> Option<import::ParsedBlock> {
    if same(b, c) {
        return Some(m.clone());
    }
    if same(b, m) || same(c, m) {
        return Some(c.clone());
    }
    let (content, is_code) = if c.content == b.content {
        (m.content.clone(), m.is_code)
    } else if m.content == b.content || c.content == m.content {
        (c.content.clone(), c.is_code)
    } else {
        // Code on either side stays code, so no `#tag` in the merged lines is
        // resolved as a name.
        (
            merge_lines(&b.content, &c.content, &m.content)?,
            c.is_code || m.is_code,
        )
    };
    let (of_b, of_c, of_m) = (properties(b), properties(c), properties(m));
    let keys: BTreeSet<&str> = of_b
        .keys()
        .chain(of_c.keys())
        .chain(of_m.keys())
        .copied()
        .collect();
    let mut merged = Vec::new();
    for key in keys {
        let (b, c, m) = (of_b.get(key), of_c.get(key), of_m.get(key));
        let value = if c == b {
            m
        } else if m == b || c == m {
            c
        } else {
            return None;
        };
        if let Some(value) = value {
            merged.push((key.to_owned(), (*value).to_owned()));
        }
    }
    Some(import::ParsedBlock {
        content,
        depth: c.depth,
        properties: merged,
        is_code,
        block_anchor: c.block_anchor.clone(),
    })
}

/// Whether the two versions of a block hold the same content and properties.
fn same(a: &import::ParsedBlock, b: &import::ParsedBlock) -> bool {
    a.content == b.content && properties(a) == properties(b)
}

/// A block's properties as the save reads them: the last line for a key wins.
fn properties(block: &import::ParsedBlock) -> BTreeMap<&str, &str> {
    block
        .properties
        .iter()
        .map(|(key, value)| (key.as_str(), value.as_str()))
        .collect()
}

fn unanchored(mut block: import::ParsedBlock) -> import::ParsedBlock {
    block.block_anchor = None;
    block
}

/// The block's first line, cut to 40 characters, as a warning names it.
fn label(block: &import::ParsedBlock) -> String {
    let line = block.content.lines().next().unwrap_or("");
    match line.char_indices().nth(40) {
        Some((at, _)) => format!("{}…", &line[..at]),
        None => line.to_owned(),
    }
}

fn warn(warnings: &mut Vec<String>, block: &import::ParsedBlock, what: &str) {
    warnings.push(format!("'{}' {what}", label(block)));
}

#[cfg(test)]
#[path = "markdown_source_merge_tests.rs"]
mod tests;
