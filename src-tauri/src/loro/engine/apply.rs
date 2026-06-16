//! Op-application handlers for [`LoroEngine`].
//!
//! The `apply_*` methods that mirror the production block ops (create / edit /
//! move / delete / restore / purge / set-or-delete property / add-or-remove
//! tag) plus their shared `create_block_impl` / `move_block_impl` cores and
//! the tag-map keying helpers.

use super::*;

impl LoroEngine {
    /// Insert a block into the block-hierarchy [`LoroTree`].
    ///
    /// Idempotent under op-log replay: if the `block_id` already has a node
    /// (re-applied `CreateBlock`), the scalars/content/parent are updated in
    /// place rather than erroring — the boot heal re-runs ops that the
    /// snapshot already reflects.
    pub fn apply_create_block(
        &mut self,
        block_id: &str,
        block_type: &str,
        content: &str,
        parent_id: Option<&str>,
        position: i64,
    ) -> Result<(), AppError> {
        // Legacy (sparse-position) path: derive the slot the position maps to
        // among current siblings and stamp `position` so later legacy ops can
        // convert against it. Used by historical op-log replay + engine tests.
        let parent = self.resolve_parent(block_id, parent_id);
        let slot = self.legacy_slot(parent, position, block_id, self.node_for(block_id));
        self.create_block_impl(
            block_id,
            block_type,
            content,
            parent_id,
            slot,
            Some(position),
        )
    }
    /// New-scheme create (#400): insert `block_id` at the 0-based sibling
    /// `index` among `parent_id`'s children via Loro's fractional index. No
    /// `position` meta is written — sibling order is the fractional index and
    /// the SQL `position` column is the projected dense rank.
    pub fn apply_create_block_at(
        &mut self,
        block_id: &str,
        block_type: &str,
        content: &str,
        parent_id: Option<&str>,
        index: usize,
    ) -> Result<(), AppError> {
        // `index` is a live-sibling slot from the frontend; translate to a tree
        // slot so soft-deleted siblings don't shift the placement (#400).
        let parent = self.tree_parent_readonly(parent_id);
        let tree_slot = self.live_tree_slot(parent, index, self.node_for(block_id));
        self.create_block_impl(block_id, block_type, content, parent_id, tree_slot, None)
    }
    /// Shared create implementation. `slot` is the 0-based target index among
    /// the resolved parent's children (clamped to the valid range). When
    /// `legacy_position` is `Some`, the legacy `position` meta is stamped for
    /// replay conversion; otherwise only identity scalars are written.
    ///
    /// Idempotent under op-log replay: if `block_id` already has a node (a
    /// re-applied `CreateBlock` the snapshot already reflects), the
    /// scalars/content/parent/slot are updated in place rather than erroring.
    pub(super) fn create_block_impl(
        &mut self,
        block_id: &str,
        block_type: &str,
        content: &str,
        parent_id: Option<&str>,
        slot: usize,
        legacy_position: Option<i64>,
    ) -> Result<(), AppError> {
        // Re-apply path: node exists — update meta + content, reparent to slot.
        if let Some(node) = self.node_for(block_id) {
            let parent = self.resolve_parent(block_id, parent_id);
            let tree = self.tree();
            let meta = tree.get_meta(node).map_err(|e| {
                AppError::Validation(format!("loro: re-create block {block_id}: get_meta: {e}"))
            })?;
            self.write_node_identity(&meta, block_id, block_type)?;
            if let Some(pos) = legacy_position {
                self.write_legacy_position(&meta, block_id, pos)?;
            }
            let content_text =
                block_map_get_text(&meta, FIELD_CONTENT, block_id, "re-create content")?;
            // Only rewrite content when it actually changed — a replay-heal
            // re-applies a `CreateBlock` the snapshot already reflects, and an
            // unconditional full delete+reinsert would churn the LoroText op
            // history (larger snapshots, needless concurrent-merge surface).
            if content_text.to_string() != content {
                content_text
                    .splice(0, content_text.len_unicode(), content)
                    .map_err(|e| {
                        AppError::Validation(format!(
                            "loro: re-create block {block_id}: rewrite content: {e}"
                        ))
                    })?;
            }
            // Re-place at the target slot. The node is already a child of
            // `parent`, so the valid `mov_to` range is `0..children_count-1`.
            let slot = clamp_slot(
                slot,
                tree.children_num(parent).unwrap_or(0).saturating_sub(1),
            );
            if let Err(e) = tree.mov_to(node, parent, slot) {
                tracing::warn!(block_id, error = %e, "re-create: reparent skipped");
            }
            self.mark_sibling_order_current();
            self.doc.commit();
            return Ok(());
        }

        let parent = self.resolve_parent(block_id, parent_id);
        let tree = self.tree();
        // `create_at` requires `index <= children_count`; clamp defensively.
        let slot = clamp_slot(slot, tree.children_num(parent).unwrap_or(0));
        let node = tree.create_at(parent, slot).map_err(|e| {
            AppError::Validation(format!(
                "loro: create block {block_id}: tree.create_at: {e}"
            ))
        })?;
        let meta = tree.get_meta(node).map_err(|e| {
            AppError::Validation(format!("loro: create block {block_id}: get_meta: {e}"))
        })?;
        self.write_node_identity(&meta, block_id, block_type)?;
        if let Some(pos) = legacy_position {
            self.write_legacy_position(&meta, block_id, pos)?;
        }

        // `content` is a LoroText container, not a scalar — that's
        // the headline win of the migration (character-level merge).
        // `LoroText::insert` takes Unicode-scalar offsets per
        // SPIKE-REPORT.md §4.3 / notebook Q10.
        let content_text: LoroText = meta
            .insert_container(FIELD_CONTENT, LoroText::new())
            .map_err(|e| {
                AppError::Validation(format!(
                    "loro: create block {block_id}: insert content container: {e}"
                ))
            })?;
        content_text.insert(0, content).map_err(|e| {
            AppError::Validation(format!(
                "loro: create block {block_id}: write initial content: {e}"
            ))
        })?;

        self.index.insert(block_id.to_string(), node);
        self.attach_pending_children(block_id);
        self.mark_sibling_order_current();

        // commit() flushes the implicit transaction so the change is
        // visible to subsequent reads + included in any export.
        self.doc.commit();
        Ok(())
    }
    /// Replace a block's `content` LoroText with `new_content` by
    /// computing the longest common Unicode-scalar prefix + suffix vs
    /// the engine's current content and splicing only the differing
    /// middle.
    ///
    /// Production `EditBlock` ops carry a `to_text` snapshot of the
    /// whole new content. Loro wants character-level splices so two
    /// peers' concurrent edits land at non-overlapping character
    /// ranges when the `new_content` strings differ at non-overlapping
    /// regions — that's the CRDT convergence win.
    ///
    /// Returns `Err(AppError::Validation)` if the block is missing.
    pub fn apply_edit_via_diff_splice(
        &mut self,
        block_id: &str,
        new_content: &str,
    ) -> Result<(), AppError> {
        let current = self
            .read_block(block_id)?
            .ok_or_else(|| {
                AppError::Validation(format!(
                    "loro: apply_edit_via_diff_splice: block {block_id} not found"
                ))
            })?
            .content;

        // Common prefix + suffix in Unicode scalars.  Iterate over
        // `chars()` for both strings in lockstep to get USV indices that
        // match `LoroText::splice`'s expected coordinate system.
        let cur_chars: Vec<char> = current.chars().collect();
        let new_chars: Vec<char> = new_content.chars().collect();

        let mut prefix = 0usize;
        while prefix < cur_chars.len()
            && prefix < new_chars.len()
            && cur_chars[prefix] == new_chars[prefix]
        {
            prefix += 1;
        }

        let mut suffix = 0usize;
        while suffix < cur_chars.len() - prefix
            && suffix < new_chars.len() - prefix
            && cur_chars[cur_chars.len() - 1 - suffix] == new_chars[new_chars.len() - 1 - suffix]
        {
            suffix += 1;
        }

        let range_start = prefix;
        let range_len = cur_chars.len() - prefix - suffix;
        let replacement: String = new_chars[prefix..new_chars.len() - suffix].iter().collect();

        if range_len == 0 && replacement.is_empty() {
            return Ok(()); // identical strings; no-op
        }

        self.apply_edit_content(block_id, range_start, range_len, &replacement)
    }
    /// Splice an edit into a block's `content` LoroText.
    ///
    /// Mirrors what an editor's edit callback would natively produce:
    /// "at unicode-offset `range_start`, delete `range_len` unicode
    /// scalars, insert `replacement`".
    ///
    /// Offset semantics: Unicode scalar (USV) indices, matching
    /// `LoroText::splice` (per SPIKE-REPORT.md §4.3 / notebook Q10).
    pub fn apply_edit_content(
        &mut self,
        block_id: &str,
        range_start: usize,
        range_len: usize,
        replacement: &str,
    ) -> Result<(), AppError> {
        let block_map = self.get_block_map(block_id, "edit content")?;
        let content_text = block_map_get_text(&block_map, FIELD_CONTENT, block_id, "edit content")?;

        // Up-front bound check.  `LoroText::splice` itself returns
        // `LoroError::OutOfBound` if start+len exceeds `len_unicode`,
        // but checking here keeps the error message in our domain.
        let len = content_text.len_unicode();
        if range_start
            .checked_add(range_len)
            .map(|end| end > len)
            .unwrap_or(true)
        {
            return Err(AppError::Validation(format!(
                "loro: edit content block {block_id} range {range_start}+{range_len} \
                 exceeds content length {len} (unicode scalars)"
            )));
        }

        content_text
            .splice(range_start, range_len, replacement)
            .map_err(|e| {
                AppError::Validation(format!(
                    "loro: edit content block {block_id} splice failed: {e}"
                ))
            })?;
        self.doc.commit();
        Ok(())
    }
    /// Soft-delete a block — mirrors the production `DeleteBlock` op.
    /// Stores the real `deleted_at` timestamp (epoch-ms as a decimal
    /// string — what production writes via the originating op's
    /// `created_at.to_string()`; #668) on the seed's block map, so the
    /// value is **lossless across sync**: a peer that imports this doc
    /// reads the same timestamp back via [`Self::read_deleted_at`] and
    /// re-derives the SQL descendant cascade + restore cohort from it
    /// (PEND-80 Phase 2 — was a fixed marker that collapsed every
    /// delete onto one timestamp, breaking cross-peer cohort identity).
    /// Concurrent delete/restore converge on the `deleted_at` slot via
    /// Loro's per-key LWW.
    ///
    /// **Scope: seed only.** The descendant cascade stays an SQL/app
    /// derivation (per the PEND-80 boundary); this writes only the
    /// seed's timestamp. The local materializer mirrors the same
    /// timestamp onto the descendant cohort for engine parity via the
    /// post-commit `dispatch_delete_descendants` fanout, but **inbound
    /// sync does not depend on that** — `reproject_block_deleted_at_from_engine`
    /// re-derives the cascade in SQL from the seed timestamp alone.
    pub fn apply_delete_block(&mut self, block_id: &str, deleted_at: &str) -> Result<(), AppError> {
        let block_map = self.get_block_map(block_id, "delete block")?;
        block_map
            .insert(FIELD_DELETED_AT, LoroValue::from(deleted_at))
            .map_err(|e| {
                AppError::Validation(format!(
                    "loro: delete block {block_id}: set deleted_at: {e}"
                ))
            })?;
        self.doc.commit();
        Ok(())
    }
    /// Reparent / re-position a block on the [`LoroTree`].
    ///
    /// The reparent is `tree.mov` — Loro's **move-CRDT**: concurrent
    /// reparents of the same node converge deterministically across peers
    /// (not per-key LWW), and a move that would form a cycle (target into
    /// its own descendant) fails with `CyclicMoveError`. The command layer
    /// already rejects cycles up-front, so a local move never hits that;
    /// for a replayed/remote op that *would* (corruption, or an ancestor
    /// purged out from under it) we **log and skip the reparent** rather
    /// than fail the whole apply — the position update still lands.
    ///
    /// An **unknown** `new_parent_id` (a target not yet in the engine — an
    /// out-of-order replayed/remote move) does NOT detach the node to root:
    /// the reparent is skipped (the node keeps its current parent) and the
    /// intent is recorded in [`Self::pending_parent`] so it re-fires when the
    /// parent appears. Yanking a node to root on a *move* would be
    /// data-destructive vs the prior tree state (unlike a create, which had
    /// no prior home). `None` is an explicit move to top-level (root).
    ///
    /// **Legacy op-replay path** (pre-#400 ops carrying a 1-based `position`).
    /// It writes the `i64` [`FIELD_POSITION`] meta and derives a fractional slot
    /// via [`Self::legacy_slot`] so a replayed historical op reproduces the old
    /// `ORDER BY position ASC, id ASC`. New ops carry a 0-based slot and go
    /// through [`Self::apply_move_block_to`]; sibling order is the tree's
    /// fractional index (the SQL `position` is a derived dense rank — see the
    /// [`LoroEngine`] type docstring).
    pub fn apply_move_block(
        &mut self,
        block_id: &str,
        new_parent_id: Option<&str>,
        new_position: i64,
    ) -> Result<(), AppError> {
        let node = self.node_for(block_id).ok_or_else(|| {
            AppError::Validation(format!("loro: move block: block {block_id} not found"))
        })?;
        // Stamp the legacy position so later legacy ops can convert against it,
        // then derive the slot it maps to among the target parent's children.
        let meta = self.tree().get_meta(node).map_err(|e| {
            AppError::Validation(format!("loro: move block {block_id}: get_meta: {e}"))
        })?;
        self.write_legacy_position(&meta, block_id, new_position)?;
        let target = self.resolve_move_target(block_id, new_parent_id);
        let slot = match target {
            Some(parent) => self.legacy_slot(parent, new_position, block_id, Some(node)),
            None => 0,
        };
        self.move_block_impl(block_id, node, target, slot)
    }
    /// New-scheme move (#400): re-place `block_id` at the 0-based sibling
    /// `index` under `new_parent_id` via Loro's fractional index. The `index`
    /// is an insertion slot among the *other* children (the moved node is
    /// excluded), matching `LoroTree::mov_to` semantics. No `position` meta.
    pub fn apply_move_block_to(
        &mut self,
        block_id: &str,
        new_parent_id: Option<&str>,
        index: usize,
    ) -> Result<(), AppError> {
        let node = self.node_for(block_id).ok_or_else(|| {
            AppError::Validation(format!("loro: move block: block {block_id} not found"))
        })?;
        let target = self.resolve_move_target(block_id, new_parent_id);
        // `index` is a live-sibling slot from the frontend; translate to a tree
        // slot (excluding the moved node) so soft-deleted siblings don't shift
        // the placement (#400).
        let tree_slot = match target {
            Some(parent) => self.live_tree_slot(parent, index, Some(node)),
            None => index,
        };
        self.move_block_impl(block_id, node, target, tree_slot)
    }
    /// Resolve a move's reparent target. `None` request → tree root. A `Some`
    /// parent that is not yet in the engine → keep the current parent (record
    /// the intent in `pending_parent`) and return `None` so the slot logic
    /// skips. `Some(parent)` present → that node.
    pub(super) fn resolve_move_target(
        &mut self,
        block_id: &str,
        new_parent_id: Option<&str>,
    ) -> Option<TreeParentId> {
        match new_parent_id {
            None => Some(TreeParentId::Root),
            Some(pid) => match self.node_for(pid) {
                Some(parent_node) => {
                    self.pending_parent.remove(block_id);
                    Some(TreeParentId::Node(parent_node))
                }
                None => {
                    self.pending_parent
                        .insert(block_id.to_string(), pid.to_string());
                    tracing::warn!(
                        block_id, parent_id = %pid,
                        "move block: parent not yet in engine; keeping current parent (pending)",
                    );
                    None
                }
            },
        }
    }
    /// Shared move implementation: place `node` at `slot` under `target` via
    /// `mov_to` (clamped to the valid range). `target == None` means the parent
    /// is not yet present — the legacy position / pending intent was already
    /// recorded, so just commit and return. Cycle-forming reparents are logged
    /// and skipped (deterministic CRDT behaviour), matching the prior `mov`.
    pub(super) fn move_block_impl(
        &mut self,
        block_id: &str,
        node: TreeID,
        target: Option<TreeParentId>,
        slot: usize,
    ) -> Result<(), AppError> {
        let Some(target) = target else {
            self.doc.commit();
            return Ok(());
        };
        // Moving within the same parent shrinks the addressable range by one
        // (the node vacates its slot); `mov_to` treats `index` as a slot among
        // the other children, so clamp to `count - 1` in that case.
        let already_child = self.tree().parent(node) == Some(target);
        let count = self.tree().children_num(target).unwrap_or(0);
        let max = if already_child {
            count.saturating_sub(1)
        } else {
            count
        };
        let slot = clamp_slot(slot, max);
        match self.tree().mov_to(node, target, slot) {
            Ok(()) => {}
            Err(e) if is_cyclic_move(&e) => {
                tracing::warn!(
                    block_id, error = %e,
                    "move block: cycle-forming reparent rejected by LoroTree; skipping reparent",
                );
            }
            Err(e) => {
                self.doc.commit();
                return Err(AppError::Validation(format!(
                    "loro: move block {block_id}: tree.mov_to: {e}"
                )));
            }
        }
        self.mark_sibling_order_current();
        self.doc.commit();
        Ok(())
    }
    /// Mirrors `SetProperty`, storing a native typed value (PEND-80 §2.1):
    /// `Num`→`Double`, `Bool`→`Bool`, `Str`→`String`, `Null`→explicit clear.
    /// Stored under `block_properties` keyed by block_id then property key.
    /// LWW per `(block_id, key)`. `PropertyValue::Null` writes an explicit
    /// Null (clear), distinct from "key absent".
    pub fn apply_set_property_typed(
        &mut self,
        block_id: &str,
        key: &str,
        value: &PropertyValue,
    ) -> Result<(), AppError> {
        let props_root: LoroMap = self.doc.get_map(BLOCK_PROPERTIES_ROOT);
        // Re-using an attached container is fine; `insert_container`
        // errors if the slot is already populated, so we read first.
        let block_props: LoroMap = match props_root.get(block_id) {
            Some(voc) => voc
                .into_container()
                .map_err(|_| {
                    AppError::Validation(format!(
                        "loro: set_property block {block_id} props slot is not a container"
                    ))
                })?
                .into_map()
                .map_err(|_| {
                    AppError::Validation(format!(
                        "loro: set_property block {block_id} props is not a LoroMap"
                    ))
                })?,
            None => props_root
                .insert_container(block_id, LoroMap::new())
                .map_err(|e| {
                    AppError::Validation(format!(
                        "loro: set_property: create props map for {block_id}: {e}"
                    ))
                })?,
        };
        block_props.insert(key, value.to_loro()).map_err(|e| {
            AppError::Validation(format!(
                "loro: set_property block {block_id} key {key}: {e}"
            ))
        })?;
        self.doc.commit();
        Ok(())
    }
    /// String-valued `SetProperty` shim for legacy callers / parity paths.
    /// `value = None` writes an explicit Null (clear). Prefer
    /// [`apply_set_property_typed`] on the write path so numbers and booleans
    /// are stored natively rather than flattened to a string.
    pub fn apply_set_property(
        &mut self,
        block_id: &str,
        key: &str,
        value: Option<&str>,
    ) -> Result<(), AppError> {
        let v = match value {
            Some(s) => PropertyValue::Str(s.to_string()),
            None => PropertyValue::Null,
        };
        self.apply_set_property_typed(block_id, key, &v)
    }
    /// Mirrors `DeleteProperty` — removes the `(block_id, key)` entry
    /// from the per-block props LoroMap entirely (distinct from
    /// `apply_set_property(value=None)` which writes an explicit Null).
    ///
    /// Idempotent:
    ///   * key absent on this block -> Ok(()) no-op.
    ///   * block has never had any properties -> Ok(()) no-op.
    pub fn apply_delete_property(&mut self, block_id: &str, key: &str) -> Result<(), AppError> {
        let props_root: LoroMap = self.doc.get_map(BLOCK_PROPERTIES_ROOT);
        let Some(voc) = props_root.get(block_id) else {
            // No props ever written for this block — idempotent no-op.
            return Ok(());
        };
        let block_props: LoroMap = voc
            .into_container()
            .map_err(|_| {
                AppError::Validation(format!(
                    "loro: delete_property block {block_id} props slot is not a container"
                ))
            })?
            .into_map()
            .map_err(|_| {
                AppError::Validation(format!(
                    "loro: delete_property block {block_id} props is not a LoroMap"
                ))
            })?;
        if block_props.get(key).is_none() {
            // Key was never set (or already deleted) — idempotent no-op.
            return Ok(());
        }
        block_props.delete(key).map_err(|e| {
            AppError::Validation(format!(
                "loro: delete_property block {block_id} key {key}: {e}"
            ))
        })?;
        self.doc.commit();
        Ok(())
    }
    /// Mirrors `AddTag` — associates `tag_id` with `block_id` in the
    /// `block_tags` map.  See the `BLOCK_TAGS_ROOT` docstring for the
    /// name-keyed-map shape (#622 fix / #709 Phase 1) and the legacy
    /// LoroList compatibility story.
    ///
    /// Idempotent: re-adding a tag already on the block is a no-op —
    /// for map-shaped slots `LoroMap::insert` itself records no op when
    /// the key already holds the same value; for legacy list slots the
    /// local contains-check bails. Matches the SQL `INSERT OR IGNORE
    /// INTO block_tags ...` semantics in `commands/tags.rs::
    /// add_tag_inner`. Unlike the pre-#622 list push, the map insert is
    /// also **convergent**: two peers concurrently adding the same tag
    /// write the same key and merge to one entry via per-key LWW.
    pub fn apply_add_tag(&mut self, block_id: &str, tag_id: &str) -> Result<(), AppError> {
        let tags_root: LoroMap = self.doc.get_map(BLOCK_TAGS_ROOT);
        match tags_slot(&tags_root, block_id, "add_tag")? {
            Some(TagsSlot::Map(tag_map)) => {
                // #845: rename-aware re-key. A tag renamed after it was
                // added sits under its STALE name key; the tag being
                // added may resolve to that same (now-freed) name. A
                // plain `insert` at that key would CLOBBER the stale
                // entry — destroying the renamed tag's association, which
                // the next `reproject_block_tags_from_engine` then
                // deletes from SQL (the #845 data loss). Migrate every
                // stale-keyed entry on this block to its current name key
                // first, so the colliding key is free for the new tag.
                self.rekey_stale_tag_entries(block_id, &tag_map)?;
                let key = self.tag_map_key_for(tag_id);
                tag_map.insert(&key, LoroValue::from(tag_id)).map_err(|e| {
                    AppError::Validation(format!(
                        "loro: add_tag block {block_id} tag {tag_id}: insert: {e}"
                    ))
                })?;
            }
            Some(TagsSlot::List(block_tags)) => {
                // Legacy pre-#622 doc — keep the list shape in place
                // (no structural migration before #709 Phase 2; see the
                // BLOCK_TAGS_ROOT docstring). Local dedupe check + push:
                // a concurrent duplicate is still representable here,
                // but `read_tags` flattens it and `apply_remove_tag`
                // sweeps every occurrence, so it can no longer
                // resurrect a removed tag.
                if list_contains_string(&block_tags, tag_id) {
                    return Ok(());
                }
                block_tags.push(LoroValue::from(tag_id)).map_err(|e| {
                    AppError::Validation(format!(
                        "loro: add_tag block {block_id} tag {tag_id}: push: {e}"
                    ))
                })?;
            }
            None => {
                let tag_map = tags_root
                    .insert_container(block_id, LoroMap::new())
                    .map_err(|e| {
                        AppError::Validation(format!(
                            "loro: add_tag: create tags map for {block_id}: {e}"
                        ))
                    })?;
                let key = self.tag_map_key_for(tag_id);
                tag_map.insert(&key, LoroValue::from(tag_id)).map_err(|e| {
                    AppError::Validation(format!(
                        "loro: add_tag block {block_id} tag {tag_id}: insert: {e}"
                    ))
                })?;
            }
        }
        self.doc.commit();
        Ok(())
    }
    /// Resolve the [`BLOCK_TAGS_ROOT`] map key under which `tag_id`'s
    /// association is stored: the tag block's normalized name
    /// ([`crate::tag_norm::normalize_tag_name`] over its `content`),
    /// degrading to the raw `tag_id` when the tag block is absent from
    /// this doc or its normalized name is empty. See the
    /// [`BLOCK_TAGS_ROOT`] docstring for the namespace-collision
    /// argument.
    pub(super) fn tag_map_key_for(&self, tag_id: &str) -> String {
        if let Some(node) = self.node_for(tag_id)
            && let Ok(meta) = self.tree().get_meta(node)
            && let Ok(name) = read_text(&meta, FIELD_CONTENT)
        {
            let key = crate::tag_norm::normalize_tag_name(&name);
            if !key.is_empty() {
                return key;
            }
        }
        tag_id.to_string()
    }
    /// #845: migrate any entry in a block's name-keyed tag map that sits
    /// under a STALE key to the tag's CURRENT name key.
    ///
    /// The slot value is the `tag_id`; its key is the tag block's
    /// normalized name resolved at the time the entry was written
    /// ([`Self::tag_map_key_for`]). A later rename of the tag block
    /// leaves the entry under the old name — so its stored key no longer
    /// equals `tag_map_key_for(value)`. Left in place, that stale key can
    /// be overwritten by a *different* tag that now resolves to the same
    /// (freed) name (a new tag reusing the old name), silently destroying
    /// the renamed tag's association.
    ///
    /// This sweep runs before [`Self::apply_add_tag`]'s map insert so the
    /// colliding key is vacated first. It is also self-healing: any block
    /// touched by an add converges its stale keys to current names. Only
    /// entries whose current key differs *and* is not already occupied by
    /// the same tag_id are moved; an entry already under its current key
    /// is untouched (no spurious op). Skips re-keying onto a key held by
    /// a DIFFERENT tag_id (that target is itself stale or a genuine
    /// same-name coalesce — #709 LWW handles it on insert), and onto the
    /// degraded raw-id key (unresolvable tag block — nothing to migrate).
    pub(super) fn rekey_stale_tag_entries(
        &self,
        block_id: &str,
        tag_map: &LoroMap,
    ) -> Result<(), AppError> {
        // Snapshot current (key -> tag_id) so we don't mutate under for_each.
        let mut entries: Vec<(String, String)> = Vec::new();
        tag_map.for_each(|key, voc| {
            if let Ok(LoroValue::String(s)) = voc.into_value() {
                entries.push((key.to_string(), (*s).clone()));
            }
        });
        // Set of keys currently present, to detect collisions before moving.
        let present: std::collections::HashSet<&str> =
            entries.iter().map(|(k, _)| k.as_str()).collect();

        let mut moves: Vec<(String, String, String)> = Vec::new(); // (old_key, new_key, tag_id)
        for (key, tag_id) in &entries {
            let current_key = self.tag_map_key_for(tag_id);
            if &current_key == key {
                continue; // already under its current name — nothing to do
            }
            // Don't displace a different tag already sitting under the
            // target key; let the insert/LWW path decide that case.
            if present.contains(current_key.as_str()) {
                continue;
            }
            moves.push((key.clone(), current_key, tag_id.clone()));
        }

        for (old_key, new_key, tag_id) in moves {
            tag_map
                .insert(&new_key, LoroValue::from(tag_id.as_str()))
                .map_err(|e| {
                    AppError::Validation(format!(
                        "loro: add_tag block {block_id} rekey tag {tag_id} \
                         to {new_key}: {e}"
                    ))
                })?;
            tag_map.delete(&old_key).map_err(|e| {
                AppError::Validation(format!(
                    "loro: add_tag block {block_id} rekey delete stale key \
                     {old_key}: {e}"
                ))
            })?;
        }
        Ok(())
    }
    /// Mirrors `RemoveTag` — dissociates `tag_id` from `block_id`.
    ///
    /// Idempotent: if `tag_id` is not present (or the block has no
    /// tags container at all) the call is a no-op.  Matches the SQL
    /// `DELETE FROM block_tags ...` (which is itself idempotent — a
    /// DELETE matching zero rows is not an error).
    ///
    /// #622: removal sweeps **every** stored occurrence of `tag_id`,
    /// not the first match — for map-shaped slots that means every
    /// entry whose *value* is `tag_id` (a rename can leave the same
    /// tag_id under a stale-name key next to its current-name key; a
    /// key-only delete would leave the stale entry to resurrect the
    /// tag on reprojection), and for legacy list slots every duplicate
    /// element a pre-fix concurrent add left behind. Matching by value
    /// also means no name resolution is needed here at all.
    pub fn apply_remove_tag(&mut self, block_id: &str, tag_id: &str) -> Result<(), AppError> {
        let tags_root: LoroMap = self.doc.get_map(BLOCK_TAGS_ROOT);
        let mut removed_any = false;
        match tags_slot(&tags_root, block_id, "remove_tag")? {
            // No tag container for this block — idempotent no-op.
            None => return Ok(()),
            Some(TagsSlot::Map(tag_map)) => {
                // Collect first, then delete — don't mutate under for_each.
                let mut doomed_keys: Vec<String> = Vec::new();
                tag_map.for_each(|key, voc| {
                    if let Ok(LoroValue::String(s)) = voc.into_value()
                        && s.as_str() == tag_id
                    {
                        doomed_keys.push(key.to_string());
                    }
                });
                for key in doomed_keys {
                    tag_map.delete(&key).map_err(|e| {
                        AppError::Validation(format!(
                            "loro: remove_tag block {block_id} tag {tag_id} key {key}: {e}"
                        ))
                    })?;
                    removed_any = true;
                }
            }
            Some(TagsSlot::List(block_tags)) => {
                // Legacy list: delete ALL occurrences (re-scan from the
                // front after each delete; indices shift left).
                while let Some(pos) = list_find_string(&block_tags, tag_id) {
                    block_tags.delete(pos, 1).map_err(|e| {
                        AppError::Validation(format!(
                            "loro: remove_tag block {block_id} tag {tag_id} at {pos}: {e}"
                        ))
                    })?;
                    removed_any = true;
                }
            }
        }
        if !removed_any {
            // Tag absent — idempotent no-op, nothing to commit.
            return Ok(());
        }
        self.doc.commit();
        Ok(())
    }
    /// Test-only: write the pre-#622 per-block tag structure — a raw
    /// `LoroList` (possibly already containing duplicate elements) at
    /// the block's `block_tags` slot — so persistence-compat tests can
    /// simulate docs written by pre-fix code. Production code paths
    /// never create this shape any more.
    #[cfg(test)]
    pub(crate) fn seed_legacy_tag_list(
        &mut self,
        block_id: &str,
        tag_ids: &[&str],
    ) -> Result<(), AppError> {
        let tags_root: LoroMap = self.doc.get_map(BLOCK_TAGS_ROOT);
        let list = tags_root
            .insert_container(block_id, LoroList::new())
            .map_err(|e| {
                AppError::Validation(format!("loro: seed legacy tag list for {block_id}: {e}"))
            })?;
        for tag_id in tag_ids {
            list.push(LoroValue::from(*tag_id)).map_err(|e| {
                AppError::Validation(format!("loro: seed legacy tag push {tag_id}: {e}"))
            })?;
        }
        self.doc.commit();
        Ok(())
    }
    /// Mirrors `RestoreBlock` — undeletes a soft-deleted block by
    /// clearing its `deleted_at` field to LoroValue::Null.
    ///
    /// `read_deleted` already treats `Null` as "not deleted" (matching
    /// `apply_create_block`, which never writes the field), so a
    /// post-restore `read_deleted` returns `false`.
    ///
    /// Idempotent: re-applying on an already-restored block is a
    /// no-op (Null over Null).  Errors only if the block id is
    /// missing from the engine entirely.
    ///
    /// Concurrent-restore semantics: two devices restoring the same
    /// block converge on `deleted_at = Null` via Loro's per-key LWW.
    /// If one device deletes while another restores, LWW picks the
    /// later-Lamport-ts write — same shape as the
    /// `apply_delete_block` doc.
    pub fn apply_restore_block(&mut self, block_id: &str) -> Result<(), AppError> {
        // Silent no-op when the block is absent — mirrors SQL
        // `apply_restore_block_tx`'s UPDATE-matching-zero-rows
        // semantics. A RestoreBlock op for a block purged on a peer
        // must not propagate as a hard error.
        let Some(node) = self.node_for(block_id) else {
            return Ok(());
        };
        let meta = self.tree().get_meta(node).map_err(|e| {
            AppError::Validation(format!("loro: restore block {block_id}: get_meta: {e}"))
        })?;
        meta.insert(FIELD_DELETED_AT, LoroValue::Null)
            .map_err(|e| {
                AppError::Validation(format!(
                    "loro: restore block {block_id}: clear deleted_at: {e}"
                ))
            })?;
        self.doc.commit();
        Ok(())
    }
    /// Mirrors `PurgeBlock` — hard-removes the block's tree node
    /// (`tree.delete`), plus its `block_properties` and `block_tags`
    /// entries (matches the SQL purge cascade in
    /// `materializer/handlers.rs::apply_purge_block_tx`).
    ///
    /// Note: this engine is per-block-id only — it does NOT walk
    /// descendants.  The materializer's purge cascade enumerates the
    /// descendant set via the recursive CTE and dispatches one
    /// `PurgeBlock` per descendant; each descendant's own apply call
    /// reaches this method. (LoroTree's own `delete` drops a purged
    /// node's children from the visible tree, but we still dispatch one
    /// op per descendant so each descendant's properties/tags are purged
    /// and its SQL row removed.) Per-block scope is correct.
    ///
    /// Idempotent: if the block is already absent (concurrent purge,
    /// or never created), all deletions are no-ops.
    pub fn apply_purge_block(&mut self, block_id: &str) -> Result<(), AppError> {
        if let Some(node) = self.node_for(block_id) {
            // The purge command emits a single `PurgeBlock` op for the seed
            // and SQL-cascades its descendants — it does *not* fan a purge
            // op per descendant to the engine. `tree.delete(seed)` orphans
            // the seed's children under Loro's Deleted root (they become
            // transitively `is_node_deleted`), so they vanish from the live
            // tree but linger in `self.index`. Collect the whole subtree's
            // block_ids *before* deleting and prune them, so the local read
            // surface (`read_block`, `count_alive_blocks`) matches the SQL
            // cascade and the post-`import` `rebuild_index` state.
            let subtree_ids = self.collect_subtree_block_ids(node);
            self.tree().delete(node).map_err(|e| {
                AppError::Validation(format!("loro: purge block {block_id}: tree.delete: {e}"))
            })?;
            for bid in subtree_ids {
                self.index.remove(&bid);
                self.pending_parent.remove(&bid);
            }
        }
        let props_root: LoroMap = self.doc.get_map(BLOCK_PROPERTIES_ROOT);
        if props_root.get(block_id).is_some() {
            props_root.delete(block_id).map_err(|e| {
                AppError::Validation(format!(
                    "loro: purge block {block_id}: block_properties.delete: {e}"
                ))
            })?;
        }
        let tags_root: LoroMap = self.doc.get_map(BLOCK_TAGS_ROOT);
        if tags_root.get(block_id).is_some() {
            tags_root.delete(block_id).map_err(|e| {
                AppError::Validation(format!(
                    "loro: purge block {block_id}: block_tags.delete: {e}"
                ))
            })?;
        }
        self.doc.commit();
        Ok(())
    }
}
