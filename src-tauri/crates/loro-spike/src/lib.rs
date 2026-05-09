//! PEND-09 Phase 0 spike — `LoroEngine`, the minimum viable CRDT engine.
//!
//! This is THROWAWAY code.  Goal: prove that the data shape proposed in
//! `pending/PEND-09-crdt-migration.md` (a top-level `"blocks"` LoroMap
//! whose values are per-block LoroMaps holding scalar fields) can
//! round-trip a `create_block` operation through Loro's import/export.
//!
//! Day-1 scope is intentionally tiny: one op type (create_block), no
//! merging, no concurrent peers, no character-level text.  Everything
//! else (LoroText for `content`, parent_id reparent semantics, the rest
//! of the 12 op variants, parity vs `merge/tests.rs`) lands in later
//! days of the 2-week time-box.

use anyhow::{anyhow, Context, Result};
use loro::{ExportMode, LoroDoc, LoroMap, LoroValue};

/// Top-level LoroMap key holding the per-block sub-maps.
///
/// Mirrors the data shape in PEND-09-crdt-migration.md (lines 17-36):
/// `loro_doc.getMap("blocks")` -> `LoroMap<block_id, BlockData>`.
const BLOCKS_ROOT: &str = "blocks";

// Field keys inside a per-block LoroMap.  Kept as &'static str constants
// so the round-trip read path uses the same key strings the writer used.
const FIELD_BLOCK_TYPE: &str = "block_type";
const FIELD_CONTENT: &str = "content";
const FIELD_PARENT_ID: &str = "parent_id";
const FIELD_POSITION: &str = "position";

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
        block_map
            .insert(FIELD_CONTENT, LoroValue::from(content))
            .with_context(|| format!("create block {block_id}: set content"))?;
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
        let content = read_string(&block_map, FIELD_CONTENT)
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

    /// Export the doc as a self-contained snapshot byte string.  Useful
    /// for size measurement + later round-trip-via-bytes tests.
    pub fn export_snapshot(&self) -> Result<Vec<u8>> {
        self.doc
            .export(ExportMode::Snapshot)
            .map_err(|e| anyhow!("export snapshot: {e}"))
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

fn read_optional_string(map: &LoroMap, key: &str) -> Result<Option<String>> {
    let value = read_value(map, key)?.ok_or_else(|| anyhow!("missing key {key}"))?;
    match value {
        LoroValue::Null => Ok(None),
        LoroValue::String(s) => Ok(Some((*s).clone())),
        other => Err(anyhow!("key {key}: expected String|Null, got {other:?}")),
    }
}

fn read_i64(map: &LoroMap, key: &str) -> Result<i64> {
    let value = read_value(map, key)?.ok_or_else(|| anyhow!("missing key {key}"))?;
    match value {
        LoroValue::I64(n) => Ok(n),
        other => Err(anyhow!("key {key}: expected I64, got {other:?}")),
    }
}
