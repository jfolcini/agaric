//! `LoroEngine` — production-side port of the Phase-0 spike's CRDT
//! engine (originally `crates/loro-spike/src/lib.rs`; the spike crate
//! was archived in Phase-2 day-8 — see git tag `pend-09/spike-archive`).
//!
//! ## What this is
//!
//! The minimum viable wrapper around a `loro::LoroDoc` that supports
//! the six block-tree operations proven during the spike:
//!
//! - `apply_create_block`
//! - `apply_edit_content`
//! - `apply_set_property`
//! - `apply_delete_block` (soft-delete via `deleted_at`)
//! - `apply_move_block` (reparent + position update)
//!
//! Plus the read-back surface needed for shadow-mode parity checks:
//! `read_block`, `read_property`, `read_parent`, `read_position`,
//! `read_deleted`, `count_alive_blocks`, `list_children_walk`.
//!
//! And the sync surface: `export_snapshot` / `import` for round-tripping
//! Loro docs over the wire (Phase 2 / sync wiring) and for
//! parity-test fixtures.
//!
//! ## Differences from the spike crate
//!
//! 1. **Error type.**  The spike uses `anyhow::Result` because it's
//!    throwaway code.  Production maps every fallible call into
//!    [`crate::error::AppError`].  Validation-style failures (block
//!    not found, range out of bounds, container-shape mismatch) use
//!    [`AppError::Validation`].  This matches the convention in
//!    `merge/`, where input rejection paths are `Validation`.
//!
//! 2. **No `apply_*_no_commit` variants.**  Phase-0 day-6 measured
//!    commit cadence and concluded per-op commits are the right
//!    default (see SPIKE-REPORT.md §4.5).  The bulk-import opt-in
//!    will land in a later phase if a specific path needs it.
//!
//! 3. **No `apply_edit_block` (whole-content replace).**  The spike
//!    kept it as a convenience for porting `merge/tests.rs`; the
//!    production materializer can compose `apply_edit_content` from
//!    a known `(start, len, replacement)` tuple, so the helper is
//!    not on the day-1 minimum surface.
//!
//! 4. **Spike's `TreeEngine` not ported.**  Day-5 head-to-head was
//!    decisive — `LoroMap + scalar parent_id` wins on every
//!    measurement (see SPIKE-REPORT.md §4.2).  Phase 1 builds against
//!    one engine.

use loro::{ExportMode, LoroDoc, LoroMap, LoroText, LoroValue, PeerID};

use crate::error::AppError;

/// Map an external `device_id` string (production uses a canonical
/// UUID-v4 — see `src/device.rs:83-99`) into a `loro::PeerID` (`u64`).
///
/// # Stability contract — DO NOT CHANGE WITHOUT A COORDINATED MIGRATION
///
/// The output of this function is load-bearing across **every device,
/// every Rust toolchain version, and every process restart**.  Loro
/// credits operations in its op-log to a `PeerID`; if the hash of a
/// given `device_id` ever changes, that device's already-stored op
/// history would be re-credited to a different peer on its next run,
/// breaking the CRDT's causal-ordering invariants and causing sync
/// chaos with peers that still see the old `PeerID`.
///
/// To preserve that contract:
/// - `xxh3_64` is the chosen algorithm.  It is deterministic (seed
///   defaults to 0), versioned, and follows the official xxHash
///   specification — independent of any future Rust toolchain bump.
///   The previous spike implementation used `std::hash::DefaultHasher`
///   (SipHash-1-3); the stdlib reserves the right to change that
///   algorithm across versions, which this swap eliminates.
/// - The `peer_id_from_device_id_is_stable_against_known_values`
///   regression test below pins the bytes-in / u64-out mapping for a
///   fixed input.  Any change that breaks that test is a wire-format
///   change and requires the team's review (and, post-Phase-2, a real
///   data-migration plan).
///
/// # Collision math
///
/// Birthday-bound for `n` independent draws over a 2^64 space:
/// collision probability ≈ `n² / 2^65`.  For `n = 10_000` devices
/// that's ≈ 2.7e-12; for `n = 1_000_000` devices ≈ 2.7e-8 — well
/// below "ever happens in practice" thresholds.  Loro's documented
/// requirement is "Never reuse the same PeerID across concurrent
/// writers"; the birthday bound is the quantitative case that we won't.
pub fn peer_id_from_device_id(device_id: &str) -> PeerID {
    xxhash_rust::xxh3::xxh3_64(device_id.as_bytes())
}

/// Top-level LoroMap key holding the per-block sub-maps.
///
/// Mirrors the data shape decision in SPIKE-REPORT.md §4.1:
/// `loro_doc.getMap("blocks")` -> `LoroMap<block_id, BlockData>`.
const BLOCKS_ROOT: &str = "blocks";

/// Top-level LoroMap key holding per-block properties.  Each value is
/// a `LoroMap<key, value>` with LWW semantics — overwriting a key on
/// two peers concurrently resolves via Loro's per-key LWW.
const BLOCK_PROPERTIES_ROOT: &str = "block_properties";

// Field keys inside a per-block LoroMap.  Kept as &'static str
// constants so the round-trip read path uses the same key strings
// the writer used.
const FIELD_BLOCK_TYPE: &str = "block_type";
const FIELD_CONTENT: &str = "content";
const FIELD_PARENT_ID: &str = "parent_id";
const FIELD_POSITION: &str = "position";
const FIELD_DELETED_AT: &str = "deleted_at";

/// Read-back projection of a block's state from the Loro doc.
///
/// Sufficient for shadow-mode parity equality checks against the SQL
/// `blocks` row projection.  Phase 1 day-1 keeps this minimal — the
/// full ~10-field Block shape (`archived_at`, `todo_state`, etc.)
/// lives in derived tables and is composed at the materializer
/// boundary, not the engine boundary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlockSnapshot {
    pub block_id: String,
    pub block_type: String,
    pub content: String,
    pub parent_id: Option<String>,
    pub position: i64,
}

/// Production-side wrapper around a `LoroDoc`.  Owns one document per
/// space (per SPIKE-REPORT.md §4.1 — per-space-doc design).
pub struct LoroEngine {
    doc: LoroDoc,
}

impl LoroEngine {
    /// Fresh, empty document.  Loro auto-assigns a random peer id on
    /// first commit; for any path that needs a stable peer id (sync,
    /// op-log replay) use [`LoroEngine::with_peer_id`].
    pub fn new() -> Self {
        Self {
            doc: LoroDoc::new(),
        }
    }

    /// Construct a `LoroEngine` whose Loro peer id is derived
    /// deterministically from the `device_id` string (UUID-v4 in
    /// production — see [`peer_id_from_device_id`]).
    ///
    /// Returns an error rather than panicking on the off-chance
    /// `set_peer_id` rejects the value.  Loro's 1.12 source treats
    /// `set_peer_id` failure on a fresh doc as an internal-invariant
    /// violation (the doc has no ops yet), but we surface it as a
    /// validation error rather than panic so any call-site fault is
    /// reportable cleanly.
    pub fn with_peer_id(device_id: &str) -> Result<Self, AppError> {
        let doc = LoroDoc::new();
        let peer = peer_id_from_device_id(device_id);
        doc.set_peer_id(peer).map_err(|e| {
            AppError::Validation(format!(
                "loro: set_peer_id from device_id {device_id} failed: {e}"
            ))
        })?;
        Ok(Self { doc })
    }

    /// Read back the engine's current Loro peer id.  Useful for
    /// asserting that two engines built from the same `device_id`
    /// landed on the same peer.
    pub fn peer_id(&self) -> PeerID {
        self.doc.peer_id()
    }

    /// Explicit `commit()` flush.  All `apply_*` methods commit
    /// internally per SPIKE-REPORT.md §4.5; this is exposed for
    /// debug/test paths that want to bracket an explicit transaction.
    pub fn commit(&mut self) {
        self.doc.commit();
    }

    /// Insert a block into the doc under the `"blocks"` root LoroMap.
    pub fn apply_create_block(
        &mut self,
        block_id: &str,
        block_type: &str,
        content: &str,
        parent_id: Option<&str>,
        position: i64,
    ) -> Result<(), AppError> {
        let blocks: LoroMap = self.doc.get_map(BLOCKS_ROOT);

        // Each block lives in its own LoroMap nested under `blocks`.
        // `insert_container` returns the *attached* handle — that's
        // the one whose mutations end up in the doc's oplog.
        let block_map: LoroMap =
            blocks
                .insert_container(block_id, LoroMap::new())
                .map_err(|e| {
                    AppError::Validation(format!(
                        "loro: create block {block_id}: insert_container: {e}"
                    ))
                })?;

        block_map
            .insert(FIELD_BLOCK_TYPE, LoroValue::from(block_type))
            .map_err(|e| {
                AppError::Validation(format!(
                    "loro: create block {block_id}: set block_type: {e}"
                ))
            })?;

        // `content` is a LoroText container, not a scalar — that's
        // the headline win of the migration (character-level merge).
        // `LoroText::insert` takes Unicode-scalar offsets per
        // SPIKE-REPORT.md §4.3 / notebook Q10.
        let content_text: LoroText = block_map
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

        let parent_value = match parent_id {
            Some(p) => LoroValue::from(p),
            None => LoroValue::Null,
        };
        block_map
            .insert(FIELD_PARENT_ID, parent_value)
            .map_err(|e| {
                AppError::Validation(format!("loro: create block {block_id}: set parent_id: {e}"))
            })?;
        block_map
            .insert(FIELD_POSITION, LoroValue::from(position))
            .map_err(|e| {
                AppError::Validation(format!("loro: create block {block_id}: set position: {e}"))
            })?;

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
    /// Ported from the spike's `apply_edit_via_diff_splice` (see
    /// the archived `tests/parity_corpus.rs` ~line 100; git tag
    /// `pend-09/spike-archive`).  Production
    /// `EditBlock` ops carry a `to_text` snapshot of the whole new
    /// content (line-granularity diffy diffs the LCA against this
    /// string).  Loro wants character-level splices so two peers'
    /// concurrent edits land at non-overlapping character ranges when
    /// the new_content strings differ at non-overlapping regions —
    /// that's the headline win of the migration.
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
    /// Sets `deleted_at` to a fixed marker; the production caller
    /// re-stamps with the real timestamp at the materializer
    /// boundary.  Concurrent deletes converge on the same "deleted"
    /// state via LWW.
    pub fn apply_delete_block(&mut self, block_id: &str) -> Result<(), AppError> {
        let block_map = self.get_block_map(block_id, "delete block")?;
        block_map
            .insert(FIELD_DELETED_AT, LoroValue::from("2025-01-15T12:00:00Z"))
            .map_err(|e| {
                AppError::Validation(format!(
                    "loro: delete block {block_id}: set deleted_at: {e}"
                ))
            })?;
        self.doc.commit();
        Ok(())
    }

    /// Reparent / re-position a block.  LWW per (block, key) — two
    /// devices reparenting to different parents resolve to the
    /// later-Lamport-ts write, with the loser's intent dropped (per
    /// SPIKE-REPORT.md §4.2 + Q5 — documented expected CRDT semantics).
    pub fn apply_move_block(
        &mut self,
        block_id: &str,
        new_parent_id: Option<&str>,
        new_position: i64,
    ) -> Result<(), AppError> {
        let block_map = self.get_block_map(block_id, "move block")?;
        let parent_value = match new_parent_id {
            Some(p) => LoroValue::from(p),
            None => LoroValue::Null,
        };
        block_map
            .insert(FIELD_PARENT_ID, parent_value)
            .map_err(|e| {
                AppError::Validation(format!("loro: move block {block_id}: set parent_id: {e}"))
            })?;
        block_map
            .insert(FIELD_POSITION, LoroValue::from(new_position))
            .map_err(|e| {
                AppError::Validation(format!("loro: move block {block_id}: set position: {e}"))
            })?;
        self.doc.commit();
        Ok(())
    }

    /// Mirrors `SetProperty` — string values only at this stage,
    /// matching the spike's day-3 corpus port.  Stored under
    /// `block_properties` keyed by block_id then property key.  LWW
    /// per `(block_id, key)`.  `value = None` writes an explicit Null
    /// (clear), distinct from "key absent".
    pub fn apply_set_property(
        &mut self,
        block_id: &str,
        key: &str,
        value: Option<&str>,
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
        let v = match value {
            Some(s) => LoroValue::from(s),
            None => LoroValue::Null,
        };
        block_props.insert(key, v).map_err(|e| {
            AppError::Validation(format!(
                "loro: set_property block {block_id} key {key}: {e}"
            ))
        })?;
        self.doc.commit();
        Ok(())
    }

    /// Read a block back from the doc.  Returns `Ok(None)` when the
    /// block_id is absent.  Returns `Err(AppError::Validation)` when
    /// a key is present but its value has the wrong shape (writer /
    /// reader mismatch — should fail loudly).
    pub fn read_block(&self, block_id: &str) -> Result<Option<BlockSnapshot>, AppError> {
        let blocks: LoroMap = self.doc.get_map(BLOCKS_ROOT);
        let Some(block_value) = blocks.get(block_id) else {
            return Ok(None);
        };

        let container = block_value.into_container().map_err(|_| {
            AppError::Validation(format!("loro: block {block_id} value is not a container"))
        })?;
        let block_map: LoroMap = container.into_map().map_err(|_| {
            AppError::Validation(format!("loro: block {block_id} container is not a LoroMap"))
        })?;

        let block_type = read_string(&block_map, FIELD_BLOCK_TYPE)
            .map_err(|e| ctx_err(&e, &format!("block {block_id}: block_type")))?;
        let content = read_text(&block_map, FIELD_CONTENT)
            .map_err(|e| ctx_err(&e, &format!("block {block_id}: content")))?;
        let parent_id = read_optional_string(&block_map, FIELD_PARENT_ID)
            .map_err(|e| ctx_err(&e, &format!("block {block_id}: parent_id")))?;
        let position = read_i64(&block_map, FIELD_POSITION)
            .map_err(|e| ctx_err(&e, &format!("block {block_id}: position")))?;

        Ok(Some(BlockSnapshot {
            block_id: block_id.to_string(),
            block_type,
            content,
            parent_id,
            position,
        }))
    }

    /// Read a property back; returns `Ok(None)` for an unset key (no
    /// entry in the map) and `Ok(Some(None))` for an explicit-null
    /// clear.  Production property reads go through SQL; this exists
    /// for parity-checking and debug paths.
    pub fn read_property(
        &self,
        block_id: &str,
        key: &str,
    ) -> Result<Option<Option<String>>, AppError> {
        let props_root: LoroMap = self.doc.get_map(BLOCK_PROPERTIES_ROOT);
        let Some(voc) = props_root.get(block_id) else {
            return Ok(None);
        };
        let block_props: LoroMap = voc
            .into_container()
            .map_err(|_| {
                AppError::Validation(format!(
                    "loro: read_property block {block_id} props slot is not a container"
                ))
            })?
            .into_map()
            .map_err(|_| {
                AppError::Validation(format!(
                    "loro: read_property block {block_id} props is not a LoroMap"
                ))
            })?;
        let Some(value_voc) = block_props.get(key) else {
            return Ok(None);
        };
        let value = value_voc.into_value().map_err(|_| {
            AppError::Validation(format!(
                "loro: read_property {block_id}/{key} expected scalar"
            ))
        })?;
        match value {
            LoroValue::Null => Ok(Some(None)),
            LoroValue::String(s) => Ok(Some(Some((*s).clone()))),
            other => Err(AppError::Validation(format!(
                "loro: read_property {block_id}/{key} expected String|Null, got {other:?}"
            ))),
        }
    }

    /// Read the current parent_id scalar of a block.  Returns
    /// `Ok(None)` if the slot is null, `Err` if the block is missing.
    pub fn read_parent(&self, block_id: &str) -> Result<Option<String>, AppError> {
        let block_map = self.get_block_map(block_id, "read parent")?;
        read_optional_string(&block_map, FIELD_PARENT_ID)
    }

    /// Read the current position scalar.
    pub fn read_position(&self, block_id: &str) -> Result<i64, AppError> {
        let block_map = self.get_block_map(block_id, "read position")?;
        read_i64(&block_map, FIELD_POSITION)
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

    /// Walk the top-level `blocks` LoroMap and collect every block_id
    /// whose `parent_id` field equals `parent_id` AND whose
    /// `deleted_at` is unset (or explicitly null).  O(N_blocks) per
    /// call.
    ///
    /// Phase-0 day-7 measured this as ~250-2500x slower than indexed
    /// SQL (SPIKE-REPORT.md §4.4) — that's why production reads
    /// continue to flow through the SQL `blocks` table.  This call
    /// exists for parity tests and debug paths only; it must not
    /// land on a hot read path.
    pub fn list_children_walk(&self, parent_id: &str) -> Result<Vec<String>, AppError> {
        let blocks: LoroMap = self.doc.get_map(BLOCKS_ROOT);
        let mut out: Vec<String> = Vec::new();
        let mut err: Option<AppError> = None;
        blocks.for_each(|key, voc| {
            if err.is_some() {
                return;
            }
            let container = match voc.into_container() {
                Ok(c) => c,
                Err(_) => {
                    err = Some(AppError::Validation(format!(
                        "loro: list_children_walk block {key} value is not a container"
                    )));
                    return;
                }
            };
            let block_map: LoroMap = match container.into_map() {
                Ok(m) => m,
                Err(_) => {
                    err = Some(AppError::Validation(format!(
                        "loro: list_children_walk block {key} container is not a LoroMap"
                    )));
                    return;
                }
            };
            let deleted = match block_map.get(FIELD_DELETED_AT) {
                None => false,
                Some(field_voc) => match field_voc.into_value() {
                    Ok(LoroValue::Null) => false,
                    Ok(_) => true,
                    Err(_) => {
                        err = Some(AppError::Validation(format!(
                            "loro: list_children_walk block {key} deleted_at is not a scalar"
                        )));
                        return;
                    }
                },
            };
            if deleted {
                return;
            }
            let matches_parent = match block_map.get(FIELD_PARENT_ID) {
                None => false,
                Some(field_voc) => match field_voc.into_value() {
                    Ok(LoroValue::Null) => false,
                    Ok(LoroValue::String(s)) => s.as_str() == parent_id,
                    Ok(_) => false,
                    Err(_) => {
                        err = Some(AppError::Validation(format!(
                            "loro: list_children_walk block {key} parent_id is not a scalar"
                        )));
                        return;
                    }
                },
            };
            if matches_parent {
                out.push(key.to_string());
            }
        });
        if let Some(e) = err {
            return Err(e);
        }
        Ok(out)
    }

    /// Count blocks whose `deleted_at` slot is absent or `Null` —
    /// i.e. blocks that have NOT been soft-deleted.  Used by
    /// debug/audit paths and by parity checks; not a hot-path read.
    pub fn count_alive_blocks(&self) -> Result<usize, AppError> {
        let blocks: LoroMap = self.doc.get_map(BLOCKS_ROOT);
        let mut alive = 0usize;
        let mut err: Option<AppError> = None;
        blocks.for_each(|key, voc| {
            if err.is_some() {
                return;
            }
            let container = match voc.into_container() {
                Ok(c) => c,
                Err(_) => {
                    err = Some(AppError::Validation(format!(
                        "loro: count_alive block {key} value is not a container"
                    )));
                    return;
                }
            };
            let block_map: LoroMap = match container.into_map() {
                Ok(m) => m,
                Err(_) => {
                    err = Some(AppError::Validation(format!(
                        "loro: count_alive block {key} container is not a LoroMap"
                    )));
                    return;
                }
            };
            let deleted = match block_map.get(FIELD_DELETED_AT) {
                None => false,
                Some(field_voc) => match field_voc.into_value() {
                    Ok(LoroValue::Null) => false,
                    Ok(_) => true,
                    Err(_) => {
                        err = Some(AppError::Validation(format!(
                            "loro: count_alive block {key} deleted_at is not a scalar"
                        )));
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
    /// uniform error-context prefix so each caller doesn't repeat
    /// the boilerplate.
    fn get_block_map(&self, block_id: &str, ctx: &str) -> Result<LoroMap, AppError> {
        let blocks: LoroMap = self.doc.get_map(BLOCKS_ROOT);
        let block_value = blocks.get(block_id).ok_or_else(|| {
            AppError::Validation(format!("loro: {ctx}: block {block_id} not found"))
        })?;
        block_value
            .into_container()
            .map_err(|_| {
                AppError::Validation(format!(
                    "loro: {ctx}: block {block_id} value is not a container"
                ))
            })?
            .into_map()
            .map_err(|_| {
                AppError::Validation(format!(
                    "loro: {ctx}: block {block_id} container is not a LoroMap"
                ))
            })
    }

    /// Export the doc as a self-contained snapshot byte string.
    /// Phase 1 wires this into the `loro_batch` op-log payload (item
    /// 4 on the SPIKE-REPORT.md readiness checklist).
    pub fn export_snapshot(&self) -> Result<Vec<u8>, AppError> {
        self.doc
            .export(ExportMode::Snapshot)
            .map_err(|e| AppError::Validation(format!("loro: export snapshot: {e}")))
    }

    /// Import bytes previously produced by `export_snapshot` (or any
    /// other Loro export mode) into this doc.
    pub fn import(&mut self, bytes: &[u8]) -> Result<(), AppError> {
        self.doc
            .import(bytes)
            .map(|_status| ())
            .map_err(|e| AppError::Validation(format!("loro: import: {e}")))
    }
}

impl Default for LoroEngine {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Read helpers — extract a typed scalar from a nested LoroMap value
// slot.  Loro returns `Option<ValueOrContainer>`; we unwrap the inner
// LoroValue and then narrow it.  These return `AppError::Validation`
// for any shape-mismatch (writer / reader drift).
// ---------------------------------------------------------------------------

fn ctx_err(inner: &AppError, ctx: &str) -> AppError {
    AppError::Validation(format!("loro: {ctx}: {inner}"))
}

fn read_value(map: &LoroMap, key: &str) -> Result<Option<LoroValue>, AppError> {
    let Some(voc) = map.get(key) else {
        return Ok(None);
    };
    let value = voc.into_value().map_err(|_| {
        AppError::Validation(format!("loro: expected scalar at key {key}, got container"))
    })?;
    Ok(Some(value))
}

fn read_string(map: &LoroMap, key: &str) -> Result<String, AppError> {
    let value = read_value(map, key)?
        .ok_or_else(|| AppError::Validation(format!("loro: missing key {key}")))?;
    match value {
        LoroValue::String(s) => Ok((*s).clone()),
        other => Err(AppError::Validation(format!(
            "loro: key {key}: expected String, got {other:?}"
        ))),
    }
}

fn read_text(map: &LoroMap, key: &str) -> Result<String, AppError> {
    let voc = map
        .get(key)
        .ok_or_else(|| AppError::Validation(format!("loro: missing key {key}")))?;
    let container = voc.into_container().map_err(|_| {
        AppError::Validation(format!("loro: key {key}: expected container, got scalar"))
    })?;
    let text: LoroText = container.into_text().map_err(|_| {
        AppError::Validation(format!(
            "loro: key {key}: expected LoroText, got other container"
        ))
    })?;
    Ok(text.to_string())
}

fn read_optional_string(map: &LoroMap, key: &str) -> Result<Option<String>, AppError> {
    let value = read_value(map, key)?
        .ok_or_else(|| AppError::Validation(format!("loro: missing key {key}")))?;
    match value {
        LoroValue::Null => Ok(None),
        LoroValue::String(s) => Ok(Some((*s).clone())),
        other => Err(AppError::Validation(format!(
            "loro: key {key}: expected String|Null, got {other:?}"
        ))),
    }
}

fn block_map_get_text(
    block_map: &LoroMap,
    field: &str,
    block_id: &str,
    ctx: &str,
) -> Result<LoroText, AppError> {
    let value = block_map.get(field).ok_or_else(|| {
        AppError::Validation(format!(
            "loro: {ctx}: block {block_id} has no {field} field"
        ))
    })?;
    value
        .into_container()
        .map_err(|_| {
            AppError::Validation(format!(
                "loro: {ctx}: block {block_id} {field} slot is not a container"
            ))
        })?
        .into_text()
        .map_err(|_| {
            AppError::Validation(format!(
                "loro: {ctx}: block {block_id} {field} is not a LoroText"
            ))
        })
}

fn read_i64(map: &LoroMap, key: &str) -> Result<i64, AppError> {
    let value = read_value(map, key)?
        .ok_or_else(|| AppError::Validation(format!("loro: missing key {key}")))?;
    match value {
        LoroValue::I64(n) => Ok(n),
        other => Err(AppError::Validation(format!(
            "loro: key {key}: expected I64, got {other:?}"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::peer_id_from_device_id;

    #[test]
    fn peer_id_from_device_id_is_deterministic() {
        // Same input → same output, repeatedly, within a single run.
        // Combined with `xxh3_64`'s spec-pinned algorithm (see the
        // function's stability-contract docstring) this also implies
        // determinism across runs / Rust toolchains.
        assert_eq!(
            peer_id_from_device_id("DEV-A"),
            peer_id_from_device_id("DEV-A")
        );
        assert_ne!(
            peer_id_from_device_id("DEV-A"),
            peer_id_from_device_id("DEV-B")
        );
    }

    #[test]
    fn peer_id_from_device_id_is_stable_against_known_values() {
        // Locks the bytes-in / u64-out mapping against accidental
        // hash-function changes (e.g. a future `xxhash-rust` upgrade
        // that silently re-tunes `xxh3_64`, or someone swapping the
        // algorithm without realising the wire-format consequences
        // documented on `peer_id_from_device_id`).
        //
        // Updating this test value is a coordinated-migration event
        // — every existing device's stored op history is credited to
        // the OLD peer id, so changing the function changes the
        // identity of every existing peer.  Do NOT update this
        // expected value without a team review and a documented
        // migration plan.
        //
        // Fixed input — a representative ULID, matching the shape of
        // production `device_id` UUID-v4 strings.  The expected
        // u64 is the pre-computed `xxh3_64` of that input's bytes
        // (seed = 0, the library's default).
        assert_eq!(
            peer_id_from_device_id("01ARZ3NDEKTSV4RRFFQ69G5FAV"),
            0x11e7_9683_b730_ff1f_u64,
        );
    }
}
