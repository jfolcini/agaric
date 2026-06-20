//! Read-back getters and queries for [`LoroEngine`].
//!
//! `read_*` projections (block / properties / parent / position / tags /
//! deleted), `list_children_walk`, and `count_alive_blocks`.

use super::*;

impl LoroEngine {
    /// Read a block back from the doc.  Returns `Ok(None)` when the
    /// block_id is absent.  Returns `Err(AppError::Validation)` when
    /// a meta field is present but has the wrong shape (writer / reader
    /// mismatch — should fail loudly). `parent_id` is derived from the
    /// tree structure; `position` from the node-meta sort key.
    pub fn read_block(&self, block_id: &str) -> Result<Option<BlockSnapshot>, AppError> {
        let Some(node) = self.node_for(block_id) else {
            return Ok(None);
        };
        let block_map = self.tree().get_meta(node).map_err(|e| {
            AppError::Validation(format!("loro: read_block {block_id}: get_meta: {e}"))
        })?;

        let block_type = read_string(&block_map, FIELD_BLOCK_TYPE)
            .map_err(|e| ctx_err(&e, &format!("block {block_id}: block_type")))?;
        let content = read_text(&block_map, FIELD_CONTENT)
            .map_err(|e| ctx_err(&e, &format!("block {block_id}: content")))?;
        let parent_id = self.parent_block_id_of(node)?;
        // Sibling order is the tree's fractional index (#400); `position` is the
        // dense 1-based rank among the parent's children, not the legacy meta.
        let position = self.child_rank_position(node);

        Ok(Some(BlockSnapshot {
            block_id: block_id.to_string(),
            block_type,
            content,
            parent_id,
            position,
        }))
    }
    /// Bulk variant of [`Self::read_block`] for projecting MANY blocks at once
    /// (sync-pull reprojection, #1621). Returns one entry per input id, in the
    /// SAME order, with the SAME `Ok(None)`-for-absent semantics as
    /// [`Self::read_block`].
    ///
    /// Why this exists: [`Self::read_block`] derives `position` via
    /// [`Self::child_rank_position`], whose `children.iter().position(...)` is
    /// an O(K) scan of the sibling list. Calling it once per block during a
    /// bulk reprojection makes the projection O(N·K) — O(N²) for a flat space
    /// (K≈N), exactly the pattern [`Self::child_rank_position`]'s docstring
    /// warns against. Here we build a per-parent `TreeID → 1-based-rank` index
    /// ONCE for each distinct parent touched (each via a single
    /// `tree.children(parent)` pass), then look up every block's rank in O(1).
    /// Total cost is ~O(N + Σ children) ≈ O(N) instead of O(N·K).
    ///
    /// The projected `position` is byte-identical to what
    /// [`Self::child_rank_position`] produces: both derive the parent via
    /// `tree.parent(node)` and rank within the SAME `tree.children(parent)`
    /// order, so the only change is *when* the sibling list is scanned (once
    /// per parent here vs. once per block before).
    pub fn read_blocks_bulk(
        &self,
        block_ids: &[&str],
    ) -> Result<Vec<Option<BlockSnapshot>>, AppError> {
        let tree = self.tree();
        // Memoise `parent → (child TreeID → 1-based rank)`. Built lazily so a
        // parent whose children list is empty/absent is still cached as such,
        // and each `tree.children(parent)` pass runs at most once per parent.
        let mut rank_by_parent: HashMap<TreeParentId, HashMap<TreeID, i64>> = HashMap::new();
        let mut out = Vec::with_capacity(block_ids.len());
        for block_id in block_ids {
            let Some(node) = self.node_for(block_id) else {
                out.push(None);
                continue;
            };
            let block_map = self.tree().get_meta(node).map_err(|e| {
                AppError::Validation(format!("loro: read_blocks_bulk {block_id}: get_meta: {e}"))
            })?;
            let block_type = read_string(&block_map, FIELD_BLOCK_TYPE)
                .map_err(|e| ctx_err(&e, &format!("block {block_id}: block_type")))?;
            let content = read_text(&block_map, FIELD_CONTENT)
                .map_err(|e| ctx_err(&e, &format!("block {block_id}: content")))?;
            let parent_id = self.parent_block_id_of(node)?;

            // Position: identical derivation to `child_rank_position`, but the
            // per-parent rank map is built once and reused across all blocks
            // sharing that parent (and across this whole bulk call).
            let parent = tree.parent(node).unwrap_or(TreeParentId::Root);
            let ranks = rank_by_parent.entry(parent).or_insert_with(|| {
                let mut m = HashMap::new();
                if let Some(children) = tree.children(parent) {
                    for (idx, child) in children.iter().enumerate() {
                        // 1-based rank, saturating exactly as `child_rank_position`.
                        let rank = i64::try_from(idx).unwrap_or(i64::MAX).saturating_add(1);
                        m.insert(*child, rank);
                    }
                }
                m
            });
            // `Some` rank for any node that is a child of `parent`; fall back to
            // `1` for the "node not found among its parent's children" case,
            // matching `child_rank_position`'s defensive default.
            let position = ranks.get(&node).copied().unwrap_or(1);

            out.push(Some(BlockSnapshot {
                block_id: block_id.to_string(),
                block_type,
                content,
                parent_id,
                position,
            }));
        }
        Ok(out)
    }
    /// Typed variant of the per-block property read: returns each
    /// value as a native [`PropertyValue`] so the SQL projection can route
    /// `Num`/`Bool` without consulting `property_definitions`. Used by the
    /// inbound re-projection path and the unified state-projection (Phase 4).
    /// Returns an empty `Vec` when the block has never had any properties.
    pub fn read_all_properties_typed(
        &self,
        block_id: &str,
    ) -> Result<Vec<(String, PropertyValue)>, AppError> {
        let props_root: LoroMap = self.doc.get_map(BLOCK_PROPERTIES_ROOT);
        let Some(voc) = props_root.get(block_id) else {
            return Ok(Vec::new());
        };
        let block_props: LoroMap = voc
            .into_container()
            .map_err(|_| {
                AppError::Validation(format!(
                    "loro: read_all_properties_typed block {block_id} props slot is not a container"
                ))
            })?
            .into_map()
            .map_err(|_| {
                AppError::Validation(format!(
                    "loro: read_all_properties_typed block {block_id} props is not a LoroMap"
                ))
            })?;
        let mut out: Vec<(String, PropertyValue)> = Vec::with_capacity(block_props.len());
        let mut err: Option<AppError> = None;
        block_props.for_each(|key, value_voc| {
            if err.is_some() {
                return;
            }
            match value_voc.into_value() {
                Ok(v) => match PropertyValue::from_loro(v) {
                    Ok(pv) => out.push((key.to_string(), pv)),
                    Err(e) => err = Some(e),
                },
                Err(_) => {
                    err = Some(AppError::Validation(format!(
                        "loro: read_all_properties_typed {block_id}/{key} expected scalar"
                    )));
                }
            }
        });
        if let Some(e) = err {
            return Err(e);
        }
        Ok(out)
    }
    /// Test-only single-key companion to [`read_all_properties_typed`].
    ///
    /// Returns `Ok(None)` for an unset key (no entry in the map),
    /// `Ok(Some(PropertyValue::Null))` for an explicit-null clear, and
    /// `Ok(Some(value))` for any present scalar. Production property
    /// reads go through SQL / `read_all_properties_typed`; this exists
    /// for parity-checking in tests and proptests.
    #[cfg(test)]
    pub fn read_property_typed(
        &self,
        block_id: &str,
        key: &str,
    ) -> Result<Option<PropertyValue>, AppError> {
        let props_root: LoroMap = self.doc.get_map(BLOCK_PROPERTIES_ROOT);
        let Some(voc) = props_root.get(block_id) else {
            return Ok(None);
        };
        let block_props: LoroMap = voc
            .into_container()
            .map_err(|_| {
                AppError::Validation(format!(
                    "loro: read_property_typed block {block_id} props slot is not a container"
                ))
            })?
            .into_map()
            .map_err(|_| {
                AppError::Validation(format!(
                    "loro: read_property_typed block {block_id} props is not a LoroMap"
                ))
            })?;
        let Some(value_voc) = block_props.get(key) else {
            return Ok(None);
        };
        let value = value_voc.into_value().map_err(|_| {
            AppError::Validation(format!(
                "loro: read_property_typed {block_id}/{key} expected scalar"
            ))
        })?;
        Ok(Some(PropertyValue::from_loro(value)?))
    }
    /// Read the current parent `block_id`, derived from the tree
    /// structure. `Ok(None)` for a top-level block, `Err` if the block
    /// is missing from the engine.
    pub fn read_parent(&self, block_id: &str) -> Result<Option<String>, AppError> {
        let node = self.node_for(block_id).ok_or_else(|| {
            AppError::Validation(format!("loro: read parent: block {block_id} not found"))
        })?;
        self.parent_block_id_of(node)
    }
    /// Read the current position: the dense 1-based rank among the parent's
    /// children in fractional-index order (#400), not the legacy meta key.
    pub fn read_position(&self, block_id: &str) -> Result<i64, AppError> {
        let node = self.node_for(block_id).ok_or_else(|| {
            AppError::Validation(format!("loro: read position: block {block_id} not found"))
        })?;
        Ok(self.child_rank_position(node))
    }
    /// Read the current tag-id set for `block_id`.  Returns an empty
    /// vector (not `None`) when the block has never had any tags or
    /// when its container has been emptied — the SQL projection that
    /// this mirrors uses `LEFT JOIN block_tags`, so "no row" and "no
    /// tag" flatten to the same shape at the read boundary.
    ///
    /// The result is **deduplicated** (#622): this is the authoritative
    /// input to `reproject_block_tags_from_engine`, and duplicates can
    /// still exist in storage — legacy LoroList slots persisted by
    /// pre-fix code may carry duplicate elements from old concurrent
    /// adds, and a map slot can hold the same tag_id under both a
    /// stale-name key (pre-rename) and its current-name key. Order:
    /// first-occurrence for legacy lists (insertion order), normalized-
    /// name key order for map slots (loro map state is a BTreeMap).
    ///
    /// Phase-2 day-8.5: companion to `apply_add_tag` / `apply_remove_tag`,
    /// used by the sync-pull projection, engine unit tests and
    /// parity-check paths.
    pub fn read_tags(&self, block_id: &str) -> Result<Vec<String>, AppError> {
        let tags_root: LoroMap = self.doc.get_map(BLOCK_TAGS_ROOT);
        let mut out: Vec<String> = Vec::new();
        let mut err: Option<AppError> = None;
        let mut push_unique = |tag_id: String| {
            if !out.contains(&tag_id) {
                out.push(tag_id);
            }
        };
        match tags_slot(&tags_root, block_id, "read_tags")? {
            None => return Ok(Vec::new()),
            Some(TagsSlot::Map(tag_map)) => {
                tag_map.for_each(|key, voc| {
                    if err.is_some() {
                        return;
                    }
                    match voc.into_value() {
                        Ok(LoroValue::String(s)) => push_unique((*s).clone()),
                        Ok(other) => {
                            err = Some(AppError::Validation(format!(
                                "loro: read_tags block {block_id} key {key}: \
                                 expected String tag_id, got {other:?}"
                            )));
                        }
                        Err(_) => {
                            err = Some(AppError::Validation(format!(
                                "loro: read_tags block {block_id} key {key}: \
                                 tag value is not a scalar"
                            )));
                        }
                    }
                });
            }
            Some(TagsSlot::List(block_tags)) => {
                block_tags.for_each(|voc| {
                    if err.is_some() {
                        return;
                    }
                    match voc.into_value() {
                        Ok(LoroValue::String(s)) => push_unique((*s).clone()),
                        Ok(other) => {
                            err = Some(AppError::Validation(format!(
                                "loro: read_tags block {block_id}: expected String tag, got {other:?}"
                            )));
                        }
                        Err(_) => {
                            err = Some(AppError::Validation(format!(
                                "loro: read_tags block {block_id}: tag value is not a scalar"
                            )));
                        }
                    }
                });
            }
        }
        if let Some(e) = err {
            return Err(e);
        }
        Ok(out)
    }
    /// True iff `deleted_at` has been set on this block (any non-null value).
    pub fn read_deleted(&self, block_id: &str) -> Result<bool, AppError> {
        let block_map = self.get_block_map(block_id, "read deleted")?;
        match block_map.get(FIELD_DELETED_AT) {
            None => Ok(false),
            Some(voc) => {
                let value = voc.into_value().map_err(|_| {
                    AppError::Validation(format!(
                        "loro: read_deleted block {block_id} deleted_at is not a scalar"
                    ))
                })?;
                Ok(!matches!(value, LoroValue::Null))
            }
        }
    }
    /// Read the real `deleted_at` timestamp set on this block, or
    /// `None` when the block is alive (no `deleted_at` slot, or an
    /// explicit `Null`) or absent from the engine.
    ///
    /// Lossless counterpart to [`Self::read_deleted`] (which returns
    /// only the boolean): inbound-sync re-projection
    /// (`reproject_block_deleted_at_from_engine`) reads the actual
    /// timestamp so the SQL descendant cascade + restore cohort key off
    /// The same value the originating peer wrote (Phase 2).
    ///
    /// Returns `Ok(None)` for an absent block (rather than erroring like
    /// the `get_block_map`-based readers) so a purged/missing id maps to
    /// the same "not deleted" answer — the re-projection caller treats
    /// absence and aliveness identically.
    pub fn read_deleted_at(&self, block_id: &str) -> Result<Option<String>, AppError> {
        let Some(node) = self.node_for(block_id) else {
            return Ok(None);
        };
        let meta = self.tree().get_meta(node).map_err(|e| {
            AppError::Validation(format!("loro: read_deleted_at {block_id}: get_meta: {e}"))
        })?;
        read_deleted_at_meta(&meta, block_id)
    }
    /// Collect the live (non-soft-deleted) child `block_id`s of `parent_id` in
    /// sibling order — the tree's **fractional-index order** (#400), which is
    /// the authoritative sibling order projected into the SQL `position` column.
    ///
    /// This call exists for parity tests and debug paths only; production
    /// reads flow through the indexed SQL `blocks` table.
    pub fn list_children_walk(&self, parent_id: &str) -> Result<Vec<String>, AppError> {
        let Some(parent_node) = self.node_for(parent_id) else {
            return Ok(Vec::new());
        };
        let tree = self.tree();
        let Some(children) = tree.children(TreeParentId::Node(parent_node)) else {
            return Ok(Vec::new());
        };
        let mut out = Vec::with_capacity(children.len());
        for child in children {
            let meta = tree.get_meta(child).map_err(|e| {
                AppError::Validation(format!("loro: list_children_walk: get_meta: {e}"))
            })?;
            if read_deleted_at_meta(&meta, "child")?.is_some() {
                continue; // soft-deleted — excluded, like the SQL filter
            }
            out.push(read_string(&meta, FIELD_BLOCK_ID)?);
        }
        Ok(out)
    }
    /// Count blocks that have NOT been soft-deleted (and are not
    /// hard-purged).  Used by debug/audit paths and parity checks; not a
    /// hot-path read.
    pub fn count_alive_blocks(&self) -> Result<usize, AppError> {
        let tree = self.tree();
        let mut alive = 0usize;
        // `get_nodes(false)` is the live (non-hard-purged) forest, so no
        // tombstone walk; a soft-deleted node is still live in the tree, so
        // filter it out on the `deleted_at` meta.
        for node in tree.get_nodes(false) {
            let meta = tree
                .get_meta(node.id)
                .map_err(|e| AppError::Validation(format!("loro: count_alive: get_meta: {e}")))?;
            if read_deleted_at_meta(&meta, "count_alive")?.is_none() {
                alive += 1;
            }
        }
        Ok(alive)
    }

    /// Collect the `block_id`s the engine currently holds as **live**
    /// (non-hard-purged AND not soft-deleted) — i.e. exactly the blocks an
    /// `export_snapshot()` / `export_update_since()` would carry as present.
    ///
    /// #1257: the sync-export freshness gate cross-checks this set against
    /// SQL's `deleted_at` column. A block the engine still treats as live but
    /// which SQL has soft-deleted is the eager-apply divergence hazard — the
    /// engine tombstones rather than removes on delete, so a delete that
    /// reached SQL but not the engine leaves the node exportable here.
    ///
    /// Mirrors [`Self::count_alive_blocks`]' walk (`get_nodes(false)` live
    /// forest, then filter on `deleted_at` meta) but returns the ids rather
    /// than a count.
    pub fn live_block_ids(&self) -> Result<Vec<String>, AppError> {
        let tree = self.tree();
        let mut out = Vec::new();
        for (node_id, block_id) in self.live_nodes_with_block_id() {
            let meta = tree.get_meta(node_id).map_err(|e| {
                AppError::Validation(format!("loro: live_block_ids: get_meta: {e}"))
            })?;
            if read_deleted_at_meta(&meta, "live_block_ids")?.is_none() {
                out.push(block_id);
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod read_blocks_bulk_tests {
    use super::LoroEngine;

    /// #1621: the bulk reprojection (`read_blocks_bulk`) must yield the EXACT
    /// same `BlockSnapshot` (including the dense `position` rank) as the
    /// per-block `read_block` path, on a FLAT space — one parent, many ordered
    /// siblings (K≈N), the O(N²) pattern this change replaces with an O(1)
    /// per-block rank lookup.
    #[test]
    fn flat_space_bulk_positions_match_per_block() {
        let mut e = LoroEngine::new();
        e.apply_create_block_at("P", "parent", "p", None, 0)
            .unwrap();
        // 200 ordered children under the single parent P. Insert at the END
        // each time (index = current count) so the fractional-index order is
        // C0, C1, ... C199 — a flat sibling list.
        let n = 200usize;
        let ids: Vec<String> = (0..n).map(|i| format!("C{i}")).collect();
        for (i, id) in ids.iter().enumerate() {
            e.apply_create_block_at(id, "child", "x", Some("P"), i)
                .unwrap();
        }

        // Project every block (parent + children) via BOTH paths and compare.
        let mut all_ids: Vec<&str> = vec!["P"];
        all_ids.extend(ids.iter().map(String::as_str));

        let bulk = e.read_blocks_bulk(&all_ids).unwrap();
        assert_eq!(bulk.len(), all_ids.len());
        for (id, bulk_snap) in all_ids.iter().zip(&bulk) {
            let per_block = e.read_block(id).unwrap();
            assert_eq!(
                bulk_snap, &per_block,
                "bulk snapshot for {id} differs from per-block read_block",
            );
        }

        // And explicitly: child Ci has dense 1-based rank i+2 (the parent P
        // occupies rank 1 under the root; under P the children are 1..=n).
        for (i, id) in ids.iter().enumerate() {
            let snap = bulk[i + 1].as_ref().expect("child snapshot present");
            assert_eq!(
                snap.position,
                i64::try_from(i).unwrap() + 1,
                "child {id} rank"
            );
            assert_eq!(snap.parent_id.as_deref(), Some("P"));
        }
    }

    /// #1621: nested / multi-parent case — several parents each with their own
    /// children, plus root-level blocks. Every block's bulk snapshot must match
    /// the per-block path, proving the per-parent index keys ranks correctly
    /// (no cross-parent bleed) and that root blocks rank among the root forest.
    #[test]
    fn nested_multi_parent_bulk_positions_match_per_block() {
        let mut e = LoroEngine::new();
        // Two root-level parents A and B (ranks 1 and 2 under the root).
        e.apply_create_block_at("A", "parent", "a", None, 0)
            .unwrap();
        e.apply_create_block_at("B", "parent", "b", None, 1)
            .unwrap();
        // A has three children; B has two; A1 has a grandchild.
        e.apply_create_block_at("A1", "child", "a1", Some("A"), 0)
            .unwrap();
        e.apply_create_block_at("A2", "child", "a2", Some("A"), 1)
            .unwrap();
        e.apply_create_block_at("A3", "child", "a3", Some("A"), 2)
            .unwrap();
        e.apply_create_block_at("B1", "child", "b1", Some("B"), 0)
            .unwrap();
        e.apply_create_block_at("B2", "child", "b2", Some("B"), 1)
            .unwrap();
        e.apply_create_block_at("G", "grandchild", "g", Some("A1"), 0)
            .unwrap();
        // A third root-level block C (rank 3 under the root).
        e.apply_create_block_at("C", "leaf", "c", None, 2).unwrap();

        // Intentionally pass the ids in a SCRAMBLED order (not grouped by
        // parent) so the memoised per-parent index is exercised across
        // interleaved parents.
        let all_ids = ["G", "A2", "B", "C", "A", "B2", "A1", "B1", "A3"];
        let bulk = e.read_blocks_bulk(&all_ids).unwrap();
        assert_eq!(bulk.len(), all_ids.len());
        for (id, bulk_snap) in all_ids.iter().zip(&bulk) {
            let per_block = e.read_block(id).unwrap();
            assert_eq!(
                bulk_snap, &per_block,
                "bulk snapshot for {id} differs from per-block read_block",
            );
        }

        // Spot-check a few derived ranks to pin the expectation explicitly.
        let by_id = |want: &str| {
            all_ids
                .iter()
                .position(|i| *i == want)
                .map(|idx| bulk[idx].as_ref().unwrap())
                .unwrap()
        };
        assert_eq!(by_id("A").position, 1);
        assert_eq!(by_id("B").position, 2);
        assert_eq!(by_id("C").position, 3);
        assert_eq!(by_id("A1").position, 1);
        assert_eq!(by_id("A2").position, 2);
        assert_eq!(by_id("A3").position, 3);
        assert_eq!(by_id("B1").position, 1);
        assert_eq!(by_id("B2").position, 2);
        assert_eq!(by_id("G").position, 1);
    }

    /// Absent ids map to `None` in the same slot, preserving input order and
    /// `read_block`'s `Ok(None)`-for-absent contract.
    #[test]
    fn bulk_absent_ids_yield_none_in_order() {
        let mut e = LoroEngine::new();
        e.apply_create_block_at("X", "leaf", "x", None, 0).unwrap();
        let bulk = e
            .read_blocks_bulk(&["missing-1", "X", "missing-2"])
            .unwrap();
        assert!(bulk[0].is_none());
        assert_eq!(bulk[1], e.read_block("X").unwrap());
        assert!(bulk[2].is_none());
    }
}
