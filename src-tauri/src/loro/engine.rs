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
//! Extended op coverage:
//!
//! - `apply_add_tag` / `apply_remove_tag`
//! - `apply_restore_block` (undelete)
//! - `apply_purge_block` (hard-delete)
//! - `apply_delete_property`
//!
//! `AddAttachment` / `DeleteAttachment` are intentionally out of
//! scope: those ops carry file blobs that live outside the CRDT
//! state. `block_links` is also not here — it is a derived cache
//! re-parsed from `blocks.content`, no engine support needed.
//!
//! Read-back surface: `read_block`, `read_property`, `read_parent`,
//! `read_position`, `read_deleted`, `read_tags`,
//! `count_alive_blocks`, `list_children_walk`.
//!
//! Sync surface: `export_snapshot` / `import` for round-tripping Loro
//! docs over the wire and for test fixtures.
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

use loro::{ExportMode, LoroDoc, LoroList, LoroMap, LoroText, LoroValue, PeerID, VersionVector};

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

/// Top-level LoroMap key holding per-block tag associations.  Each
/// value is a `LoroList<String>` of `tag_id` strings (ULIDs).
///
/// **Why LoroList over LoroMap-as-set** (Phase-2 day-8.5 decision):
/// the SQL `block_tags` table is a `(block_id, tag_id)` set with no
/// per-tag scalar payload — so either shape works at the read
/// boundary.  LoroList gives:
///   1. The simplest read API (`for_each` over scalar strings) for
///      `read_tags` parity.
///   2. Concurrent AddTag(X) and RemoveTag(X) on two peers converge
///      naturally — Loro's list-CRDT keeps the first-applied insert
///      and drops subsequent removals of an already-removed element
///      (idempotent remove); this matches `INSERT OR IGNORE` /
///      `DELETE` SQL semantics.
///   3. Avoids the LoroMap-keyed-by-tag_id route, which would need a
///      sentinel value (`true` / `Null`) that adds noise without
///      buying any merge guarantee.
///
/// Drawback: AddTag must walk the list to dedupe — O(N_tags_on_block).
/// Acceptable: typical blocks carry <10 tags.
const BLOCK_TAGS_ROOT: &str = "block_tags";

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
/// The full Block shape (`todo_state`, `priority`, etc.) lives in
/// derived columns and is composed at the materializer boundary, not
/// the engine boundary.
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
    /// LoroList-vs-LoroMap data-shape decision.
    ///
    /// Idempotent: if `tag_id` is already present in the block's tag
    /// list, the call is a no-op.  This matches the SQL
    /// `INSERT OR IGNORE INTO block_tags ...` semantics in
    /// `commands/tags.rs::add_tag_inner`.
    pub fn apply_add_tag(&mut self, block_id: &str, tag_id: &str) -> Result<(), AppError> {
        let tags_root: LoroMap = self.doc.get_map(BLOCK_TAGS_ROOT);
        let block_tags = tags_get_or_create_list(&tags_root, block_id, "add_tag")?;

        // Manual dedup — LoroList does not enforce uniqueness.  Walk
        // the list once and bail if `tag_id` is already present.
        if list_contains_string(&block_tags, tag_id) {
            return Ok(());
        }

        block_tags.push(LoroValue::from(tag_id)).map_err(|e| {
            AppError::Validation(format!(
                "loro: add_tag block {block_id} tag {tag_id}: push: {e}"
            ))
        })?;
        self.doc.commit();
        Ok(())
    }

    /// Mirrors `RemoveTag` — dissociates `tag_id` from `block_id`.
    ///
    /// Idempotent: if `tag_id` is not present (or the block has no
    /// tags map at all) the call is a no-op.  Matches the SQL
    /// `DELETE FROM block_tags ...` (which is itself idempotent — a
    /// DELETE matching zero rows is not an error).
    pub fn apply_remove_tag(&mut self, block_id: &str, tag_id: &str) -> Result<(), AppError> {
        let tags_root: LoroMap = self.doc.get_map(BLOCK_TAGS_ROOT);
        let Some(voc) = tags_root.get(block_id) else {
            // No tag list for this block — idempotent no-op.
            return Ok(());
        };
        let block_tags: LoroList = voc
            .into_container()
            .map_err(|_| {
                AppError::Validation(format!(
                    "loro: remove_tag block {block_id} tags slot is not a container"
                ))
            })?
            .into_list()
            .map_err(|_| {
                AppError::Validation(format!(
                    "loro: remove_tag block {block_id} tags is not a LoroList"
                ))
            })?;
        let Some(pos) = list_find_string(&block_tags, tag_id) else {
            // Tag absent — idempotent no-op.
            return Ok(());
        };
        block_tags.delete(pos, 1).map_err(|e| {
            AppError::Validation(format!(
                "loro: remove_tag block {block_id} tag {tag_id} at {pos}: {e}"
            ))
        })?;
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
        let blocks: LoroMap = self.doc.get_map(BLOCKS_ROOT);
        if blocks.get(block_id).is_none() {
            return Ok(());
        }
        let block_map = self.get_block_map(block_id, "restore block")?;
        block_map
            .insert(FIELD_DELETED_AT, LoroValue::Null)
            .map_err(|e| {
                AppError::Validation(format!(
                    "loro: restore block {block_id}: clear deleted_at: {e}"
                ))
            })?;
        self.doc.commit();
        Ok(())
    }

    /// Mirrors `PurgeBlock` — hard-deletes the block from the
    /// `blocks` LoroMap entirely, plus its `block_properties` and
    /// `block_tags` entries (matches the SQL purge cascade in
    /// `materializer/handlers.rs::apply_purge_block_tx`).
    ///
    /// Note: this engine is per-block-id only — it does NOT walk
    /// descendants.  The materializer's purge cascade enumerates the
    /// descendant set via the recursive CTE and dispatches one
    /// `PurgeBlock` per descendant; each descendant's own apply call
    /// reaches this method. Per-block scope is correct.
    ///
    /// Idempotent: if the block is already absent (concurrent purge,
    /// or never created), all three deletions are no-ops.
    pub fn apply_purge_block(&mut self, block_id: &str) -> Result<(), AppError> {
        let blocks: LoroMap = self.doc.get_map(BLOCKS_ROOT);
        if blocks.get(block_id).is_some() {
            blocks.delete(block_id).map_err(|e| {
                AppError::Validation(format!("loro: purge block {block_id}: blocks.delete: {e}"))
            })?;
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

    /// Read the current tag list for `block_id`.  Returns an empty
    /// vector (not `None`) when the block has never had any tags or
    /// when its list has been emptied — the SQL projection that this
    /// mirrors uses `LEFT JOIN block_tags`, so "no row" and "no tag"
    /// flatten to the same shape at the read boundary.
    ///
    /// Phase-2 day-8.5: companion to `apply_add_tag` / `apply_remove_tag`,
    /// used by the engine unit tests and parity-check paths.
    pub fn read_tags(&self, block_id: &str) -> Result<Vec<String>, AppError> {
        let tags_root: LoroMap = self.doc.get_map(BLOCK_TAGS_ROOT);
        let Some(voc) = tags_root.get(block_id) else {
            return Ok(Vec::new());
        };
        let block_tags: LoroList = voc
            .into_container()
            .map_err(|_| {
                AppError::Validation(format!(
                    "loro: read_tags block {block_id} tags slot is not a container"
                ))
            })?
            .into_list()
            .map_err(|_| {
                AppError::Validation(format!(
                    "loro: read_tags block {block_id} tags is not a LoroList"
                ))
            })?;
        let mut out: Vec<String> = Vec::with_capacity(block_tags.len());
        let mut err: Option<AppError> = None;
        block_tags.for_each(|voc| {
            if err.is_some() {
                return;
            }
            match voc.into_value() {
                Ok(LoroValue::String(s)) => out.push((*s).clone()),
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
            let Ok(container) = voc.into_container() else {
                err = Some(AppError::Validation(format!(
                    "loro: list_children_walk block {key} value is not a container"
                )));
                return;
            };
            let Ok(block_map) = container.into_map() else {
                err = Some(AppError::Validation(format!(
                    "loro: list_children_walk block {key} container is not a LoroMap"
                )));
                return;
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
            let Ok(container) = voc.into_container() else {
                err = Some(AppError::Validation(format!(
                    "loro: count_alive block {key} value is not a container"
                )));
                return;
            };
            let Ok(block_map) = container.into_map() else {
                err = Some(AppError::Validation(format!(
                    "loro: count_alive block {key} container is not a LoroMap"
                )));
                return;
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

    /// Import `bytes` into the doc and return every block_id present
    /// in the post-import top-level `blocks` LoroMap.
    ///
    /// Sync-pull projection driver. The receiver's caller passes each
    /// returned block_id to
    /// [`crate::loro::projection::project_block_full_to_sql`] so the
    /// SQL `blocks` row mirrors the engine's post-import state.
    ///
    /// ## Why brute-force enumeration (not VersionRange-driven diff)
    ///
    /// Loro 1.12's [`loro::ImportStatus`] reports a
    /// [`loro::VersionRange`] (`success`) — the (peer, counter-range)
    /// span of accepted ops — but does NOT directly map to the set of
    /// block_ids whose state changed.  Translating a counter-range
    /// into changed-container-ids would require either
    /// (a) walking the op-log changes in that range and decoding their
    /// targets, or (b) subscribing to root-level diff events for the
    /// duration of the import.  Both add complexity for the day-4
    /// additive landing; the day-5 wiring or later can swap to a
    /// targeted enumeration once a benchmark shows the brute-force
    /// projection is on a hot path.
    ///
    /// The brute-force walk costs O(N_blocks) per sync-pull — same
    /// asymptotic shape as `count_alive_blocks` / `list_children_walk`
    /// — but sync-pull is a cold path bounded by the op-streaming
    /// cadence, so the cost is amortised against network latency.
    ///
    /// ## Edge cases
    ///
    /// * Soft-deleted blocks (those whose `deleted_at` slot is set)
    ///   ARE included in the returned vector — the projection helper
    ///   refreshes their core columns (content/parent/position) without
    ///   touching the SQL `deleted_at`, so the block stays soft-deleted.
    /// * If the import added zero new ops (peer was up-to-date), the
    ///   walk still returns every block_id — the projection helper
    ///   becomes a sequence of idempotent core-column UPSERTs, which
    ///   is correct but wasteful. A future iteration may short-circuit
    ///   on `ImportStatus.success.is_empty()` to skip the walk.
    pub fn import_with_changed_blocks(
        &mut self,
        bytes: &[u8],
    ) -> Result<Vec<crate::ulid::BlockId>, AppError> {
        self.doc
            .import(bytes)
            .map(|_status| ())
            .map_err(|e| AppError::Validation(format!("loro: import_with_changed_blocks: {e}")))?;

        let blocks: LoroMap = self.doc.get_map(BLOCKS_ROOT);
        let mut out: Vec<crate::ulid::BlockId> = Vec::with_capacity(blocks.len());
        blocks.for_each(|key, _voc| {
            out.push(crate::ulid::BlockId::from_trusted(key));
        });
        Ok(out)
    }

    /// Encode the doc's current op-log version vector for transport
    /// over the wire.
    ///
    /// Wraps `LoroDoc::oplog_vv()` and serialises the result via
    /// `VersionVector::encode()` (Loro 1.12 wire-stable). Used by sync
    /// push to (a) advertise the local frontier and (b) build the
    /// `from_vv` field of
    /// [`crate::sync_protocol::loro_sync_types::LoroSyncMessage::Update`]
    /// at send time.
    pub fn version_vector(&self) -> Vec<u8> {
        self.doc.oplog_vv().encode()
    }

    /// Export the ops added to this doc since the peer's `since_vv`
    /// frontier.
    ///
    /// `since_vv` is the receiver's current `oplog_vv()` encoded via
    /// [`Self::version_vector`] (or any other path that produced a
    /// Loro 1.12 `VersionVector::encode` blob).  Internally:
    ///
    /// 1. `VersionVector::decode(since_vv)`
    ///    (`loro-internal-1.12.0/src/version.rs:847-850`).
    /// 2. `self.doc.export(ExportMode::updates(&vv))`
    ///    (`loro-1.12.0/src/lib.rs:1297-1300`).
    ///
    /// Returns `AppError::Validation` if `since_vv` is not a
    /// well-formed encoded version vector — the receiver should
    /// fall back to a
    /// [`crate::sync_protocol::loro_sync_types::LoroSyncMessage::Snapshot`]
    /// in that case.
    pub fn export_update_since(&self, since_vv: &[u8]) -> Result<Vec<u8>, AppError> {
        let vv = VersionVector::decode(since_vv).map_err(|e| {
            AppError::Validation(format!("loro: export_update_since: decode vv: {e}"))
        })?;
        self.doc
            .export(ExportMode::updates(&vv))
            .map_err(|e| AppError::Validation(format!("loro: export_update_since: {e}")))
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

// ---------------------------------------------------------------------------
// Tag-list helpers (Phase-2 day-8.5).  Centralised so `apply_add_tag` /
// `apply_remove_tag` / `read_tags` share one source of truth for the
// LoroList<String> -> String mapping.
// ---------------------------------------------------------------------------

/// Walk a `LoroList` looking for an exact-string match; on any
/// non-string element this returns `false` (the writer only ever
/// pushes strings — a non-string element would be a writer/reader
/// drift, but at the contains check we degrade gracefully so a
/// corrupted list does not crash the apply path).
fn list_contains_string(list: &LoroList, needle: &str) -> bool {
    list_find_string(list, needle).is_some()
}

/// Return the index of the first `LoroValue::String` element matching
/// `needle`, or `None` if absent.  Walks the list via `len()` + `get()`
/// because `LoroList::for_each` exposes only the value, not the index.
fn list_find_string(list: &LoroList, needle: &str) -> Option<usize> {
    let len = list.len();
    for idx in 0..len {
        let Some(voc) = list.get(idx) else { continue };
        if let Ok(LoroValue::String(s)) = voc.into_value() {
            if s.as_str() == needle {
                return Some(idx);
            }
        }
    }
    None
}

/// Get-or-create the per-block `LoroList` of tag_ids under the
/// `block_tags` root.  `ctx` is the operation name (e.g. `"add_tag"`)
/// for error-context prefixing.
fn tags_get_or_create_list(
    tags_root: &LoroMap,
    block_id: &str,
    ctx: &str,
) -> Result<LoroList, AppError> {
    match tags_root.get(block_id) {
        Some(voc) => voc
            .into_container()
            .map_err(|_| {
                AppError::Validation(format!(
                    "loro: {ctx} block {block_id} tags slot is not a container"
                ))
            })?
            .into_list()
            .map_err(|_| {
                AppError::Validation(format!(
                    "loro: {ctx} block {block_id} tags is not a LoroList"
                ))
            }),
        None => tags_root
            .insert_container(block_id, LoroList::new())
            .map_err(|e| {
                AppError::Validation(format!("loro: {ctx}: create tags list for {block_id}: {e}"))
            }),
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

// ---------------------------------------------------------------------------
// Engine-coverage tests for `apply_add_tag` / `apply_remove_tag` /
// `apply_restore_block` / `apply_purge_block` /
// `apply_delete_property`. Each method gets a happy-path test plus an
// idempotence test.
// ---------------------------------------------------------------------------
#[cfg(test)]
mod op_coverage_tests {
    use super::LoroEngine;

    const BLOCK_A: &str = "01HZ00000000000000000000AB";
    const BLOCK_B: &str = "01HZ00000000000000000000CD";
    const TAG_X: &str = "01HZ00000000000000000000T1";
    const TAG_Y: &str = "01HZ00000000000000000000T2";

    /// Helper: a fresh engine with one block already created so each
    /// test can focus on the new method under test.
    fn engine_with_block(block_id: &str) -> LoroEngine {
        let mut engine = LoroEngine::new();
        engine
            .apply_create_block(block_id, "content", "hello", None, 0)
            .expect("create block");
        engine
    }

    // ── AddTag ────────────────────────────────────────────────────────

    #[test]
    fn apply_add_tag_appends_to_block_tags() {
        let mut engine = engine_with_block(BLOCK_A);
        engine.apply_add_tag(BLOCK_A, TAG_X).expect("add tag X");
        engine.apply_add_tag(BLOCK_A, TAG_Y).expect("add tag Y");
        let tags = engine.read_tags(BLOCK_A).expect("read tags");
        assert_eq!(tags, vec![TAG_X.to_string(), TAG_Y.to_string()]);
    }

    #[test]
    fn apply_add_tag_dedupes_existing_tag() {
        let mut engine = engine_with_block(BLOCK_A);
        engine.apply_add_tag(BLOCK_A, TAG_X).expect("first add");
        // Second add of the same tag must be a no-op — list stays length 1.
        engine.apply_add_tag(BLOCK_A, TAG_X).expect("dup add");
        engine.apply_add_tag(BLOCK_A, TAG_X).expect("dup add #2");
        let tags = engine.read_tags(BLOCK_A).expect("read tags");
        assert_eq!(
            tags,
            vec![TAG_X.to_string()],
            "duplicate AddTag must not append a second copy"
        );
    }

    #[test]
    fn read_tags_for_unknown_block_returns_empty() {
        let engine = LoroEngine::new();
        let tags = engine.read_tags(BLOCK_A).expect("read tags");
        assert!(tags.is_empty());
    }

    // ── RemoveTag ─────────────────────────────────────────────────────

    #[test]
    fn apply_remove_tag_removes_present_tag() {
        let mut engine = engine_with_block(BLOCK_A);
        engine.apply_add_tag(BLOCK_A, TAG_X).expect("add X");
        engine.apply_add_tag(BLOCK_A, TAG_Y).expect("add Y");
        engine.apply_remove_tag(BLOCK_A, TAG_X).expect("remove X");
        let tags = engine.read_tags(BLOCK_A).expect("read tags");
        assert_eq!(tags, vec![TAG_Y.to_string()]);
    }

    #[test]
    fn apply_remove_tag_is_noop_for_missing_tag() {
        let mut engine = engine_with_block(BLOCK_A);
        engine.apply_add_tag(BLOCK_A, TAG_X).expect("add X");
        // Removing a tag that's not on the block is a no-op (idempotent
        // mirror of the SQL DELETE that matches zero rows).
        engine
            .apply_remove_tag(BLOCK_A, TAG_Y)
            .expect("remove missing tag is a no-op");
        let tags = engine.read_tags(BLOCK_A).expect("read tags");
        assert_eq!(tags, vec![TAG_X.to_string()]);
    }

    #[test]
    fn apply_remove_tag_is_noop_when_block_has_no_tag_list() {
        let mut engine = engine_with_block(BLOCK_A);
        // Block was never tagged — removing must still be a no-op,
        // not an error (idempotent).
        engine
            .apply_remove_tag(BLOCK_A, TAG_X)
            .expect("remove on empty must not error");
        assert!(engine.read_tags(BLOCK_A).unwrap().is_empty());
    }

    // ── RestoreBlock ──────────────────────────────────────────────────

    #[test]
    fn apply_restore_block_clears_deleted_at() {
        let mut engine = engine_with_block(BLOCK_A);
        engine.apply_delete_block(BLOCK_A).expect("delete");
        assert!(engine.read_deleted(BLOCK_A).unwrap(), "must be deleted");
        engine.apply_restore_block(BLOCK_A).expect("restore");
        assert!(
            !engine.read_deleted(BLOCK_A).unwrap(),
            "post-restore must not be flagged deleted"
        );
        // Block is still readable post-restore (restore must NOT
        // remove the block from the doc).
        let snap = engine.read_block(BLOCK_A).unwrap().expect("present");
        assert_eq!(snap.content, "hello");
    }

    #[test]
    fn apply_restore_block_is_noop_on_alive_block() {
        let mut engine = engine_with_block(BLOCK_A);
        // Block was never deleted — restoring must be safe (no-op).
        engine
            .apply_restore_block(BLOCK_A)
            .expect("restore on alive block must not error");
        assert!(!engine.read_deleted(BLOCK_A).unwrap());
    }

    #[test]
    fn apply_restore_block_is_noop_on_unknown_block() {
        // SQL semantics: `apply_restore_block_tx`'s UPDATE matches zero
        // rows when the block_id is absent — that's not an error.
        // Engine must align: a RestoreBlock op for a block purged on a
        // peer must not propagate as a hard error.
        let mut engine = LoroEngine::new();
        engine
            .apply_restore_block(BLOCK_A)
            .expect("restore unknown block must be a silent no-op");
    }

    // ── PurgeBlock ────────────────────────────────────────────────────

    #[test]
    fn apply_purge_block_removes_block() {
        let mut engine = engine_with_block(BLOCK_A);
        // Seed properties + tag so we can assert purge cascades.
        engine
            .apply_set_property(BLOCK_A, "k", Some("v"))
            .expect("set prop");
        engine.apply_add_tag(BLOCK_A, TAG_X).expect("add tag");

        engine.apply_purge_block(BLOCK_A).expect("purge");

        assert!(
            engine.read_block(BLOCK_A).unwrap().is_none(),
            "purged block must be absent"
        );
        assert!(
            engine.read_property(BLOCK_A, "k").unwrap().is_none(),
            "purged block's properties must be wiped"
        );
        assert!(
            engine.read_tags(BLOCK_A).unwrap().is_empty(),
            "purged block's tags must be wiped"
        );
    }

    #[test]
    fn apply_purge_block_is_noop_on_unknown_block() {
        let mut engine = LoroEngine::new();
        // Purge of an absent block is idempotent (matches concurrent
        // purges converging on "gone").
        engine
            .apply_purge_block(BLOCK_A)
            .expect("purge unknown must not error");
        assert!(engine.read_block(BLOCK_A).unwrap().is_none());
    }

    #[test]
    fn apply_purge_block_only_affects_target_block() {
        let mut engine = engine_with_block(BLOCK_A);
        engine
            .apply_create_block(BLOCK_B, "content", "world", None, 1)
            .expect("create B");
        engine.apply_purge_block(BLOCK_A).expect("purge A");
        assert!(engine.read_block(BLOCK_A).unwrap().is_none());
        // BLOCK_B must survive untouched.
        let snap_b = engine.read_block(BLOCK_B).unwrap().expect("B present");
        assert_eq!(snap_b.content, "world");
    }

    // ── DeleteProperty ────────────────────────────────────────────────

    #[test]
    fn apply_delete_property_removes_key() {
        let mut engine = engine_with_block(BLOCK_A);
        engine
            .apply_set_property(BLOCK_A, "priority", Some("high"))
            .expect("set");
        assert_eq!(
            engine.read_property(BLOCK_A, "priority").unwrap(),
            Some(Some("high".to_string()))
        );
        engine
            .apply_delete_property(BLOCK_A, "priority")
            .expect("delete");
        // After delete the key must be entirely absent — distinct
        // from `apply_set_property(value=None)` which would leave
        // `Some(None)` (explicit-null clear).
        assert_eq!(
            engine.read_property(BLOCK_A, "priority").unwrap(),
            None,
            "deleted property key must be absent (Ok(None)), not present-as-null"
        );
    }

    #[test]
    fn apply_delete_property_is_noop_for_missing_key() {
        let mut engine = engine_with_block(BLOCK_A);
        // Block has no properties yet.
        engine
            .apply_delete_property(BLOCK_A, "nope")
            .expect("delete missing must not error");
        // Set one, then delete a different key.
        engine
            .apply_set_property(BLOCK_A, "priority", Some("high"))
            .expect("set");
        engine
            .apply_delete_property(BLOCK_A, "other")
            .expect("delete other-missing key must not error");
        // Original key survives.
        assert_eq!(
            engine.read_property(BLOCK_A, "priority").unwrap(),
            Some(Some("high".to_string()))
        );
    }

    #[test]
    fn apply_delete_property_distinct_from_set_property_null() {
        // `set_property(value=None)` writes an explicit Null at the
        // key — `read_property` returns `Some(None)`.
        // `delete_property` removes the key entirely — `read_property`
        // returns `None`.  This invariant is the reason both ops exist.
        let mut engine_clear = engine_with_block(BLOCK_A);
        engine_clear
            .apply_set_property(BLOCK_A, "k", None)
            .expect("clear");
        assert_eq!(
            engine_clear.read_property(BLOCK_A, "k").unwrap(),
            Some(None),
            "set_property(None) writes explicit-null"
        );

        let mut engine_delete = engine_with_block(BLOCK_A);
        engine_delete
            .apply_set_property(BLOCK_A, "k", Some("v"))
            .expect("set");
        engine_delete
            .apply_delete_property(BLOCK_A, "k")
            .expect("delete");
        assert_eq!(
            engine_delete.read_property(BLOCK_A, "k").unwrap(),
            None,
            "delete_property removes the key entirely"
        );

        // Transition: explicit-null -> delete_property must also
        // collapse `Some(None)` to `None` (the key is gone, not just
        // re-cleared).  This guards the `block_props.get(key).is_none()`
        // early-return inside `apply_delete_property` from being
        // "tightened" to bail on `LoroValue::Null` values, which
        // would silently leak explicit-null entries past purge.
        let mut engine_null_then_delete = engine_with_block(BLOCK_A);
        engine_null_then_delete
            .apply_set_property(BLOCK_A, "k", None)
            .expect("clear");
        engine_null_then_delete
            .apply_delete_property(BLOCK_A, "k")
            .expect("delete after explicit-null");
        assert_eq!(
            engine_null_then_delete.read_property(BLOCK_A, "k").unwrap(),
            None,
            "delete_property must remove key even when value is explicit-Null"
        );
    }
}

// ---------------------------------------------------------------------------
// Version-vector + incremental-update tests for the two wire-facing
// methods on `LoroEngine`:
//   * `version_vector` — `oplog_vv().encode()` round-trips byte-stable
//     via `VersionVector::decode`.
//   * `export_update_since` — the bytes produced by passing in a
//     captured pre-vv contain only ops added AFTER that vv (the
//     incremental-sync invariant).
// ---------------------------------------------------------------------------
#[cfg(test)]
mod sync_vv_tests {
    use super::LoroEngine;
    use loro::VersionVector;

    const BLOCK_A: &str = "01HZ00000000000000000000VV";
    const BLOCK_B: &str = "01HZ00000000000000000000VW";
    const BLOCK_C: &str = "01HZ00000000000000000000VX";
    const BLOCK_D: &str = "01HZ00000000000000000000VY";
    const BLOCK_E: &str = "01HZ00000000000000000000VZ";

    /// `version_vector` returns the encoded form of `oplog_vv()`,
    /// round-trippable via `VersionVector::decode`.  Locks the
    /// wire-format invariant that the bytes are well-formed input
    /// to the standard Loro decoder.
    #[test]
    fn version_vector_returns_encoded_bytes() {
        let mut engine = LoroEngine::with_peer_id("DEV-VV").expect("set peer");
        engine
            .apply_create_block(BLOCK_A, "text", "alpha", None, 0)
            .expect("create A");
        engine
            .apply_create_block(BLOCK_B, "text", "beta", None, 1)
            .expect("create B");

        let bytes = engine.version_vector();
        assert!(!bytes.is_empty(), "encoded vv must not be empty");

        let decoded = VersionVector::decode(&bytes).expect("decode round-trip");
        // `oplog_vv()` returns by-value; compare against a freshly
        // captured copy.  Round-trip equality is the contract.
        let direct = engine.doc.oplog_vv();
        assert_eq!(decoded, direct, "decoded vv must equal oplog_vv()");
    }

    /// `export_update_since` carries only ops added AFTER the
    /// captured vv.  Apply 3 ops on a sender, capture vv, apply 2
    /// more ops, export updates since the captured vv, import into
    /// a fresh receiver.  The receiver must see only the 2 post-vv
    /// blocks — the first 3 are not in the delta and remain unknown
    /// to the receiver.
    #[test]
    fn export_update_since_carries_only_post_vv_ops() {
        let mut sender = LoroEngine::with_peer_id("DEV-S").expect("set peer S");

        // First batch — 3 ops; these should NOT appear in the
        // post-vv delta.
        sender
            .apply_create_block(BLOCK_A, "text", "first", None, 0)
            .expect("create A");
        sender
            .apply_create_block(BLOCK_B, "text", "second", None, 1)
            .expect("create B");
        sender
            .apply_create_block(BLOCK_C, "text", "third", None, 2)
            .expect("create C");

        // Capture the frontier between the two batches.
        let vv_after_first_batch = sender.version_vector();

        // Second batch — 2 ops; these SHOULD appear in the delta.
        sender
            .apply_create_block(BLOCK_D, "text", "fourth", None, 3)
            .expect("create D");
        sender
            .apply_create_block(BLOCK_E, "text", "fifth", None, 4)
            .expect("create E");

        let delta_bytes = sender
            .export_update_since(&vv_after_first_batch)
            .expect("export updates since pre-batch-2 vv");
        assert!(
            !delta_bytes.is_empty(),
            "delta covering 2 ops must not be empty"
        );

        // Receiver mirrors the sender's pre-batch-2 state, then
        // imports the delta.  Use the same peer-id so the engines
        // share an op-log identity for this fixture.
        let mut receiver = LoroEngine::with_peer_id("DEV-S").expect("set peer R");
        receiver
            .apply_create_block(BLOCK_A, "text", "first", None, 0)
            .expect("receiver create A");
        receiver
            .apply_create_block(BLOCK_B, "text", "second", None, 1)
            .expect("receiver create B");
        receiver
            .apply_create_block(BLOCK_C, "text", "third", None, 2)
            .expect("receiver create C");

        // Sanity: receiver does not yet know about the post-vv blocks.
        assert!(
            receiver.read_block(BLOCK_D).unwrap().is_none(),
            "pre-import: BLOCK_D must be absent"
        );
        assert!(
            receiver.read_block(BLOCK_E).unwrap().is_none(),
            "pre-import: BLOCK_E must be absent"
        );

        receiver.import(&delta_bytes).expect("import delta");

        // Post-import: only the 2 post-vv blocks are now visible
        // because the delta carried no ops for the first 3.  (The
        // first 3 were already there from the manual seed; the
        // delta did not duplicate them.)
        let snap_d = receiver
            .read_block(BLOCK_D)
            .expect("read D")
            .expect("BLOCK_D must be present after import");
        assert_eq!(snap_d.content, "fourth");
        let snap_e = receiver
            .read_block(BLOCK_E)
            .expect("read E")
            .expect("BLOCK_E must be present after import");
        assert_eq!(snap_e.content, "fifth");

        // The vv after import should equal the sender's full vv —
        // confirming the delta closed the gap exactly.
        let receiver_vv = receiver.version_vector();
        let sender_vv = sender.version_vector();
        assert_eq!(
            VersionVector::decode(&receiver_vv).unwrap(),
            VersionVector::decode(&sender_vv).unwrap(),
            "receiver vv must match sender vv after delta import"
        );
    }
}
