//! One-time legacy (pre-#400) sibling-order migration for [`LoroEngine`].
//!
//! Reorders a pre-#400 doc's children onto Loro's native fractional index
//! (reproducing the old `ORDER BY position ASC, id ASC`) exactly once at
//! import time, then stamps the scheme marker. Isolated here so this
//! eventually-deletable code stays out of the hot apply/read path (#1262).

use super::*;

impl LoroEngine {
    /// Non-fatal wrapper used by the import paths: a migration failure is logged
    /// but never propagated, so a single bad doc cannot abort import and leave
    /// the space without an engine (#400, review).
    pub(super) fn migrate_legacy_sibling_order_best_effort(&mut self) {
        if let Err(e) = self.migrate_legacy_sibling_order_if_needed() {
            tracing::error!(
                error = %e,
                "loro import: legacy sibling-order migration failed; installing the \
                 doc UNMIGRATED rather than failing import (siblings may be \
                 transiently mis-ordered until the next reorder)"
            );
        }
    }
    /// Migrate the doc's sibling order onto the fractional index if it is a
    /// genuine pre-#400 doc; otherwise just stamp the marker. Returns `Err` only
    /// on a Loro failure; callers on the import path use the best-effort wrapper.
    pub(super) fn migrate_legacy_sibling_order_if_needed(&mut self) -> Result<(), AppError> {
        if self.sibling_order_version() >= SIBLING_ORDER_VERSION {
            return Ok(());
        }
        if self.any_node_has_legacy_position() {
            self.migrate_legacy_sibling_order()?;
        } else {
            self.mark_sibling_order_current();
            self.doc.commit();
        }
        Ok(())
    }
    /// One-time migration of a pre-#400 doc: reorder every parent's children to
    /// the legacy `ORDER BY position ASC, id ASC` and stamp the scheme marker.
    ///
    /// Needed because the old engine sorted siblings by the `position` meta and
    /// never used `create_at`/`mov_to`, so the tree's fractional index reflects
    /// creation/reparent order, not what the user saw. We re-place each child at
    /// its position-sorted slot via `mov_to`, which assigns fractional indices
    /// in that order. Idempotent at the call site via the version marker.
    pub(super) fn migrate_legacy_sibling_order(&mut self) -> Result<(), AppError> {
        let tree = self.tree();
        // Every node (plus root) is a candidate parent.
        let mut parents: Vec<TreeParentId> = vec![TreeParentId::Root];
        for node in tree.get_nodes(false) {
            parents.push(TreeParentId::Node(node.id));
        }
        for parent in parents {
            let Some(children) = tree.children(parent) else {
                continue;
            };
            if children.len() < 2 {
                continue; // 0 or 1 child: order is already trivially correct.
            }
            let mut keyed: Vec<(i64, String, TreeID)> = Vec::with_capacity(children.len());
            for child in &children {
                let meta = tree.get_meta(*child).map_err(|e| {
                    AppError::Validation(format!("loro: migrate sibling order: get_meta: {e}"))
                })?;
                let pos = read_i64(&meta, FIELD_POSITION).unwrap_or(i64::MAX);
                let bid = read_string(&meta, FIELD_BLOCK_ID).unwrap_or_default();
                keyed.push((pos, bid, *child));
            }
            keyed.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
            for (slot, (_, _, node)) in keyed.iter().enumerate() {
                tree.mov_to(*node, parent, slot).map_err(|e| {
                    AppError::Validation(format!("loro: migrate sibling order: mov_to: {e}"))
                })?;
            }
        }
        self.mark_sibling_order_current();
        self.doc.commit();
        Ok(())
    }
}
