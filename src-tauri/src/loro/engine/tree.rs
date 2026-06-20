//! Tree slot/position mechanics for [`LoroEngine`] (Phase 3).
//!
//! The block hierarchy is a `LoroTree` at `BLOCKS_TREE_ROOT`; these methods
//! centralise node lookup + meta access (the `block_id -> TreeID` index and
//! the pending-parent reconciler) so the `apply_*` / `read_*` paths share one
//! source of truth.

use super::*;

impl LoroEngine {
    /// Read the doc's recorded sibling-order scheme version (0 if the marker
    /// is absent — a pre-#400 snapshot). See [`FIELD_SIBLING_ORDER_V`].
    pub(super) fn sibling_order_version(&self) -> i64 {
        let meta: LoroMap = self.doc.get_map(ENGINE_META_ROOT);
        match meta.get(FIELD_SIBLING_ORDER_V) {
            Some(v) => match v.into_value() {
                Ok(LoroValue::I64(n)) => n,
                _ => 0,
            },
            None => 0,
        }
    }
    /// Stamp the doc as written under the current sibling-order scheme so a
    /// later [`Self::import`] of its snapshot skips the legacy migration.
    /// Idempotent: only writes when the recorded version is behind, so it adds
    /// at most one op per doc rather than one per block op.
    pub(super) fn mark_sibling_order_current(&self) {
        if self.sibling_order_version() >= SIBLING_ORDER_VERSION {
            return;
        }
        let meta: LoroMap = self.doc.get_map(ENGINE_META_ROOT);
        if let Err(e) = meta.insert(
            FIELD_SIBLING_ORDER_V,
            LoroValue::from(SIBLING_ORDER_VERSION),
        ) {
            tracing::warn!(error = %e, "failed to stamp sibling_order_v marker");
        }
    }
    /// Translate a **live-sibling** slot (the index among non-soft-deleted
    /// children that the frontend computes from the visible tree) into a
    /// **tree** slot for `create_at`/`mov_to`, which index over *all* children
    /// including soft-deleted ones (#400). Without this, a soft-deleted sibling
    /// ordered before the drop point would shift the placement by one. `exclude`
    /// skips the moved block itself (already a child of `parent` on a move).
    ///
    /// Returns the tree index (among the other children) at which inserting the
    /// node makes it the `live_slot`-th live child; appends past the end when
    /// `live_slot` exceeds the live-child count.
    pub(super) fn live_tree_slot(
        &self,
        parent: TreeParentId,
        live_slot: usize,
        exclude: Option<TreeID>,
    ) -> usize {
        let tree = self.tree();
        let Some(children) = tree.children(parent) else {
            return 0;
        };
        let mut live_seen = 0usize;
        let mut tree_idx = 0usize;
        for child in children {
            if Some(child) == exclude {
                continue;
            }
            if live_seen == live_slot {
                return tree_idx;
            }
            let is_live = tree
                .get_meta(child)
                .ok()
                .and_then(|m| read_deleted_at_meta(&m, "child").ok())
                .map(|d| d.is_none())
                .unwrap_or(true);
            if is_live {
                live_seen += 1;
            }
            tree_idx += 1;
        }
        tree_idx
    }
    /// Resolve `parent_id` to a [`TreeParentId`] **without** side effects (no
    /// `pending_parent` mutation) — for read-only slot translation. Unknown
    /// parent ⇒ `Root` (the actual placement under a not-yet-present parent is
    /// handled by the mutating apply path).
    pub(super) fn tree_parent_readonly(&self, parent_id: Option<&str>) -> TreeParentId {
        match parent_id.and_then(|pid| self.node_for(pid)) {
            Some(node) => TreeParentId::Node(node),
            None => TreeParentId::Root,
        }
    }
    /// The slot a block with legacy `position` should occupy among `parent`'s
    /// current children, reproducing the old `ORDER BY position ASC, id ASC`
    /// sort. Used only by the legacy (sparse-position) apply path so historical
    /// op-log replay rebuilds the exact pre-#400 order. `exclude` skips the
    /// block itself on a move (it is already a child of `parent`).
    pub(super) fn legacy_slot(
        &self,
        parent: TreeParentId,
        position: i64,
        block_id: &str,
        exclude: Option<TreeID>,
    ) -> usize {
        let tree = self.tree();
        let Some(children) = tree.children(parent) else {
            return 0;
        };
        let mut slot = 0usize;
        for child in children {
            if Some(child) == exclude {
                continue;
            }
            let Ok(meta) = tree.get_meta(child) else {
                continue;
            };
            // A sibling with no `position` meta is a new-scheme node; it has no
            // legacy ordering and sorts last. (Does not occur during pure
            // legacy replay — every node then carries a position — but keeps
            // the comparison total if schemes are ever mixed.)
            let sib_pos = read_i64(&meta, FIELD_POSITION).unwrap_or(i64::MAX);
            let sib_id = read_string(&meta, FIELD_BLOCK_ID).unwrap_or_default();
            if (sib_pos, sib_id.as_str()) < (position, block_id) {
                slot += 1;
            }
        }
        slot
    }
    /// 1-based rank of `node` among its parent's children in fractional-index
    /// order — the value projected into the SQL `position` column. Soft-deleted
    /// siblings keep their slot (they remain in the tree), matching the old
    /// behaviour where a deleted block kept its `position`. Returns `1` if the
    /// node is somehow not found among its parent's children (defensive).
    ///
    /// NOTE: the inner `children.iter().position(...)` is O(K) per call. When
    /// projecting all K siblings in a batch this becomes O(K²). Bulk callers
    /// should use [`Self::children_ordered_block_ids`] directly and derive
    /// positions from the returned index rather than calling this per-node.
    pub(super) fn child_rank_position(&self, node: TreeID) -> i64 {
        let tree = self.tree();
        let parent = tree.parent(node).unwrap_or(TreeParentId::Root);
        let Some(children) = tree.children(parent) else {
            return 1;
        };
        match children.iter().position(|c| *c == node) {
            Some(idx) => i64::try_from(idx).unwrap_or(i64::MAX).saturating_add(1),
            None => 1,
        }
    }
    /// Block ids of `parent`'s children in fractional-index order, **including
    /// soft-deleted** ones (they keep their SQL row + position). Drives the
    /// projection's dense-rank reprojection (#400). `None` parent ⇒ tree root.
    pub fn children_ordered_block_ids(
        &self,
        parent_id: Option<&str>,
    ) -> Result<Vec<String>, AppError> {
        let parent = match parent_id {
            None => TreeParentId::Root,
            Some(pid) => match self.node_for(pid) {
                Some(node) => TreeParentId::Node(node),
                None => return Ok(Vec::new()),
            },
        };
        let tree = self.tree();
        let Some(children) = tree.children(parent) else {
            return Ok(Vec::new());
        };
        let mut out = Vec::with_capacity(children.len());
        for child in children {
            let meta = tree.get_meta(child).map_err(|e| {
                AppError::Validation(format!("loro: children_ordered_block_ids: get_meta: {e}"))
            })?;
            out.push(read_string(&meta, FIELD_BLOCK_ID)?);
        }
        Ok(out)
    }
    /// Whether any live tree node carries the legacy `position` meta — the
    /// signature of a pre-#400 doc. New-scheme nodes (created via `create_at`)
    /// never write `position`, so an all-new (or empty) doc returns `false`.
    pub(super) fn any_node_has_legacy_position(&self) -> bool {
        let tree = self.tree();
        tree.get_nodes(false).into_iter().any(|n| {
            tree.get_meta(n.id)
                .ok()
                .and_then(|m| m.get(FIELD_POSITION))
                .is_some()
        })
    }
    /// Test-only: forge a genuine pre-#400 doc in place. Stamps each named
    /// node's legacy [`FIELD_POSITION`] meta to the given value (so
    /// [`Self::any_node_has_legacy_position`] is true) and removes the scheme
    /// marker (so [`Self::sibling_order_version`] reads 0). Lets a test create a
    /// doc whose tree (fractional) order disagrees with position order — the
    /// only shape that actually drives the migration reorder loop.
    #[cfg(test)]
    pub(super) fn force_legacy_scheme_for_test(&self, positions: &[(&str, i64)]) {
        let tree = self.tree();
        for (id, pos) in positions {
            let node = self.node_for(id).expect("force_legacy: node exists");
            let meta = tree.get_meta(node).expect("force_legacy: get_meta");
            meta.insert(FIELD_POSITION, LoroValue::from(*pos))
                .expect("force_legacy: insert position");
        }
        let engine_meta: LoroMap = self.doc.get_map(ENGINE_META_ROOT);
        let _ = engine_meta.delete(FIELD_SIBLING_ORDER_V);
        self.doc.commit();
    }
    /// The block-hierarchy [`LoroTree`] handle (attached to the doc).
    pub(super) fn tree(&self) -> LoroTree {
        self.doc.get_tree(BLOCKS_TREE_ROOT)
    }
    /// Resolve a `block_id` to its `TreeID` via the in-memory index.
    pub(super) fn node_for(&self, block_id: &str) -> Option<TreeID> {
        self.index.get(block_id).copied()
    }
    /// Resolve the requested parent into a [`TreeParentId`]:
    /// `None` → tree root; `Some(pid)` present in the index → that node;
    /// `Some(pid)` *absent* → tree root **and** record `block_id`'s
    /// intended parent in [`Self::pending_parent`] so it is re-attached
    /// when `pid` later appears.
    pub(super) fn resolve_parent(
        &mut self,
        block_id: &str,
        parent_id: Option<&str>,
    ) -> TreeParentId {
        match parent_id {
            None => TreeParentId::Root,
            Some(pid) => match self.node_for(pid) {
                Some(parent_node) => {
                    self.pending_parent.remove(block_id);
                    TreeParentId::Node(parent_node)
                }
                None => {
                    self.pending_parent
                        .insert(block_id.to_string(), pid.to_string());
                    TreeParentId::Root
                }
            },
        }
    }
    /// After a node for `parent_block_id` becomes available, re-parent any
    /// orphans that were waiting for it (best-effort; cycle-forming moves
    /// are logged and skipped).
    pub(super) fn attach_pending_children(&mut self, parent_block_id: &str) {
        let waiting: Vec<String> = self
            .pending_parent
            .iter()
            .filter(|(_, intended)| intended.as_str() == parent_block_id)
            .map(|(child, _)| child.clone())
            .collect();
        if waiting.is_empty() {
            return;
        }
        let Some(parent_node) = self.node_for(parent_block_id) else {
            return;
        };
        let tree = self.tree();
        for child in waiting {
            if let Some(child_node) = self.node_for(&child) {
                match tree.mov(child_node, TreeParentId::Node(parent_node)) {
                    Ok(()) => {
                        self.pending_parent.remove(&child);
                    }
                    Err(e) => {
                        tracing::warn!(
                            child, parent_block_id, error = %e,
                            "attach_pending_children: reparent failed; leaving orphan under root",
                        );
                    }
                }
            }
        }
    }
    /// Write a node's identity scalars (`block_id` back-reference + block_type).
    /// Sibling order is the tree's fractional index (#400), so `position` is no
    /// longer written here — the legacy apply path stamps it separately via
    /// [`Self::write_legacy_position`] solely as a replay-conversion aid.
    pub(super) fn write_node_identity(
        &self,
        meta: &LoroMap,
        block_id: &str,
        block_type: &str,
    ) -> Result<(), AppError> {
        meta.insert(FIELD_BLOCK_ID, LoroValue::from(block_id))
            .map_err(|e| {
                AppError::Validation(format!("loro: node {block_id}: set block_id meta: {e}"))
            })?;
        meta.insert(FIELD_BLOCK_TYPE, LoroValue::from(block_type))
            .map_err(|e| {
                AppError::Validation(format!("loro: node {block_id}: set block_type: {e}"))
            })?;
        Ok(())
    }
    /// Stamp the legacy `position` sort key on a node's meta. Written only by
    /// the legacy (sparse-position) apply path so a *subsequent* legacy op in
    /// the same replay can convert its position to a slot against this sibling
    /// ([`Self::legacy_slot`]). New-scheme ops never call this.
    pub(super) fn write_legacy_position(
        &self,
        meta: &LoroMap,
        block_id: &str,
        position: i64,
    ) -> Result<(), AppError> {
        meta.insert(FIELD_POSITION, LoroValue::from(position))
            .map_err(|e| AppError::Validation(format!("loro: node {block_id}: set position: {e}")))
    }
    /// Collect the `block_id`s of a node and all its (live) descendants,
    /// via pre-order DFS over `tree.children`. Used by purge to prune the
    /// whole subtree from the index before `tree.delete` orphans it.
    pub(super) fn collect_subtree_block_ids(&self, root: TreeID) -> Vec<String> {
        let tree = self.tree();
        let mut out = Vec::new();
        let mut stack = vec![root];
        while let Some(node) = stack.pop() {
            if let Ok(meta) = tree.get_meta(node)
                && let Ok(bid) = read_string(&meta, FIELD_BLOCK_ID)
            {
                out.push(bid);
            }
            if let Some(children) = tree.children(TreeParentId::Node(node)) {
                stack.extend(children);
            }
        }
        out
    }
    /// The live (non-hard-purged) tree nodes paired with their `block_id`
    /// (read from node meta). The single forest-walk primitive shared by
    /// [`Self::rebuild_index`] and [`Self::count_alive_blocks`].
    ///
    /// Uses `get_nodes(false)` — the live forest under the tree root — so
    /// historically hard-purged tombstones (which Loro keeps under its
    /// Deleted root and which `nodes()` would return) are **never iterated**.
    /// Soft-deleted blocks keep a normal tree parent (only their `deleted_at`
    /// meta is set), so they remain reachable from the root and ARE included
    /// here; transitively-deleted descendants of a hard-purged node sit under
    /// the Deleted root and are correctly excluded.
    pub(super) fn live_nodes_with_block_id(&self) -> Vec<(TreeID, String)> {
        let tree = self.tree();
        tree.get_nodes(false)
            .into_iter()
            .filter_map(|n| {
                let meta = tree.get_meta(n.id).ok()?;
                let bid = read_string(&meta, FIELD_BLOCK_ID).ok()?;
                Some((n.id, bid))
            })
            .collect()
    }
    /// Rebuild [`Self::index`] from the tree's live node meta and drop any
    /// now-resolved/dead [`Self::pending_parent`] intents. Called after any
    /// `import` (remote ops may have created nodes the incremental index
    /// never saw). O(N_live); cold path.
    pub(super) fn rebuild_index(&mut self) {
        let mut index = HashMap::new();
        for (node, bid) in self.live_nodes_with_block_id() {
            index.insert(bid, node);
        }
        self.index = index;
        self.reconcile_pending_parent();
    }
    /// Drop stale [`Self::pending_parent`] intents after the index was
    /// rebuilt from an import. An entry is stale once the child no longer
    /// exists in the engine, or the child is already parented under a real
    /// (non-root) node — in either case re-firing `attach_pending_children`
    /// later would act on out-of-date intent. Entries whose intended parent
    /// is *still* absent are kept (the safety net is still pending).
    pub(super) fn reconcile_pending_parent(&mut self) {
        if self.pending_parent.is_empty() {
            return;
        }
        let tree = self.tree();
        let index = &self.index;
        self.pending_parent.retain(|child, _intended| {
            let Some(&child_node) = index.get(child) else {
                return false; // child gone (purged / never landed) → drop
            };
            // Already attached to a real parent (a converged remote reparent
            // satisfied the intent) → drop.
            !matches!(tree.parent(child_node), Some(TreeParentId::Node(_)))
        });
    }
    /// Derive a node's parent `block_id` from the tree structure.
    /// `Ok(None)` for a tree root (top-level block), a deleted/uncreated
    /// parent, or a missing node. The parent's `block_id` is read back
    /// from the parent node's meta.
    pub(super) fn parent_block_id_of(&self, node: TreeID) -> Result<Option<String>, AppError> {
        match self.tree().parent(node) {
            Some(TreeParentId::Node(parent_node)) => {
                let parent_meta = self.tree().get_meta(parent_node).map_err(|e| {
                    AppError::Validation(format!("loro: parent_block_id_of: get_meta: {e}"))
                })?;
                Ok(Some(read_string(&parent_meta, FIELD_BLOCK_ID)?))
            }
            _ => Ok(None),
        }
    }
    /// Internal helper — fetch a block's tree-node **meta map** by id with
    /// a uniform error-context prefix so each caller doesn't repeat the
    /// boilerplate. Errors if the `block_id` is unknown to the index.
    pub(super) fn get_block_map(&self, block_id: &str, ctx: &str) -> Result<LoroMap, AppError> {
        let node = self.node_for(block_id).ok_or_else(|| {
            AppError::Validation(format!("loro: {ctx}: block {block_id} not found"))
        })?;
        self.tree().get_meta(node).map_err(|e| {
            AppError::Validation(format!("loro: {ctx}: block {block_id} get_meta: {e}"))
        })
    }
}
