//! What a remote purge must not take: text this device wrote that the purging
//! device never received (#6561).
//!
//! A purge deletes one tree node; every block under it dies with it, including
//! a block created here while the two devices were out of contact. Such a
//! block is still a node under the deleted one, and Loro lets it be moved out,
//! so it is kept: moved, with its subtree, under a new page in the Trash.
//!
//! A block is kept only when both hold. This device created its node, and the
//! delete is causally concurrent with that creation, which is the doc's own
//! record that the purging device had not seen the block. Anything else
//! (a comparison that cannot be made included) is purged as before: a block
//! the purge had seen must stay purged, or the two devices would trade it
//! back and forth.

use std::collections::{BTreeMap, HashMap, HashSet};

use agaric_core::error::AppError;
use agaric_core::ulid::BlockId;
use loro::{Frontiers, ID, TreeID, TreeParentId};

use super::{FIELD_BLOCK_TYPE, FIELD_CONTENT, LoroEngine, read_string, read_text};

/// A page in the Trash that now holds blocks a remote purge would have taken.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeptLocalText {
    pub page_id: BlockId,
    /// The purged page's title, or the first line of the purged parent block.
    pub title: String,
}

impl LoroEngine {
    /// Keeps the blocks of `before` (the index as it stood before an import)
    /// that the import orphaned, this device created, and the purge never saw.
    /// The caller rebuilds the index when the result is not empty.
    pub(super) fn keep_unseen_local_blocks(
        &mut self,
        before: &HashMap<String, TreeID>,
    ) -> Result<Vec<KeptLocalText>, AppError> {
        let unseen: HashSet<TreeID> = before
            .iter()
            .filter(|(id, node)| !self.index.contains_key(*id) && self.purge_never_saw(**node))
            .map(|(_, node)| *node)
            .collect();
        let tree = self.tree();
        // One Trash page per purged page, in a stable order.
        let mut by_origin: BTreeMap<TreeID, Vec<TreeID>> = BTreeMap::new();
        for &node in &unseen {
            let under_kept =
                matches!(tree.parent(node), Some(TreeParentId::Node(p)) if unseen.contains(&p));
            if !under_kept && self.first_line_under(node).is_some() {
                by_origin
                    .entry(self.purged_page_above(node))
                    .or_default()
                    .push(node);
            }
        }
        let mut kept = Vec::new();
        for (origin, mut roots) in by_origin {
            roots.sort_unstable();
            let page_id = BlockId::new();
            let title = self.kept_page_title(origin, roots[0])?;
            self.apply_create_block_at(page_id.as_str(), "page", &title, None, usize::MAX)?;
            let page = TreeParentId::Node(self.node_for(page_id.as_str()).ok_or_else(|| {
                AppError::validation(format!("loro: kept page {page_id} has no node"))
            })?);
            for root in roots {
                tree.mov(root, page).map_err(|e| {
                    AppError::validation(format!("loro: keep block under {page_id}: {e}"))
                })?;
            }
            self.doc.commit();
            self.apply_delete_block(page_id.as_str(), &agaric_store::db::now_ms().to_string())?;
            kept.push(KeptLocalText { page_id, title });
        }
        Ok(kept)
    }

    /// This device created `node`, an ancestor of it was deleted, and that
    /// delete is concurrent with the creation.
    fn purge_never_saw(&self, node: TreeID) -> bool {
        if node.peer != self.doc.peer_id() {
            return false;
        }
        let tree = self.tree();
        let mut deleted = node;
        while let Some(TreeParentId::Node(parent)) = tree.parent(deleted) {
            deleted = parent;
        }
        let Some(delete_op) = tree.get_last_move_id(&deleted) else {
            return false;
        };
        let created = Frontiers::from_id(ID::new(node.peer, node.counter));
        matches!(
            self.doc
                .cmp_frontiers(&Frontiers::from_id(delete_op), &created),
            Ok(None)
        )
    }

    /// The nearest page above `node`, or the deleted block at the top of its
    /// chain when no page lies between.
    fn purged_page_above(&self, node: TreeID) -> TreeID {
        let tree = self.tree();
        let mut top = node;
        while let Some(TreeParentId::Node(parent)) = tree.parent(top) {
            top = parent;
            if self.meta_string(top, FIELD_BLOCK_TYPE).as_deref() == Some("page") {
                break;
            }
        }
        top
    }

    /// `origin`'s first line; the first kept block's when `origin` is blank.
    fn kept_page_title(&self, origin: TreeID, first_kept: TreeID) -> Result<String, AppError> {
        let line = self
            .first_line(origin)
            .or_else(|| self.first_line_under(first_kept))
            .ok_or_else(|| AppError::validation("loro: a kept block has no text".to_owned()))?;
        Ok(line)
    }

    fn first_line_under(&self, node: TreeID) -> Option<String> {
        self.first_line(node).or_else(|| {
            self.tree()
                .children(TreeParentId::Node(node))
                .unwrap_or_default()
                .into_iter()
                .find_map(|child| self.first_line_under(child))
        })
    }

    fn first_line(&self, node: TreeID) -> Option<String> {
        let text = self.node_text(node)?;
        text.lines()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .map(str::to_owned)
    }

    fn node_text(&self, node: TreeID) -> Option<String> {
        let meta = self.tree().get_meta(node).ok()?;
        read_text(&meta, FIELD_CONTENT).ok()
    }

    fn meta_string(&self, node: TreeID, field: &str) -> Option<String> {
        let meta = self.tree().get_meta(node).ok()?;
        read_string(&meta, field).ok()
    }
}

#[cfg(test)]
mod tests {
    use super::super::{ImportDelta, LoroEngine};

    /// A holds page `P` ("Trip notes") with the block `OLD`; B starts from A's
    /// snapshot.
    fn pair() -> (LoroEngine, LoroEngine) {
        let mut a = LoroEngine::with_peer_id("DEV-A").unwrap();
        a.apply_create_block("P", "page", "Trip notes", None, 0)
            .unwrap();
        a.apply_create_block("OLD", "content", "both have this", Some("P"), 0)
            .unwrap();
        let mut b = LoroEngine::with_peer_id("DEV-B").unwrap();
        b.import(&a.export_snapshot().unwrap()).unwrap();
        (a, b)
    }

    fn pull(from: &LoroEngine, to: &mut LoroEngine) -> ImportDelta {
        let update = from.export_update_since(&to.version_vector()).unwrap();
        to.import_with_changed_purged_tagscope(&update).unwrap()
    }

    fn ids(blocks: &[agaric_core::ulid::BlockId]) -> Vec<String> {
        let mut ids: Vec<String> = blocks.iter().map(|b| b.as_str().to_owned()).collect();
        ids.sort();
        ids
    }

    #[test]
    fn a_block_written_here_that_the_purge_never_saw_is_kept_in_the_trash_6561() {
        let (mut a, mut b) = pair();
        b.apply_create_block("NEW", "content", "written on B", Some("P"), 1)
            .unwrap();
        b.apply_create_block("NEWCHILD", "content", "and its child", Some("NEW"), 0)
            .unwrap();
        a.apply_purge_block("P").unwrap();

        let delta = pull(&a, &mut b);

        assert_eq!(
            delta.kept.len(),
            1,
            "one Trash page for the one purged page"
        );
        let page = delta.kept[0].page_id.as_str();
        assert_eq!(delta.kept[0].title, "Trip notes");
        assert_eq!(ids(&delta.purged), vec!["OLD", "P"], "what A had is purged");
        let snapshot = b.read_block(page).unwrap().expect("the Trash page exists");
        assert_eq!(
            (snapshot.block_type.as_str(), snapshot.content.as_str()),
            ("page", "Trip notes")
        );
        assert!(
            b.read_deleted_at(page).unwrap().is_some(),
            "the page is in the Trash"
        );
        assert_eq!(b.read_parent("NEW").unwrap().as_deref(), Some(page));
        assert_eq!(b.read_parent("NEWCHILD").unwrap().as_deref(), Some("NEW"));
        assert_eq!(
            b.read_block("NEW").unwrap().unwrap().content,
            "written on B",
            "same block, same text"
        );
        let mut changed = ids(&delta.changed);
        changed.retain(|id| id != page);
        assert_eq!(
            changed,
            vec!["NEW", "NEWCHILD"],
            "the kept blocks reproject"
        );
    }

    #[test]
    fn a_block_the_purging_device_had_received_is_purged_6561() {
        let (mut a, mut b) = pair();
        b.apply_create_block("NEW", "content", "written on B", Some("P"), 1)
            .unwrap();
        pull(&b, &mut a);
        a.apply_purge_block("P").unwrap();

        let delta = pull(&a, &mut b);

        assert_eq!(delta.kept, Vec::new());
        assert_eq!(ids(&delta.purged), vec!["NEW", "OLD", "P"]);
        assert!(!b.contains_block("NEW"));
    }

    #[test]
    fn a_block_another_device_wrote_is_not_kept_here_6561() {
        let (mut a, mut b) = pair();
        let mut c = LoroEngine::with_peer_id("DEV-C").unwrap();
        c.import(&a.export_snapshot().unwrap()).unwrap();
        c.apply_create_block("FROMC", "content", "written on C", Some("P"), 1)
            .unwrap();
        pull(&c, &mut b);
        a.apply_purge_block("P").unwrap();

        let delta = pull(&a, &mut b);

        assert_eq!(
            delta.kept,
            Vec::new(),
            "only the device that wrote it keeps it"
        );
        assert_eq!(ids(&delta.purged), vec!["FROMC", "OLD", "P"]);
    }

    #[test]
    fn a_block_only_moved_under_the_purged_page_is_purged_6561() {
        let (mut a, mut b) = pair();
        b.apply_create_block("Q", "page", "Other page", None, 1)
            .unwrap();
        b.apply_create_block("MOVED", "content", "written on B, synced", Some("Q"), 0)
            .unwrap();
        pull(&b, &mut a);
        b.apply_move_block("MOVED", Some("P"), 1).unwrap();
        a.apply_purge_block("P").unwrap();

        let delta = pull(&a, &mut b);

        assert_eq!(delta.kept, Vec::new(), "deleted wins for a move");
        assert_eq!(ids(&delta.purged), vec!["MOVED", "OLD", "P"]);
    }

    #[test]
    fn a_blank_block_is_not_kept_6561() {
        let (mut a, mut b) = pair();
        b.apply_create_block("EMPTY", "content", "  ", Some("P"), 1)
            .unwrap();
        b.apply_create_block("EMPTYCHILD", "content", "", Some("EMPTY"), 0)
            .unwrap();
        a.apply_purge_block("P").unwrap();

        let delta = pull(&a, &mut b);

        assert_eq!(delta.kept, Vec::new());
        assert_eq!(ids(&delta.purged), vec!["EMPTY", "EMPTYCHILD", "OLD", "P"]);
    }

    #[test]
    fn a_purged_parent_block_titles_the_trash_page_with_its_first_line_6561() {
        let (mut a, mut b) = pair();
        b.apply_create_block("NEW", "content", "under the old block", Some("OLD"), 0)
            .unwrap();
        a.apply_purge_block("OLD").unwrap();

        let delta = pull(&a, &mut b);

        assert_eq!(delta.kept.len(), 1);
        assert_eq!(delta.kept[0].title, "both have this");
        assert!(b.contains_block("P"), "the page was not purged");
        assert_eq!(
            b.read_parent("NEW").unwrap().as_deref(),
            Some(delta.kept[0].page_id.as_str())
        );
    }

    #[test]
    fn a_blank_purged_parent_leaves_the_title_to_the_first_kept_line_6561() {
        let (mut a, mut b) = pair();
        a.apply_create_block("BLANK", "content", "", Some("P"), 1)
            .unwrap();
        pull(&a, &mut b);
        b.apply_create_block(
            "NEW",
            "content",
            "\n  kept line  \nsecond line",
            Some("BLANK"),
            0,
        )
        .unwrap();
        a.apply_purge_block("BLANK").unwrap();

        let delta = pull(&a, &mut b);

        assert_eq!(delta.kept.len(), 1);
        assert_eq!(delta.kept[0].title, "kept line");
    }

    #[test]
    fn the_nearest_purged_page_titles_the_trash_page_6561() {
        let (mut a, mut b) = pair();
        a.apply_create_block("INNER", "page", "Inner page", Some("P"), 1)
            .unwrap();
        pull(&a, &mut b);
        b.apply_create_block("NEW", "content", "under the inner page", Some("INNER"), 0)
            .unwrap();
        a.apply_purge_block("P").unwrap();

        let delta = pull(&a, &mut b);

        assert_eq!(delta.kept.len(), 1);
        assert_eq!(delta.kept[0].title, "Inner page");
    }

    /// The rescue reaches A as ordinary ops, A purging the kept page then
    /// purges it on B for good, and no round creates a second Trash page.
    #[test]
    fn both_devices_converge_and_a_later_purge_is_final_6561() {
        let (mut a, mut b) = pair();
        b.apply_create_block("NEW", "content", "written on B", Some("P"), 1)
            .unwrap();
        a.apply_purge_block("P").unwrap();
        let page = pull(&a, &mut b).kept[0].page_id.clone();

        let on_a = pull(&b, &mut a);
        assert_eq!(on_a.kept, Vec::new(), "A rescues nothing");
        assert_eq!(
            a.read_parent("NEW").unwrap().as_deref(),
            Some(page.as_str())
        );
        assert_eq!(
            a.read_deleted_at(page.as_str()).unwrap(),
            b.read_deleted_at(page.as_str()).unwrap(),
            "in the Trash on A as on B"
        );
        let echo = pull(&a, &mut b);
        assert_eq!(
            (echo.kept.len(), echo.purged.len()),
            (0, 0),
            "nothing more to do"
        );
        assert_eq!(a.version_vector(), b.version_vector());

        a.apply_purge_block(page.as_str()).unwrap();
        let last = pull(&a, &mut b);
        assert_eq!(last.kept, Vec::new(), "A had seen it: purged for good");
        let mut expected = vec!["NEW".to_owned(), page.as_str().to_owned()];
        expected.sort();
        assert_eq!(ids(&last.purged), expected);
        pull(&b, &mut a);
        assert_eq!(a.version_vector(), b.version_vector());
        assert!(!a.contains_block("NEW") && !b.contains_block("NEW"));
    }
}
