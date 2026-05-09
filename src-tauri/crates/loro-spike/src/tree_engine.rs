//! PEND-09 Phase 0 day-5 — `TreeEngine`, the `LoroTree`-shaped mirror of
//! `LoroEngine` (open question 2).
//!
//! THROWAWAY code.  Goal: compare against the day-1..4 `LoroEngine`
//! (which uses a top-level `"blocks"` LoroMap with scalar `parent_id` /
//! `position` per block) head-to-head on the same workload.  This file
//! is the LoroTree-native variant — it asks Loro to manage the parent /
//! children relationships itself, with each tree node carrying a
//! per-node *meta map* (`LoroTree::get_meta(tree_id) -> LoroMap`) for the
//! same per-block fields the `LoroEngine` stores in its nested LoroMap.
//!
//! ### Mapping shape (decision: side-table + meta-map hybrid)
//!
//! Loro's `LoroTree::create` returns an auto-assigned [`TreeID`]
//! (`{peer_id, counter}`).  The rest of the world (op_log, materializer,
//! sync layer) keeps referencing blocks by their string ids
//! (`"BLK_00000123"` / `"PAGE_0007"`); we need a stable mapping
//! `block_id_str <-> TreeID` so external callers don't see Loro's
//! internal ids leak.
//!
//! Two reasonable shapes:
//!
//! - **Side-table**: a top-level `LoroMap` keyed by `block_id` whose
//!   value is the `TreeID`'s string form (Loro's `TreeID: Display` is
//!   "`{counter}@{peer_hex}`").  One extra map lookup per op.
//! - **Pure tree-meta**: per-node meta map carries the `block_id`; reverse
//!   lookup requires scanning all tree nodes.
//!
//! Picked shape: **HYBRID**.  Per-node fields (block_type, content
//! LoroText, position, deleted_at, properties) live in the per-node meta
//! map (natively Loro-managed).  A separate side-table top-level
//! `id_index` LoroMap holds `block_id_str -> TreeID-as-string` for the
//! external-id-to-internal-id reverse lookup.  Both peers maintain
//! identical id_index shape — Loro's per-key LWW means concurrent
//! creates of the same block_id converge cleanly.
//!
//! Rationale: the meta-map is the natural Loro idiom for "annotate a
//! tree node with structured data" (it's the API Loro itself documents
//! at line ~2989 of `crates/loro/src/lib.rs`).  The reverse-lookup
//! side-table is unavoidable because Loro doesn't index tree nodes by
//! arbitrary string keys — we need the index to keep `apply_*(block_id)`
//! cheap (O(1) instead of O(N) tree scan).

use anyhow::{anyhow, Context, Result};
use loro::{ExportMode, LoroDoc, LoroMap, LoroText, LoroTree, LoroValue, TreeID, TreeParentId};

/// Top-level `LoroTree` container under which all block tree nodes live.
const TREE_ROOT: &str = "tree";

/// Top-level `LoroMap` mapping external `block_id` strings to TreeID
/// string forms (Loro's `TreeID: Display` produces `counter@peer_hex`,
/// parseable via `TreeID::try_from(&str)`).
const ID_INDEX_ROOT: &str = "id_index";

// Per-node meta-map field keys — same names the `LoroEngine` uses for
// its nested per-block LoroMap, so the two engines stay easy to diff.
const FIELD_BLOCK_ID: &str = "block_id";
const FIELD_BLOCK_TYPE: &str = "block_type";
const FIELD_CONTENT: &str = "content";
const FIELD_POSITION: &str = "position";
const FIELD_DELETED_AT: &str = "deleted_at";
const FIELD_PROPERTIES: &str = "properties";

/// Snapshot projection — same shape as `LoroEngine::BlockSnapshot` so
/// existing assertions can be reused if we ever cross-port tests.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TreeBlockSnapshot {
    pub block_id: String,
    pub block_type: String,
    pub content: String,
    pub parent_id: Option<String>,
    pub position: i64,
}

/// Spike-only wrapper around a `LoroDoc` whose primary container is a
/// `LoroTree`.  Same surface API as `LoroEngine` for the methods the
/// day-4 replay benchmark exercises.
pub struct TreeEngine {
    doc: LoroDoc,
}

impl TreeEngine {
    pub fn new() -> Self {
        Self {
            doc: LoroDoc::new(),
        }
    }

    /// Create a block as a tree node under `parent_id`.  When
    /// `parent_id == None` the block becomes a tree root.  The
    /// auto-assigned `TreeID` is recorded in the side-table id_index so
    /// subsequent ops can resolve `block_id_str -> TreeID` in O(1).
    ///
    /// Position is stored in the meta map as a scalar (NOT via Loro's
    /// fractional-index machinery).  Reason: matching the day-1
    /// `LoroEngine` exactly, where position is a scalar i64.  Enabling
    /// `tree.enable_fractional_index(0)` would let us use `create_at` /
    /// `mov_to`, but it changes the semantics enough (reordering
    /// guarantees, doc-size growth — see Loro blog post on movable-tree
    /// implementation) that mixing the two adds noise to the head-to-head
    /// benchmark.  Phase 1 might revisit this.
    pub fn apply_create_block(
        &mut self,
        block_id: &str,
        block_type: &str,
        content: &str,
        parent_id: Option<&str>,
        position: i64,
    ) -> Result<()> {
        let tree: LoroTree = self.doc.get_tree(TREE_ROOT);

        // Resolve parent: lookup via id_index.  None / not-found -> root.
        let parent_tree_id = match parent_id {
            None => None,
            Some(pid) => self.lookup_tree_id(pid)?,
        };
        // `LoroTree::create::<Into<TreeParentId>>` — `Option<TreeID>`
        // implements that.  None -> root, Some(id) -> child of id.
        let new_tree_id: TreeID = tree
            .create(parent_tree_id)
            .with_context(|| format!("create block {block_id}: tree.create"))?;

        // Populate meta map (per-node LoroMap auto-managed by Loro).
        let meta: LoroMap = tree
            .get_meta(new_tree_id)
            .with_context(|| format!("create block {block_id}: get_meta"))?;
        meta.insert(FIELD_BLOCK_ID, LoroValue::from(block_id))
            .with_context(|| format!("create block {block_id}: meta block_id"))?;
        meta.insert(FIELD_BLOCK_TYPE, LoroValue::from(block_type))
            .with_context(|| format!("create block {block_id}: meta block_type"))?;
        // content -> LoroText container (matches LoroEngine day-2 shape).
        let content_text: LoroText = meta
            .insert_container(FIELD_CONTENT, LoroText::new())
            .with_context(|| format!("create block {block_id}: insert content container"))?;
        content_text
            .insert(0, content)
            .with_context(|| format!("create block {block_id}: content.insert"))?;
        meta.insert(FIELD_POSITION, LoroValue::from(position))
            .with_context(|| format!("create block {block_id}: meta position"))?;

        // Index the block_id -> tree_id mapping in the side-table.
        let id_index: LoroMap = self.doc.get_map(ID_INDEX_ROOT);
        id_index
            .insert(block_id, LoroValue::from(new_tree_id.to_string()))
            .with_context(|| format!("create block {block_id}: id_index insert"))?;

        self.doc.commit();
        Ok(())
    }

    /// Reparent + reposition.  Uses `LoroTree::mov` for the parent
    /// change (so the tree CRDT's concurrent-move semantics get
    /// exercised — that's the whole point of the head-to-head); position
    /// is updated as a scalar in the meta map.
    pub fn apply_move_block(
        &mut self,
        block_id: &str,
        new_parent_id: Option<&str>,
        new_position: i64,
    ) -> Result<()> {
        let tree: LoroTree = self.doc.get_tree(TREE_ROOT);
        let target_id = self
            .lookup_tree_id(block_id)?
            .ok_or_else(|| anyhow!("move block: {block_id} not in id_index"))?;

        // Resolve the new parent.  `LoroTree::mov(target, parent)` —
        // `parent: Into<TreeParentId>`.  We need to pass `Option<TreeID>`
        // so the conversion picks Root for None and Node(_) for Some(id).
        let new_parent_tree_id: Option<TreeID> = match new_parent_id {
            None => None,
            Some(pid) => self.lookup_tree_id(pid)?,
        };
        tree.mov(target_id, new_parent_tree_id)
            .with_context(|| format!("move block {block_id}: tree.mov"))?;

        // Position scalar in the meta map.
        let meta = tree
            .get_meta(target_id)
            .with_context(|| format!("move block {block_id}: get_meta"))?;
        meta.insert(FIELD_POSITION, LoroValue::from(new_position))
            .with_context(|| format!("move block {block_id}: meta position"))?;

        self.doc.commit();
        Ok(())
    }

    /// Soft-delete via meta map flag — same shape as `LoroEngine`.
    /// We deliberately do NOT call `tree.delete(target)` here:
    ///
    /// 1. `LoroTree::delete` is a HARD delete — it moves the node to
    ///    Loro's `DELETED_TREE_ROOT` and `is_node_deleted` reports true.
    ///    The plan's data shape uses *soft* deletes (a `deleted_at`
    ///    timestamp set on the block's row); these aren't equivalent.
    /// 2. Soft-delete keeps the block readable (block_type, content,
    ///    history) for audit / undo paths that the production code
    ///    relies on.
    /// 3. Keeping the same flag-based shape on both engines means
    ///    `read_deleted` is comparable apples-to-apples in the bench.
    ///
    /// `LoroTree::delete`'s semantics are explored in the dedicated
    /// concurrent-reparent test (`tests/concurrent_reparent_tree.rs`)
    /// where the question is "what does Loro do under concurrent
    /// reparent" — which exercises `mov`, not `delete`.
    pub fn apply_delete_block(&mut self, block_id: &str) -> Result<()> {
        let tree: LoroTree = self.doc.get_tree(TREE_ROOT);
        let target_id = self
            .lookup_tree_id(block_id)?
            .ok_or_else(|| anyhow!("delete block: {block_id} not in id_index"))?;
        let meta = tree
            .get_meta(target_id)
            .with_context(|| format!("delete block {block_id}: get_meta"))?;
        meta.insert(FIELD_DELETED_AT, LoroValue::from("2025-01-15T12:00:00Z"))
            .with_context(|| format!("delete block {block_id}: meta deleted_at"))?;
        self.doc.commit();
        Ok(())
    }

    /// Splice an edit into a block's content `LoroText` — identical to
    /// `LoroEngine::apply_edit_content`, since the content field is per-
    /// block-meta and not part of the tree's own structure.
    pub fn apply_edit_content(
        &mut self,
        block_id: &str,
        range_start: usize,
        range_len: usize,
        replacement: &str,
    ) -> Result<()> {
        let tree: LoroTree = self.doc.get_tree(TREE_ROOT);
        let target_id = self
            .lookup_tree_id(block_id)?
            .ok_or_else(|| anyhow!("edit content: {block_id} not in id_index"))?;
        let meta = tree
            .get_meta(target_id)
            .with_context(|| format!("edit content: {block_id} get_meta"))?;
        let content_text = meta_get_text(&meta, FIELD_CONTENT, block_id, "edit content")?;

        let len = content_text.len_unicode();
        if range_start
            .checked_add(range_len)
            .map(|end| end > len)
            .unwrap_or(true)
        {
            return Err(anyhow!(
                "edit content: block {block_id} range {range_start}+{range_len} \
                 exceeds content length {len} (unicode scalars)"
            ));
        }
        content_text
            .splice(range_start, range_len, replacement)
            .map_err(|e| anyhow!("edit content: block {block_id} splice failed: {e}"))?;
        self.doc.commit();
        Ok(())
    }

    /// Properties live in a per-node `properties` LoroMap inside the
    /// node's meta — one nesting level deeper than `LoroEngine`'s
    /// top-level `block_properties` LoroMap.  Same per-key LWW semantics
    /// either way.  Stowing them under meta keeps everything per-node
    /// consolidated (matches Loro's idiom and means `tree.delete` would
    /// take properties along with the node — useful if Phase 1 ever
    /// switches to hard delete).
    pub fn apply_set_property(
        &mut self,
        block_id: &str,
        key: &str,
        value: Option<&str>,
    ) -> Result<()> {
        let tree: LoroTree = self.doc.get_tree(TREE_ROOT);
        let target_id = self
            .lookup_tree_id(block_id)?
            .ok_or_else(|| anyhow!("set_property: {block_id} not in id_index"))?;
        let meta = tree
            .get_meta(target_id)
            .with_context(|| format!("set_property: {block_id} get_meta"))?;

        // Get-or-create the per-node properties LoroMap.
        let props: LoroMap = match meta.get(FIELD_PROPERTIES) {
            Some(voc) => voc
                .into_container()
                .map_err(|_| {
                    anyhow!("set_property: {block_id} properties slot is not a container")
                })?
                .into_map()
                .map_err(|_| anyhow!("set_property: {block_id} properties is not a LoroMap"))?,
            None => meta
                .insert_container(FIELD_PROPERTIES, LoroMap::new())
                .with_context(|| format!("set_property: {block_id} create properties map"))?,
        };
        let v = match value {
            Some(s) => LoroValue::from(s),
            None => LoroValue::Null,
        };
        props
            .insert(key, v)
            .with_context(|| format!("set_property: {block_id}/{key}"))?;
        self.doc.commit();
        Ok(())
    }

    pub fn read_block(&self, block_id: &str) -> Result<Option<TreeBlockSnapshot>> {
        let tree: LoroTree = self.doc.get_tree(TREE_ROOT);
        let Some(target_id) = self.lookup_tree_id(block_id)? else {
            return Ok(None);
        };
        if !tree.contains(target_id) {
            return Ok(None);
        }
        let meta = tree
            .get_meta(target_id)
            .with_context(|| format!("read_block: {block_id} get_meta"))?;
        let block_type = read_string(&meta, FIELD_BLOCK_TYPE)
            .with_context(|| format!("read_block {block_id}: block_type"))?;
        let content = read_text(&meta, FIELD_CONTENT)
            .with_context(|| format!("read_block {block_id}: content"))?;
        let position = read_i64(&meta, FIELD_POSITION)
            .with_context(|| format!("read_block {block_id}: position"))?;
        // Parent is read from the tree itself, NOT from a meta scalar —
        // that's the structural difference vs `LoroEngine`.
        let parent_id = self.parent_block_id_of(&tree, target_id)?;

        Ok(Some(TreeBlockSnapshot {
            block_id: block_id.to_string(),
            block_type,
            content,
            parent_id,
            position,
        }))
    }

    pub fn read_parent(&self, block_id: &str) -> Result<Option<String>> {
        let tree: LoroTree = self.doc.get_tree(TREE_ROOT);
        let target_id = self
            .lookup_tree_id(block_id)?
            .ok_or_else(|| anyhow!("read_parent: {block_id} not in id_index"))?;
        self.parent_block_id_of(&tree, target_id)
    }

    pub fn read_position(&self, block_id: &str) -> Result<i64> {
        let tree: LoroTree = self.doc.get_tree(TREE_ROOT);
        let target_id = self
            .lookup_tree_id(block_id)?
            .ok_or_else(|| anyhow!("read_position: {block_id} not in id_index"))?;
        let meta = tree
            .get_meta(target_id)
            .with_context(|| format!("read_position: {block_id} get_meta"))?;
        read_i64(&meta, FIELD_POSITION)
    }

    pub fn read_deleted(&self, block_id: &str) -> Result<bool> {
        let tree: LoroTree = self.doc.get_tree(TREE_ROOT);
        let target_id = self
            .lookup_tree_id(block_id)?
            .ok_or_else(|| anyhow!("read_deleted: {block_id} not in id_index"))?;
        let meta = tree
            .get_meta(target_id)
            .with_context(|| format!("read_deleted: {block_id} get_meta"))?;
        match meta.get(FIELD_DELETED_AT) {
            None => Ok(false),
            Some(voc) => {
                let value = voc
                    .into_value()
                    .map_err(|_| anyhow!("read_deleted: {block_id} deleted_at is not a scalar"))?;
                Ok(!matches!(value, LoroValue::Null))
            }
        }
    }

    /// Read a property back; mirrors `LoroEngine::read_property`.
    pub fn read_property(&self, block_id: &str, key: &str) -> Result<Option<Option<String>>> {
        let tree: LoroTree = self.doc.get_tree(TREE_ROOT);
        let target_id = self
            .lookup_tree_id(block_id)?
            .ok_or_else(|| anyhow!("read_property: {block_id} not in id_index"))?;
        let meta = tree
            .get_meta(target_id)
            .with_context(|| format!("read_property: {block_id} get_meta"))?;
        let Some(props_voc) = meta.get(FIELD_PROPERTIES) else {
            return Ok(None);
        };
        let props: LoroMap = props_voc
            .into_container()
            .map_err(|_| anyhow!("read_property: {block_id} properties slot not container"))?
            .into_map()
            .map_err(|_| anyhow!("read_property: {block_id} properties not LoroMap"))?;
        let Some(value_voc) = props.get(key) else {
            return Ok(None);
        };
        let value = value_voc
            .into_value()
            .map_err(|_| anyhow!("read_property: {block_id}/{key} expected scalar"))?;
        match value {
            LoroValue::Null => Ok(Some(None)),
            LoroValue::String(s) => Ok(Some(Some((*s).clone()))),
            other => Err(anyhow!(
                "read_property: {block_id}/{key} expected String|Null, got {other:?}"
            )),
        }
    }

    /// Count alive blocks — i.e. tree nodes whose `deleted_at` is unset
    /// or null.  Iterates `tree.nodes()` (excludes hard-deleted nodes —
    /// nodes that landed under DELETED_TREE_ROOT — by default).  Soft-
    /// deleted nodes (those with `deleted_at` set in the meta) ARE in
    /// `nodes()` but are filtered out here.
    pub fn count_alive_blocks(&self) -> Result<usize> {
        let tree: LoroTree = self.doc.get_tree(TREE_ROOT);
        let nodes: Vec<TreeID> = tree.nodes();
        let mut alive = 0usize;
        for tid in nodes {
            let meta = tree
                .get_meta(tid)
                .with_context(|| format!("count_alive: get_meta({tid})"))?;
            let deleted = match meta.get(FIELD_DELETED_AT) {
                None => false,
                Some(voc) => match voc.into_value() {
                    Ok(LoroValue::Null) => false,
                    Ok(_) => true,
                    Err(_) => {
                        return Err(anyhow!("count_alive: tid {tid} deleted_at is not a scalar"))
                    }
                },
            };
            if !deleted {
                alive += 1;
            }
        }
        Ok(alive)
    }

    pub fn export_snapshot(&self) -> Result<Vec<u8>> {
        self.doc
            .export(ExportMode::Snapshot)
            .map_err(|e| anyhow!("export snapshot: {e}"))
    }

    pub fn import(&mut self, bytes: &[u8]) -> Result<()> {
        self.doc
            .import(bytes)
            .map(|_| ())
            .map_err(|e| anyhow!("import: {e}"))
    }

    // ---- helpers -------------------------------------------------------

    /// Resolve a `block_id` string to its TreeID via the side-table
    /// id_index.  Returns `Ok(None)` if the block_id was never registered.
    fn lookup_tree_id(&self, block_id: &str) -> Result<Option<TreeID>> {
        let id_index: LoroMap = self.doc.get_map(ID_INDEX_ROOT);
        let Some(voc) = id_index.get(block_id) else {
            return Ok(None);
        };
        let value = voc
            .into_value()
            .map_err(|_| anyhow!("id_index: {block_id} value not scalar"))?;
        let s = match value {
            LoroValue::String(s) => (*s).clone(),
            other => {
                return Err(anyhow!(
                    "id_index: {block_id} expected String, got {other:?}"
                ))
            }
        };
        let tid = TreeID::try_from(s.as_str())
            .map_err(|e| anyhow!("id_index: {block_id} invalid TreeID '{s}': {e}"))?;
        Ok(Some(tid))
    }

    /// Translate a tree-internal parent of `tid` back to its external
    /// `block_id` string (None for root, error for unexpected states).
    /// Implementation: ask the tree for the parent, then for non-root
    /// parents read the parent's meta map for the `block_id` field.
    fn parent_block_id_of(&self, tree: &LoroTree, tid: TreeID) -> Result<Option<String>> {
        let parent = tree
            .parent(tid)
            .ok_or_else(|| anyhow!("parent_block_id_of: tid {tid} not in tree"))?;
        match parent {
            TreeParentId::Root => Ok(None),
            TreeParentId::Node(pid) => {
                let meta = tree
                    .get_meta(pid)
                    .with_context(|| format!("parent_block_id_of: get_meta({pid})"))?;
                read_string(&meta, FIELD_BLOCK_ID)
                    .map(Some)
                    .with_context(|| format!("parent_block_id_of: parent {pid} block_id"))
            }
            TreeParentId::Deleted => {
                // Hard-deleted parent — exposed as None so external callers
                // see it as "no parent" rather than crashing.  The plan's
                // current data shape doesn't hard-delete blocks (we use
                // soft-delete via `deleted_at`); this branch is defensive.
                Ok(None)
            }
            TreeParentId::Unexist => {
                // "Created in a future the current view doesn't see" —
                // not reachable from the current `apply_*` paths but kept
                // explicit so a future regression fails loudly.
                Err(anyhow!(
                    "parent_block_id_of: tid {tid} parent is Unexist (unreachable)"
                ))
            }
        }
    }
}

impl Default for TreeEngine {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Read helpers — same shape as the LoroEngine helpers but live on the
// per-node meta map instead of the per-block LoroMap.
// ---------------------------------------------------------------------------

fn read_value(map: &LoroMap, key: &str) -> Result<Option<LoroValue>> {
    let Some(voc) = map.get(key) else {
        return Ok(None);
    };
    let value = voc
        .into_value()
        .map_err(|_| anyhow!("expected scalar at key {key}, got container"))?;
    Ok(Some(value))
}

fn read_string(map: &LoroMap, key: &str) -> Result<String> {
    let value = read_value(map, key)?.ok_or_else(|| anyhow!("missing key {key}"))?;
    match value {
        LoroValue::String(s) => Ok((*s).clone()),
        other => Err(anyhow!("key {key}: expected String, got {other:?}")),
    }
}

fn read_text(map: &LoroMap, key: &str) -> Result<String> {
    let voc = map.get(key).ok_or_else(|| anyhow!("missing key {key}"))?;
    let container = voc
        .into_container()
        .map_err(|_| anyhow!("key {key}: expected container, got scalar"))?;
    let text: LoroText = container
        .into_text()
        .map_err(|_| anyhow!("key {key}: expected LoroText, got other container"))?;
    Ok(text.to_string())
}

fn read_i64(map: &LoroMap, key: &str) -> Result<i64> {
    let value = read_value(map, key)?.ok_or_else(|| anyhow!("missing key {key}"))?;
    match value {
        LoroValue::I64(n) => Ok(n),
        other => Err(anyhow!("key {key}: expected I64, got {other:?}")),
    }
}

fn meta_get_text(meta: &LoroMap, field: &str, block_id: &str, ctx: &str) -> Result<LoroText> {
    let value = meta
        .get(field)
        .ok_or_else(|| anyhow!("{ctx}: block {block_id} has no {field} field"))?;
    value
        .into_container()
        .map_err(|_| anyhow!("{ctx}: block {block_id} {field} slot is not a container"))?
        .into_text()
        .map_err(|_| anyhow!("{ctx}: block {block_id} {field} is not a LoroText"))
}
