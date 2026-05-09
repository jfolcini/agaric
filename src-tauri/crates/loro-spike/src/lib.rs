//! PEND-09 Phase 0 spike — `LoroEngine`, the minimum viable CRDT engine.
//!
//! This is THROWAWAY code.  Goal: prove that the data shape proposed in
//! `pending/PEND-09-crdt-migration.md` (a top-level `"blocks"` LoroMap
//! whose values are per-block LoroMaps holding scalar fields) can
//! round-trip a `create_block` operation through Loro's import/export.
//!
//! Day-1 scope was intentionally tiny: one op type (create_block), no
//! merging, no concurrent peers, no character-level text.  Day 2 swaps
//! the scalar `content` string for a `LoroText` container (the headline
//! win of the migration — concurrent edits coalesce at the character
//! level) and adds `apply_edit_content` to drive the CRDT.  Parent_id
//! reparent semantics, the rest of the 12 op variants, and parity vs
//! `merge/tests.rs` still land in later days of the 2-week time-box.

pub mod tree_engine;
pub use tree_engine::{TreeBlockSnapshot, TreeEngine};

use anyhow::{anyhow, Context, Result};
use loro::{ExportMode, LoroDoc, LoroMap, LoroText, LoroValue};

/// Top-level LoroMap key holding the per-block sub-maps.
///
/// Mirrors the data shape in PEND-09-crdt-migration.md (lines 17-36):
/// `loro_doc.getMap("blocks")` -> `LoroMap<block_id, BlockData>`.
const BLOCKS_ROOT: &str = "blocks";

/// Top-level LoroMap key holding per-block properties.  Each value is a
/// `LoroMap<key, value>` with LWW semantics — overwriting a key on two
/// peers concurrently resolves via Loro's per-key LWW.  Day-3 addition
/// for the `set_property` op shape in `merge/tests.rs`.
const BLOCK_PROPERTIES_ROOT: &str = "block_properties";

// Field keys inside a per-block LoroMap.  Kept as &'static str constants
// so the round-trip read path uses the same key strings the writer used.
const FIELD_BLOCK_TYPE: &str = "block_type";
const FIELD_CONTENT: &str = "content";
const FIELD_PARENT_ID: &str = "parent_id";
const FIELD_POSITION: &str = "position";
const FIELD_DELETED_AT: &str = "deleted_at";

/// Minimal projection of a production `Block` row sufficient to verify
/// round-trip equality.  Day-1 spike does not model the full ~10-field
/// Block shape (deleted_at, archived_at, todo_state, …) — those land
/// when the spike starts porting `merge/tests.rs` cases.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlockSnapshot {
    pub block_id: String,
    pub block_type: String,
    pub content: String,
    pub parent_id: Option<String>,
    pub position: i64,
}

/// Spike-only wrapper around a `LoroDoc`.  Owns one document; no
/// per-space partitioning yet (see plan: "one Loro document per space"
/// — Phase 1 concern, not day-1).
pub struct LoroEngine {
    doc: LoroDoc,
}

impl LoroEngine {
    /// Fresh, empty document.  No peer-id pinning yet — Loro auto-assigns
    /// a random peer id on first commit, which is fine for a single-doc
    /// round-trip test.
    pub fn new() -> Self {
        Self {
            doc: LoroDoc::new(),
        }
    }

    /// Insert a block into the doc under the `"blocks"` root LoroMap.
    ///
    /// Returns an error rather than panicking on Loro API failures so
    /// the CLI / test surface can report cleanly; Loro 1.x reserves
    /// panics for internal-invariant violations only (see loro/AGENTS.md
    /// "Internal Invariant Preservation Over Graceful Degradation").
    pub fn apply_create_block(
        &mut self,
        block_id: &str,
        block_type: &str,
        content: &str,
        parent_id: Option<&str>,
        position: i64,
    ) -> Result<()> {
        let blocks: LoroMap = self.doc.get_map(BLOCKS_ROOT);

        // Each block lives in its own LoroMap nested under `blocks`.
        // `insert_container` returns the *attached* handle — that's the
        // one whose mutations end up in the doc's oplog.
        let block_map: LoroMap = blocks
            .insert_container(block_id, LoroMap::new())
            .with_context(|| format!("create block {block_id}: insert_container"))?;

        block_map
            .insert(FIELD_BLOCK_TYPE, LoroValue::from(block_type))
            .with_context(|| format!("create block {block_id}: set block_type"))?;
        // `content` is a LoroText container, not a scalar — that's the
        // headline win of the migration.  `insert_container` returns the
        // *attached* handle; subsequent inserts go into the doc oplog.
        // `LoroText::insert` takes Unicode-scalar offsets (see Loro 1.12
        // `crates/loro/src/lib.rs:2298-2301` — "Insert a string at the
        // given unicode position").
        let content_text: LoroText = block_map
            .insert_container(FIELD_CONTENT, LoroText::new())
            .with_context(|| format!("create block {block_id}: insert content container"))?;
        content_text
            .insert(0, content)
            .with_context(|| format!("create block {block_id}: write initial content"))?;
        // Nullable string -> LoroValue::Null when absent.
        let parent_value = match parent_id {
            Some(p) => LoroValue::from(p),
            None => LoroValue::Null,
        };
        block_map
            .insert(FIELD_PARENT_ID, parent_value)
            .with_context(|| format!("create block {block_id}: set parent_id"))?;
        block_map
            .insert(FIELD_POSITION, LoroValue::from(position))
            .with_context(|| format!("create block {block_id}: set position"))?;

        // commit() flushes the implicit transaction so the change is
        // visible to subsequent reads + included in any export.
        self.doc.commit();
        Ok(())
    }

    /// Read a block back from the doc.  Returns `None` when the block_id
    /// is absent.  Returns `Err` only when a key is present but its value
    /// has the wrong shape — that signals a writer/reader mismatch and
    /// should fail loudly.
    pub fn read_block(&self, block_id: &str) -> Result<Option<BlockSnapshot>> {
        let blocks: LoroMap = self.doc.get_map(BLOCKS_ROOT);
        let Some(block_value) = blocks.get(block_id) else {
            return Ok(None);
        };

        // `LoroMap::get` returns a `ValueOrContainer`; nested containers
        // come back as `Container(...)`.  Both `into_container` and
        // `into_map` are `EnumAsInner`-derived `Result` accessors that
        // return `Err(self)` on a variant mismatch — collapse both into
        // a single anyhow error.
        let container = block_value
            .into_container()
            .map_err(|_| anyhow!("block {block_id} value is not a container"))?;
        let block_map: LoroMap = container
            .into_map()
            .map_err(|_| anyhow!("block {block_id} container is not a LoroMap"))?;

        let block_type = read_string(&block_map, FIELD_BLOCK_TYPE)
            .with_context(|| format!("block {block_id}: block_type"))?;
        let content = read_text(&block_map, FIELD_CONTENT)
            .with_context(|| format!("block {block_id}: content"))?;
        let parent_id = read_optional_string(&block_map, FIELD_PARENT_ID)
            .with_context(|| format!("block {block_id}: parent_id"))?;
        let position = read_i64(&block_map, FIELD_POSITION)
            .with_context(|| format!("block {block_id}: position"))?;

        Ok(Some(BlockSnapshot {
            block_id: block_id.to_string(),
            block_type,
            content,
            parent_id,
            position,
        }))
    }

    /// Splice an edit into a block's `content` LoroText.
    ///
    /// Mirrors what an editor's edit callback would natively produce:
    /// "at unicode-offset `range_start`, delete `range_len` unicode
    /// scalars, insert `replacement`".  Returns `Err` if the block is
    /// absent, if `content` isn't a LoroText, or if the range is out
    /// of bounds.
    ///
    /// **Offset semantics: Unicode scalar (USV) indices**, matching the
    /// native [`LoroText::splice`] API in Loro 1.12 (see
    /// `crates/loro/src/lib.rs:2393-2396` — "Delete specified character
    /// and insert string at the same position at given unicode position").
    /// Loro also exposes `splice_utf16` and `splice_utf8` variants if a
    /// caller's edit callback uses a different coordinate system; for
    /// the spike we standardise on Unicode scalars because (a) it's the
    /// default in Loro's own README examples and (b) it matches how
    /// `len_unicode()` reports length.
    pub fn apply_edit_content(
        &mut self,
        block_id: &str,
        range_start: usize,
        range_len: usize,
        replacement: &str,
    ) -> Result<()> {
        let blocks: LoroMap = self.doc.get_map(BLOCKS_ROOT);
        let block_value = blocks
            .get(block_id)
            .ok_or_else(|| anyhow!("edit content: block {block_id} not found"))?;
        let block_map: LoroMap = block_value
            .into_container()
            .map_err(|_| anyhow!("edit content: block {block_id} value is not a container"))?
            .into_map()
            .map_err(|_| anyhow!("edit content: block {block_id} container is not a LoroMap"))?;
        let content_value = block_map
            .get(FIELD_CONTENT)
            .ok_or_else(|| anyhow!("edit content: block {block_id} has no content field"))?;
        let content_text: LoroText = content_value
            .into_container()
            .map_err(|_| anyhow!("edit content: block {block_id} content slot is not a container"))?
            .into_text()
            .map_err(|_| anyhow!("edit content: block {block_id} content is not a LoroText"))?;

        // Up-front bound check.  `LoroText::splice` itself returns
        // `LoroError::OutOfBound` if start+len exceeds `len_unicode`,
        // but checking here keeps the error message in our domain
        // ("block X edit went past content end") rather than Loro's.
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

    /// Replace a block's `content` LoroText wholesale.  Mirrors the
    /// production `EditBlock` op which takes a `to_text` snapshot of the
    /// block's whole content (line-granularity diffy diffs the LCA
    /// against this string).  Implemented as `splice(0, len_unicode,
    /// new_content)` so Loro records a single character-level operation
    /// rather than a "set" — concurrent calls on two peers still merge
    /// at the character level.
    pub fn apply_edit_block(&mut self, block_id: &str, new_content: &str) -> Result<()> {
        let block_map = self.get_block_map(block_id, "edit block")?;
        let content_text = block_map_get_text(&block_map, FIELD_CONTENT, block_id, "edit block")?;
        let len = content_text.len_unicode();
        content_text
            .splice(0, len, new_content)
            .map_err(|e| anyhow!("edit_block: block {block_id} splice failed: {e}"))?;
        self.doc.commit();
        Ok(())
    }

    /// Soft-delete a block — mirrors `DeleteBlock`.  Spike doesn't model
    /// real timestamps; we set `deleted_at` to a fixed marker and let
    /// production logic re-stamp later.  Concurrent deletes converge on
    /// the same "deleted" state via LWW (both peers write the same value
    /// — Loro's set-and-forget semantics for scalars handle this idempotently).
    pub fn apply_delete_block(&mut self, block_id: &str) -> Result<()> {
        let block_map = self.get_block_map(block_id, "delete block")?;
        block_map
            .insert(FIELD_DELETED_AT, LoroValue::from("2025-01-15T12:00:00Z"))
            .with_context(|| format!("delete block {block_id}: set deleted_at"))?;
        self.doc.commit();
        Ok(())
    }

    /// Mirrors `MoveBlock` — update both `parent_id` and `position`
    /// scalars on the block's LoroMap.  Two devices reparenting the same
    /// block to *different* parents resolves via LWW (Loro's LoroMap
    /// `insert` is LWW per key); the loser's intent is dropped, which
    /// matches the plan's stated tradeoff.
    pub fn apply_move_block(
        &mut self,
        block_id: &str,
        new_parent_id: Option<&str>,
        new_position: i64,
    ) -> Result<()> {
        let block_map = self.get_block_map(block_id, "move block")?;
        let parent_value = match new_parent_id {
            Some(p) => LoroValue::from(p),
            None => LoroValue::Null,
        };
        block_map
            .insert(FIELD_PARENT_ID, parent_value)
            .with_context(|| format!("move block {block_id}: set parent_id"))?;
        block_map
            .insert(FIELD_POSITION, LoroValue::from(new_position))
            .with_context(|| format!("move block {block_id}: set position"))?;
        self.doc.commit();
        Ok(())
    }

    /// Mirrors `SetProperty` (string values only — sufficient for the
    /// corpus port).  Stores under the top-level `block_properties` map,
    /// nested by block_id then key.  LWW per (block_id, key).
    pub fn apply_set_property(
        &mut self,
        block_id: &str,
        key: &str,
        value: Option<&str>,
    ) -> Result<()> {
        let props_root: LoroMap = self.doc.get_map(BLOCK_PROPERTIES_ROOT);
        // Ensure the per-block sub-map exists.  Re-using an attached
        // container is fine; `insert_container` returns the existing one
        // if it's already present? — actually it errors, so we read first.
        let block_props: LoroMap = match props_root.get(block_id) {
            Some(voc) => voc
                .into_container()
                .map_err(|_| {
                    anyhow!("set_property: block {block_id} props slot is not a container")
                })?
                .into_map()
                .map_err(|_| anyhow!("set_property: block {block_id} props is not a LoroMap"))?,
            None => props_root
                .insert_container(block_id, LoroMap::new())
                .with_context(|| format!("set_property: create props map for {block_id}"))?,
        };
        let v = match value {
            Some(s) => LoroValue::from(s),
            None => LoroValue::Null,
        };
        block_props
            .insert(key, v)
            .with_context(|| format!("set_property: block {block_id} key {key}"))?;
        self.doc.commit();
        Ok(())
    }

    /// Read a property back; returns `None` for an unset key (no entry
    /// in the map) and `Some(None)` for an explicit-null clear.
    pub fn read_property(&self, block_id: &str, key: &str) -> Result<Option<Option<String>>> {
        let props_root: LoroMap = self.doc.get_map(BLOCK_PROPERTIES_ROOT);
        let Some(voc) = props_root.get(block_id) else {
            return Ok(None);
        };
        let block_props: LoroMap = voc
            .into_container()
            .map_err(|_| anyhow!("read_property: block {block_id} props slot is not a container"))?
            .into_map()
            .map_err(|_| anyhow!("read_property: block {block_id} props is not a LoroMap"))?;
        let Some(value_voc) = block_props.get(key) else {
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

    /// Read the current parent_id scalar of a block.  Returns `None`
    /// if the block is missing or its slot is null.
    pub fn read_parent(&self, block_id: &str) -> Result<Option<String>> {
        let block_map = self.get_block_map(block_id, "read parent")?;
        read_optional_string(&block_map, FIELD_PARENT_ID)
    }

    /// Read the current position scalar.
    pub fn read_position(&self, block_id: &str) -> Result<i64> {
        let block_map = self.get_block_map(block_id, "read position")?;
        read_i64(&block_map, FIELD_POSITION)
    }

    /// True iff `deleted_at` has been set on this block (any non-null value).
    pub fn read_deleted(&self, block_id: &str) -> Result<bool> {
        let block_map = self.get_block_map(block_id, "read deleted")?;
        match block_map.get(FIELD_DELETED_AT) {
            None => Ok(false),
            Some(voc) => {
                let value = voc.into_value().map_err(|_| {
                    anyhow!("read_deleted: block {block_id} deleted_at is not a scalar")
                })?;
                Ok(!matches!(value, LoroValue::Null))
            }
        }
    }

    /// Day-4 addition for the replay benchmark.  Iterates the top-level
    /// `blocks` LoroMap and counts entries whose `deleted_at` slot is
    /// either absent or `LoroValue::Null` — i.e. blocks that have NOT
    /// been soft-deleted.  Used by `replay_bench` to compare the count of
    /// synthesised creates minus deletes against the engine's view, as a
    /// cheap sanity check that nothing dropped on the floor during the
    /// 100K-op replay.
    ///
    /// Cost is O(N_blocks) per call — only called a handful of times by
    /// the bench (start, every 10K ops, end), so iteration cost is in
    /// the noise compared to the apply loop.
    pub fn count_alive_blocks(&self) -> Result<usize> {
        let blocks: LoroMap = self.doc.get_map(BLOCKS_ROOT);
        let mut alive = 0usize;
        let mut err: Option<anyhow::Error> = None;
        // `LoroMap::for_each` takes `FnMut(&str, ValueOrContainer)` and
        // visits every key in insertion order.  We can't return early
        // from inside the closure, so capture the first error and check
        // after the loop.
        blocks.for_each(|key, voc| {
            if err.is_some() {
                return;
            }
            // Each value is the per-block LoroMap container.
            let container = match voc.into_container() {
                Ok(c) => c,
                Err(_) => {
                    err = Some(anyhow!("count_alive: block {key} value is not a container"));
                    return;
                }
            };
            let block_map: LoroMap = match container.into_map() {
                Ok(m) => m,
                Err(_) => {
                    err = Some(anyhow!(
                        "count_alive: block {key} container is not a LoroMap"
                    ));
                    return;
                }
            };
            // Mirrors `read_deleted`'s logic — absent or Null = alive.
            let deleted = match block_map.get(FIELD_DELETED_AT) {
                None => false,
                Some(field_voc) => match field_voc.into_value() {
                    Ok(LoroValue::Null) => false,
                    Ok(_) => true,
                    Err(_) => {
                        err = Some(anyhow!(
                            "count_alive: block {key} deleted_at is not a scalar"
                        ));
                        return;
                    }
                },
            };
            if !deleted {
                alive += 1;
            }
        });
        if let Some(e) = err {
            return Err(e);
        }
        Ok(alive)
    }

    /// Internal helper — fetch the per-block LoroMap by id with a
    /// uniform error-context prefix so each caller doesn't repeat the
    /// boilerplate.
    fn get_block_map(&self, block_id: &str, ctx: &str) -> Result<LoroMap> {
        let blocks: LoroMap = self.doc.get_map(BLOCKS_ROOT);
        let block_value = blocks
            .get(block_id)
            .ok_or_else(|| anyhow!("{ctx}: block {block_id} not found"))?;
        block_value
            .into_container()
            .map_err(|_| anyhow!("{ctx}: block {block_id} value is not a container"))?
            .into_map()
            .map_err(|_| anyhow!("{ctx}: block {block_id} container is not a LoroMap"))
    }

    /// Export the doc as a self-contained snapshot byte string.  Useful
    /// for size measurement + later round-trip-via-bytes tests.
    pub fn export_snapshot(&self) -> Result<Vec<u8>> {
        self.doc
            .export(ExportMode::Snapshot)
            .map_err(|e| anyhow!("export snapshot: {e}"))
    }

    /// Import bytes previously produced by `export_snapshot` (or any
    /// other Loro export mode) into this doc.  Used by the concurrent-
    /// edit test to merge a peer's state.
    pub fn import(&mut self, bytes: &[u8]) -> Result<()> {
        self.doc
            .import(bytes)
            .map(|_status| ())
            .map_err(|e| anyhow!("import: {e}"))
    }
}

impl Default for LoroEngine {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Read helpers — extract a typed scalar from a nested LoroMap value slot.
// Loro returns `Option<ValueOrContainer>`; we unwrap the inner LoroValue
// and then narrow it.
// ---------------------------------------------------------------------------

fn read_value(map: &LoroMap, key: &str) -> Result<Option<LoroValue>> {
    let Some(voc) = map.get(key) else {
        return Ok(None);
    };
    // EnumAsInner-derived: `Err(self)` on the Container variant.
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

/// Read a nested LoroText container's current value as a `String`.
///
/// `LoroText::to_string` materialises the container's current state
/// (Loro 1.12 `crates/loro/src/lib.rs:2638`).
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

fn read_optional_string(map: &LoroMap, key: &str) -> Result<Option<String>> {
    let value = read_value(map, key)?.ok_or_else(|| anyhow!("missing key {key}"))?;
    match value {
        LoroValue::Null => Ok(None),
        LoroValue::String(s) => Ok(Some((*s).clone())),
        other => Err(anyhow!("key {key}: expected String|Null, got {other:?}")),
    }
}

/// Fetch a nested LoroText container by key from a per-block LoroMap,
/// with a uniform error-context shape.  Used by `apply_edit_block` and
/// (indirectly) by `apply_edit_content` — both need a writable handle
/// onto the `content` field.
fn block_map_get_text(
    block_map: &LoroMap,
    field: &str,
    block_id: &str,
    ctx: &str,
) -> Result<LoroText> {
    let value = block_map
        .get(field)
        .ok_or_else(|| anyhow!("{ctx}: block {block_id} has no {field} field"))?;
    value
        .into_container()
        .map_err(|_| anyhow!("{ctx}: block {block_id} {field} slot is not a container"))?
        .into_text()
        .map_err(|_| anyhow!("{ctx}: block {block_id} {field} is not a LoroText"))
}

fn read_i64(map: &LoroMap, key: &str) -> Result<i64> {
    let value = read_value(map, key)?.ok_or_else(|| anyhow!("missing key {key}"))?;
    match value {
        LoroValue::I64(n) => Ok(n),
        other => Err(anyhow!("key {key}: expected I64, got {other:?}")),
    }
}
