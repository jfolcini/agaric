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

use std::collections::HashMap;

use loro::{
    Container, ExportMode, LoroDoc, LoroError, LoroList, LoroMap, LoroText, LoroTree,
    LoroTreeError, LoroValue, PeerID, TreeID, TreeParentId, VersionVector,
};

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

/// Map `(device_id, peer_id_epoch)` into a `loro::PeerID` (#792).
///
/// ## Why an epoch exists
///
/// A snapshot RESET (#607, `crate::snapshot::restore::apply_snapshot`)
/// wipes `loro_doc_state` and reloads the per-space engines EMPTY. A
/// fresh doc restarts Loro op counters at 0 — if it kept the same
/// deterministic `PeerID`, every post-reset op would mint `(peer,
/// counter)` ids that *collide* with this device's pre-reset ops still
/// held by peers. The fork is catastrophic in both directions:
/// outbound, peers silently drop the new ops (their version vector
/// already covers those ids); inbound, importing the peer's history
/// into the forked doc corrupts loro-internal's causal state (panic in
/// `loro-internal-1.12.0/src/container/richtext/richtext_state.rs`
/// `insert_elem_at_entity_index` under debug assertions; silent state
/// corruption in release). The RESET therefore bumps a persisted
/// `app_settings` epoch (`crate::loro::peer_epoch`) in the same
/// transaction that wipes the CRDT sidecar, and every engine built
/// after the reset derives its `PeerID` from this salted mapping —
/// a brand-new peer identity whose counters can safely restart at 0.
///
/// ## Stability contract — same rules as [`peer_id_from_device_id`]
///
/// - `epoch == 0` (the lifetime value for any vault that never went
///   through a snapshot RESET) MUST return exactly
///   `peer_id_from_device_id(device_id)` — existing vaults keep their
///   wire-visible `PeerID` with no migration.
/// - For `epoch > 0` the salted byte layout below
///   (`device_id ‖ 0x00 ‖ "loro-peer-epoch" ‖ 0x00 ‖ epoch_le_u64`)
///   is a pinned wire-format contract: a device that re-derives its
///   post-reset `PeerID` on every boot must land on the same value
///   forever. The `peer_id_for_epoch_is_stable_against_known_values`
///   test pins the mapping; changing it requires the same coordinated
///   migration as changing `peer_id_from_device_id`.
///
/// The NUL separators make the encoding injective for any `device_id`
/// (production device ids are UUID strings and never contain NUL), so
/// distinct `(device_id, epoch)` pairs hash distinct byte strings; the
/// collision math in [`peer_id_from_device_id`] applies unchanged.
pub fn peer_id_for_epoch(device_id: &str, epoch: u64) -> PeerID {
    if epoch == 0 {
        return peer_id_from_device_id(device_id);
    }
    let mut buf = Vec::with_capacity(device_id.len() + 25);
    buf.extend_from_slice(device_id.as_bytes());
    buf.push(0);
    buf.extend_from_slice(b"loro-peer-epoch");
    buf.push(0);
    buf.extend_from_slice(&epoch.to_le_bytes());
    xxhash_rust::xxh3::xxh3_64(&buf)
}

/// **Legacy** top-level LoroMap key holding the per-block sub-maps from
/// the pre-PEND-80-Phase-3 flat-map engine model (`loro_doc.getMap("blocks")`
/// -> `LoroMap<block_id, BlockData>`, where `BlockData` carried the
/// `parent_id`/`position` scalars directly).
///
/// Retained **only** as the v1-detection sentinel for
/// [`LoroEngine::reject_legacy_v1_snapshot`] (#332): a v2 doc never carries a
/// non-empty `blocks` map, so a non-empty one means a stray v1 snapshot, which
/// is now rejected loudly rather than migrated. No read/write path touches this
/// root — the block hierarchy is the tree at [`BLOCKS_TREE_ROOT`].
const LEGACY_BLOCKS_ROOT: &str = "blocks";

/// Top-level [`LoroTree`] key holding the block hierarchy (PEND-80 Phase 3).
///
/// Each block is a tree node (`TreeID`); the node's **meta map**
/// (`tree.get_meta(node)`) carries the scalar fields ([`FIELD_BLOCK_ID`],
/// [`FIELD_BLOCK_TYPE`], [`FIELD_CONTENT`] as a `LoroText`, [`FIELD_POSITION`],
/// [`FIELD_DELETED_AT`]). Parent = the tree parent (convergent, cycle-safe
/// move-CRDT); sibling order is the tree's native **fractional index** (#400) —
/// the SQL `position` column is a *derived* dense 1-based rank reprojected from
/// [`Self::children_ordered_block_ids`], not an independent sort key. The `i64`
/// [`FIELD_POSITION`] meta is now written only on the legacy op-replay path (to
/// reproduce the pre-#400 `ORDER BY position ASC, id ASC` while converting an
/// old op to a fractional slot) and as the migration's read-once input; it is
/// not the live sibling-order source. Soft-delete sets/clears
/// [`FIELD_DELETED_AT`] (the node survives in the tree for restore + the SQL
/// descendant-cascade derivation); purge calls `tree.delete` (hard remove).
const BLOCKS_TREE_ROOT: &str = "blocks_tree";

/// Top-level LoroMap key holding per-block properties.  Each value is
/// a `LoroMap<key, value>` with LWW semantics — overwriting a key on
/// two peers concurrently resolves via Loro's per-key LWW.
const BLOCK_PROPERTIES_ROOT: &str = "block_properties";

/// Top-level LoroMap key holding per-block tag associations.
///
/// ## Current shape (#622 fix / #709 Phase 1): name-keyed LoroMap
///
/// Each value is a `LoroMap` keyed by the tag's **normalized name**
/// ([`crate::tag_norm::normalize_tag_name`] over the tag block's
/// `content` at apply time), whose entry value is the `tag_id` ULID
/// string (what SQL `block_tags.tag_id` needs until the #709 Phase-2
/// re-key). When the tag block is not present in this doc (cross-space
/// tag, purged tag block, out-of-order replay) or its normalized name
/// is empty, the key degrades to the raw `tag_id` — keys can't collide
/// across the two namespaces because normalized names carry no ASCII
/// uppercase while ULIDs minted by `crate::ulid` are uppercase
/// Crockford base32 (worst case on a freak collision: two same-key
/// tags coalesce, which is the #709 end-state semantics anyway).
///
/// **Why a map** (#622): the previous `LoroList<String>` shape deduped
/// with a local check-then-push, which is NOT convergent — two peers
/// concurrently adding the same tag each pass the local check and the
/// list CRDT keeps both inserts after merge; `apply_remove_tag` then
/// deleted only the first occurrence, and the surviving element
/// resurrected the tag in SQL via
/// `reproject_block_tags_from_engine`. A map keyed by tag identity
/// makes duplicates unrepresentable: concurrent same-key inserts
/// resolve to ONE entry by Loro's per-key LWW (lamport, then peer-id
/// tiebreak — `MapValue::cmp` in loro-internal 1.12
/// `delta/map_delta.rs`, applied in `state/map_state.rs`), and keying
/// by *name* additionally converges concurrent adds of two same-named
/// tag blocks by construction (#709). Map state iterates in BTreeMap
/// key order, so `read_tags` is deterministic.
///
/// ## Legacy shape: LoroList (read + remove only)
///
/// Docs persisted before the fix hold a `LoroList<String>` of tag_ids
/// in the slot, possibly already containing duplicate elements. The
/// list is kept in place (no structural migration — overwriting the
/// slot with a map container is itself a lossy concurrent operation;
/// the wholesale re-key happens in #709 Phase 2) with fixed in-place
/// semantics: `read_tags` dedupes, `apply_remove_tag` deletes ALL
/// occurrences, and `apply_add_tag` keeps the legacy check-then-push
/// (a concurrent duplicate is still representable there but is now
/// harmless — reads flatten it and removal sweeps it).
///
/// Concurrent-container-creation caveat (pre-existing, both shapes):
/// two peers concurrently creating the per-block container at this
/// root race on the slot via per-key LWW (`LoroMap::insert_container`
/// pitfall note in loro 1.12) — the losing container's entries are
/// orphaned. Unchanged by #622; same exposure as `block_properties`.
const BLOCK_TAGS_ROOT: &str = "block_tags";

// Field keys inside a tree node's meta map.  Kept as &'static str constants
// so the round-trip read path uses the same key strings the writer used.
const FIELD_BLOCK_ID: &str = "block_id";
const FIELD_BLOCK_TYPE: &str = "block_type";
const FIELD_CONTENT: &str = "content";
/// Legacy sibling-order sort key (#400). Retired as the *ordering source* in
/// favour of Loro's native fractional index, but still written by the legacy
/// position-based apply path so historical op-log replay can convert a sparse
/// `position` into a sibling slot. New-scheme blocks carry no `position` meta;
/// their order is the tree's fractional index and their SQL `position` column
/// is the dense 1-based rank derived from [`LoroTree::children`].
const FIELD_POSITION: &str = "position";
const FIELD_DELETED_AT: &str = "deleted_at";

/// Top-level LoroMap root holding engine-wide scalar metadata (not per-block).
const ENGINE_META_ROOT: &str = "engine_meta";
/// Key under [`ENGINE_META_ROOT`] recording the sibling-order scheme version a
/// doc was last written/migrated to. Absent (== 0) ⇒ a pre-#400 snapshot whose
/// sibling order lives only in the `position` meta and must be migrated to the
/// fractional index on import. `1` ⇒ fractional-index order is authoritative.
const FIELD_SIBLING_ORDER_V: &str = "sibling_order_v";
/// Current sibling-order scheme version (#400). Bump only with a new migration.
const SIBLING_ORDER_VERSION: i64 = 1;

/// Engine on-disk format version. `1` = the legacy flat-map block model
/// (no longer supported); `2` = the [`LoroTree`] block hierarchy (PEND-80
/// Phase 3). The v1→v2 forward-migration was retired in #332 once every
/// persisted snapshot had been re-saved as v2; [`LoroEngine::import`] now
/// rejects a stray v1 snapshot loudly via
/// [`LoroEngine::reject_legacy_v1_snapshot`] instead of migrating it. A future
/// protocol-version handshake (PEND-81) may gate raw-byte merges across
/// formats; the maintainer does not sync today.
pub const ENGINE_FORMAT_VERSION: u32 = 2;

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
    /// Dense 1-based rank among the parent's children in fractional-index order
    /// (#400), projected into the SQL `position` column — not the legacy
    /// [`FIELD_POSITION`] meta value.
    pub position: i64,
}

/// A property value as the engine stores it natively (PEND-80 §2.1).
///
/// `Num`/`Bool` are persisted as native `LoroValue::Double`/`Bool` so the
/// engine is type-lossless; `Str` covers text/date/ref/select (all
/// `LoroValue::String` in Loro — disambiguated at the SQL projection by
/// `property_definitions.value_type`; this is the encoding chosen for the
/// open PEND-80 §8 Q5, kept reversible and migration-free). `Null` is an
/// explicit clear, distinct from a key being absent.
#[derive(Debug, Clone, PartialEq)]
pub enum PropertyValue {
    Str(String),
    Num(f64),
    Bool(bool),
    Null,
}

impl PropertyValue {
    /// Native `LoroValue` to persist in the engine.
    fn to_loro(&self) -> LoroValue {
        match self {
            PropertyValue::Str(s) => LoroValue::from(s.as_str()),
            PropertyValue::Num(n) => LoroValue::Double(*n),
            PropertyValue::Bool(b) => LoroValue::Bool(*b),
            PropertyValue::Null => LoroValue::Null,
        }
    }

    /// Recover a `PropertyValue` from a stored `LoroValue`. Accepts every
    /// scalar the engine may hold — including legacy `String`-encoded
    /// numbers/bools written before §2.1 (they stay `Str` and are recovered
    /// by `value_type` at projection, so this is fully back-compatible and
    /// needs no snapshot migration).
    fn from_loro(v: LoroValue) -> Result<PropertyValue, AppError> {
        match v {
            LoroValue::Null => Ok(PropertyValue::Null),
            LoroValue::String(s) => Ok(PropertyValue::Str((*s).clone())),
            LoroValue::Double(n) => Ok(PropertyValue::Num(n)),
            // NOTE: large i64 values (> 2^53) lose precision when cast to f64.
            // Safe for the date-ms / priority integers actually stored, but not
            // contractually guaranteed for arbitrary i64 payloads.
            LoroValue::I64(i) => Ok(PropertyValue::Num(i as f64)),
            LoroValue::Bool(b) => Ok(PropertyValue::Bool(b)),
            other => Err(AppError::Validation(format!(
                "loro: property value expected scalar, got {other:?}"
            ))),
        }
    }

    /// Lossy string view for the legacy string-returning read paths and
    /// parity/debug callers. `Null` → `None`.
    pub(crate) fn as_legacy_string(&self) -> Option<String> {
        match self {
            PropertyValue::Str(s) => Some(s.clone()),
            PropertyValue::Num(n) => Some(n.to_string()),
            PropertyValue::Bool(b) => Some(b.to_string()),
            PropertyValue::Null => None,
        }
    }
}

/// Production-side wrapper around a `LoroDoc`.  Owns one document per
/// space (per SPIKE-REPORT.md §4.1 — per-space-doc design).
///
/// ## Block hierarchy: [`LoroTree`] (PEND-80 Phase 3)
///
/// Blocks are a [`LoroTree`] at [`BLOCKS_TREE_ROOT`]. `create`/`move`/
/// `delete`/`purge` map to tree ops; the parent is the tree structure, so
/// the engine gets Loro's **move-CRDT convergence and deterministic cycle
/// rejection** ([`loro::TreeID`] moves that would form a cycle fail with
/// `CyclicMoveError` locally and are resolved deterministically on merge)
/// for free, replacing the old per-key-LWW `parent_id` scalar and the
/// hand-rolled cycle/position edge-case handling.
///
/// **Sibling order is the tree's native fractional index** (#400). The SQL
/// `position` column is a *derived* dense 1-based rank, reprojected from
/// [`Self::children_ordered_block_ids`] after every create/move, so
/// `ORDER BY position, id` pagination and the frontend stay on integer
/// positions while the CRDT owns rank + concurrent-reorder convergence (equal
/// fractional indices tie-break by `idlp`; see [`Self::FRACTIONAL_INDEX_JITTER`]).
/// Ops carry a 0-based sibling **slot** (`index`/`new_index`); Loro derives the
/// convergent fractional key at apply time. The legacy `i64` [`FIELD_POSITION`]
/// meta survives only as the replay-conversion input for pre-#400 ops and the
/// one-time import migration ([`Self::migrate_legacy_sibling_order_if_needed`]);
/// the old `midpointPosition`/`computePosition` frontend arithmetic is gone.
/// Phase-3's original deferral of fractional reorder (§3a "open risk #1") is
/// resolved here. Cross-peer reorder convergence under future sync is the one
/// remaining open question (PEND-81).
///
/// ## `block_id ↔ TreeID` indirection
///
/// Tree ops take `TreeID`s but the domain identity is the ULID `block_id`
/// (stored in node meta under [`FIELD_BLOCK_ID`]). [`Self::index`] caches
/// the `block_id → TreeID` map: it is maintained incrementally on the local
/// `apply_*` write path and rebuilt wholesale from node meta after any
/// `import` (see [`Self::rebuild_index`]).
pub struct LoroEngine {
    doc: LoroDoc,
    /// `block_id` (ULID) → `TreeID` lookup. A derived cache of the tree's
    /// node-meta `block_id`s — authoritative source is the tree itself.
    index: HashMap<String, TreeID>,
    /// `block_id → intended parent block_id` for nodes whose parent was not
    /// yet present in the engine when the create/move was applied (e.g.
    /// out-of-order replay). Attached to the real parent once it appears.
    /// Essentially never populated in practice (op-log replay is seq-ordered
    /// and the UI creates parents first) — a correctness safety net.
    pending_parent: HashMap<String, String>,
}

impl LoroEngine {
    /// Fresh, empty document.  Loro auto-assigns a random peer id on
    /// first commit; for any path that needs a stable peer id (sync,
    /// op-log replay) use [`LoroEngine::with_peer_id`].
    pub fn new() -> Self {
        let engine = Self {
            doc: LoroDoc::new(),
            index: HashMap::new(),
            pending_parent: HashMap::new(),
        };
        engine.init_sibling_ordering();
        engine
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
        Self::with_peer_id_epoch(device_id, 0)
    }

    /// [`Self::with_peer_id`] with an explicit peer-id epoch (#792).
    ///
    /// `epoch == 0` is byte-for-byte the legacy [`Self::with_peer_id`]
    /// mapping; `epoch > 0` derives a fresh `PeerID` via
    /// [`peer_id_for_epoch`] so a post-snapshot-RESET engine never
    /// re-mints `(peer, counter)` ids that collide with the device's
    /// pre-reset op history still held by peers. Production callers
    /// (`LoroEngineRegistry::for_space`, `rehydrate_registry`) pass the
    /// registry's current epoch, loaded from `app_settings` at boot and
    /// bumped inside the RESET transaction.
    pub fn with_peer_id_epoch(device_id: &str, epoch: u64) -> Result<Self, AppError> {
        let doc = LoroDoc::new();
        let peer = peer_id_for_epoch(device_id, epoch);
        doc.set_peer_id(peer).map_err(|e| {
            AppError::Validation(format!(
                "loro: set_peer_id from device_id {device_id} failed: {e}"
            ))
        })?;
        let engine = Self {
            doc,
            index: HashMap::new(),
            pending_parent: HashMap::new(),
        };
        engine.init_sibling_ordering();
        Ok(engine)
    }

    /// Jitter for Loro's fractional-index generator. `0` = deterministic,
    /// smallest encoding (Loro's default). Concurrent inserts at the *same*
    /// slot still converge — equal indices break the tie by `idlp` (peer +
    /// Lamport), which is deterministic across peers (see the #400 spike
    /// `concurrent_reorder_converges`). Jitter `>0` only trades doc size to
    /// avoid that tie; we don't need it for convergence. DO NOT change without
    /// re-validating convergence + snapshot size.
    const FRACTIONAL_INDEX_JITTER: u8 = 0;

    /// Enable Loro's native movable-tree fractional index as the sibling-order
    /// source (#400). Idempotent; safe to call on every engine construction.
    /// On a *legacy* doc the migration ([`Self::migrate_legacy_sibling_order`])
    /// runs at [`Self::import`] time, since enabling alone orders pre-existing
    /// nodes by creation (idlp), not by the legacy `position` meta.
    fn init_sibling_ordering(&self) {
        self.tree()
            .enable_fractional_index(Self::FRACTIONAL_INDEX_JITTER);
    }

    /// Read the doc's recorded sibling-order scheme version (0 if the marker
    /// is absent — a pre-#400 snapshot). See [`FIELD_SIBLING_ORDER_V`].
    fn sibling_order_version(&self) -> i64 {
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
    fn mark_sibling_order_current(&self) {
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
    fn live_tree_slot(
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
    fn tree_parent_readonly(&self, parent_id: Option<&str>) -> TreeParentId {
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
    fn legacy_slot(
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
    fn child_rank_position(&self, node: TreeID) -> i64 {
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
    fn any_node_has_legacy_position(&self) -> bool {
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
    fn force_legacy_scheme_for_test(&self, positions: &[(&str, i64)]) {
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

    /// Non-fatal wrapper used by the import paths: a migration failure is logged
    /// but never propagated, so a single bad doc cannot abort import and leave
    /// the space without an engine (#400, review).
    fn migrate_legacy_sibling_order_best_effort(&mut self) {
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
    fn migrate_legacy_sibling_order_if_needed(&mut self) -> Result<(), AppError> {
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
    fn migrate_legacy_sibling_order(&mut self) -> Result<(), AppError> {
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

    // -----------------------------------------------------------------
    // Tree helpers (PEND-80 Phase 3). The block hierarchy is a LoroTree
    // at BLOCKS_TREE_ROOT; these centralise node lookup + meta access so
    // the apply_*/read_* paths share one source of truth.
    // -----------------------------------------------------------------

    /// The block-hierarchy [`LoroTree`] handle (attached to the doc).
    fn tree(&self) -> LoroTree {
        self.doc.get_tree(BLOCKS_TREE_ROOT)
    }

    /// Resolve a `block_id` to its `TreeID` via the in-memory index.
    fn node_for(&self, block_id: &str) -> Option<TreeID> {
        self.index.get(block_id).copied()
    }

    /// Resolve the requested parent into a [`TreeParentId`]:
    /// `None` → tree root; `Some(pid)` present in the index → that node;
    /// `Some(pid)` *absent* → tree root **and** record `block_id`'s
    /// intended parent in [`Self::pending_parent`] so it is re-attached
    /// when `pid` later appears.
    fn resolve_parent(&mut self, block_id: &str, parent_id: Option<&str>) -> TreeParentId {
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
    fn attach_pending_children(&mut self, parent_block_id: &str) {
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
    fn write_node_identity(
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
    fn write_legacy_position(
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
    fn collect_subtree_block_ids(&self, root: TreeID) -> Vec<String> {
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
    fn live_nodes_with_block_id(&self) -> Vec<(TreeID, String)> {
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
    fn rebuild_index(&mut self) {
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
    fn reconcile_pending_parent(&mut self) {
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
    fn create_block_impl(
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
    fn resolve_move_target(
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
    fn move_block_impl(
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
    fn tag_map_key_for(&self, tag_id: &str) -> String {
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
    fn rekey_stale_tag_entries(&self, block_id: &str, tag_map: &LoroMap) -> Result<(), AppError> {
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

    /// Derive a node's parent `block_id` from the tree structure.
    /// `Ok(None)` for a tree root (top-level block), a deleted/uncreated
    /// parent, or a missing node. The parent's `block_id` is read back
    /// from the parent node's meta.
    fn parent_block_id_of(&self, node: TreeID) -> Result<Option<String>, AppError> {
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

    /// Typed variant of the per-block property read (PEND-80 §2.1): returns each
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
    /// the same value the originating peer wrote (PEND-80 Phase 2).
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

    /// Internal helper — fetch a block's tree-node **meta map** by id with
    /// a uniform error-context prefix so each caller doesn't repeat the
    /// boilerplate. Errors if the `block_id` is unknown to the index.
    fn get_block_map(&self, block_id: &str, ctx: &str) -> Result<LoroMap, AppError> {
        let node = self.node_for(block_id).ok_or_else(|| {
            AppError::Validation(format!("loro: {ctx}: block {block_id} not found"))
        })?;
        self.tree().get_meta(node).map_err(|e| {
            AppError::Validation(format!("loro: {ctx}: block {block_id} get_meta: {e}"))
        })
    }

    /// A reference-clone of the engine's underlying `LoroDoc`.
    ///
    /// Loro's `LoroDoc::clone` is a *handle* clone — the cloned doc shares
    /// the same underlying document (see the loro 1.12 `impl Clone for
    /// LoroDoc` doc-comment), so this is O(1) and does NOT deep-copy the
    /// document state. Issue #153: the periodic-snapshot scheduler uses
    /// this to collect cheap handles under the registry mutex, drop the
    /// lock, then run the (comparatively slow) snapshot
    /// [`export`](loro::LoroDoc::export) outside the lock — so the engine
    /// mutex is held only for the O(1) handle clone, not for every
    /// per-space serialization.
    pub fn doc_handle(&self) -> LoroDoc {
        self.doc.clone()
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
    ///
    /// After importing, rejects any legacy v1 (flat-map) snapshot
    /// (#332 — the v1→v2 migration was retired once all snapshots were on
    /// v2) and rebuilds the `block_id → TreeID` index — the imported bytes
    /// may have created tree nodes the incremental index never saw.
    pub fn import(&mut self, bytes: &[u8]) -> Result<(), AppError> {
        self.doc
            .import(bytes)
            .map(|_status| ())
            .map_err(|e| AppError::Validation(format!("loro: import: {e}")))?;
        self.reject_legacy_v1_snapshot()?;
        self.rebuild_index();
        // A pre-#400 snapshot carries sibling order only in the `position`
        // meta; migrate it onto the fractional index exactly once. The guard (a
        // marker-less doc that still carries a legacy `position` meta) keeps
        // this a true "is pre-#400" signal — see the helper.
        //
        // Best-effort: a migration failure must NOT fail import. Propagating it
        // would make `rehydrate_registry` skip the space and the next op mint a
        // fresh EMPTY engine, diverging the CRDT from the populated SQL blocks
        // for the whole space. Log loudly and install the doc UNMIGRATED (tree
        // fractional / creation order); the next successful create/move
        // reprojects the affected sibling group (#400, review).
        self.migrate_legacy_sibling_order_best_effort();
        Ok(())
    }

    /// Import `bytes` into the doc and return every block_id present
    /// in the post-import block-hierarchy LoroTree, in parent-before-child
    /// pre-order so the caller's FK-ordered SQL projection succeeds.
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
        self.reject_legacy_v1_snapshot()?;
        self.rebuild_index();
        // Mirror `import`'s one-time legacy sibling-order migration so a pre-#400
        // doc arriving over the sync-pull path (not just a local snapshot) is
        // also reordered onto the fractional index before projection (#400).
        // Best-effort for the same reason as `import` — a migration error must
        // not abort the sync-pull and drop the space's engine.
        self.migrate_legacy_sibling_order_best_effort();

        // Enumerate every live block_id **parent-before-child** (pre-order
        // DFS from the tree roots) so the caller's Pass-A projection inserts
        // a parent's SQL row before any child's — the `blocks.parent_id`
        // self-FK rejects the reverse order. Soft-deleted nodes are
        // included (still live in the tree; the projection refreshes their
        // core columns without touching SQL `deleted_at`); hard-purged
        // nodes are absent from `children`/`roots` and so excluded.
        let tree = self.tree();
        let mut out: Vec<crate::ulid::BlockId> = Vec::with_capacity(self.index.len());
        let mut stack: Vec<TreeID> = tree.roots();
        // `roots()` is unordered; reverse so pre-order emits roots in a
        // stable forward order (cosmetic — FK-correctness only needs
        // parent-before-child, which the DFS guarantees regardless).
        stack.reverse();
        while let Some(node) = stack.pop() {
            if let Ok(meta) = tree.get_meta(node)
                && let Ok(bid) = read_string(&meta, FIELD_BLOCK_ID)
            {
                out.push(crate::ulid::BlockId::from_trusted(&bid));
            }
            if let Some(mut children) = tree.children(TreeParentId::Node(node)) {
                children.reverse();
                stack.extend(children);
            }
        }
        Ok(out)
    }

    /// Reject a legacy v1 (flat-map) snapshot loudly (#332).
    ///
    /// PEND-80 Phase 3 (#331) moved the block hierarchy from a flat
    /// [`LEGACY_BLOCKS_ROOT`] `LoroMap` (format 1) to the [`BLOCKS_TREE_ROOT`]
    /// [`LoroTree`] (format 2), migrating old snapshots forward on every
    /// import. #332 retired that migration once every persisted snapshot had
    /// been re-saved as v2. A v2 doc never carries a non-empty legacy `blocks`
    /// map, so a non-empty one means a stray v1 snapshot — fail loudly with a
    /// clear error rather than silently producing an empty tree (downgrade to a
    /// pre-#332 build to migrate the data forward first).
    fn reject_legacy_v1_snapshot(&self) -> Result<(), AppError> {
        let legacy: LoroMap = self.doc.get_map(LEGACY_BLOCKS_ROOT);
        if !legacy.is_empty() {
            return Err(AppError::Validation(format!(
                "loro: import: legacy v1 (flat-map) snapshot detected ({} block(s) under \
                 the deprecated `{}` root). The v1->v2 migration was removed in #332; open \
                 this data with a pre-#332 build first to migrate it forward.",
                legacy.len(),
                LEGACY_BLOCKS_ROOT,
            )));
        }
        Ok(())
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

    /// Detect a `(peer, counter)` fork of OUR OWN peer id in an inbound
    /// blob, BEFORE importing it (#792).
    ///
    /// ## What a fork is
    ///
    /// Returns `Some(reason)` iff the blob carries ops credited to this
    /// engine's own `PeerID` at counters *beyond* what this doc holds,
    /// while this doc has already minted at least one op under that
    /// `PeerID`. That combination means two divergent op histories share
    /// our peer id — the signature of a pre-#792 snapshot RESET that
    /// reused the deterministic peer id (the peer still holds our
    /// pre-reset ops; we re-minted unrelated ops at the same low
    /// counters). Importing such a blob makes loro skip the overlapping
    /// counter range (its vv already "covers" them) and then apply the
    /// peer's higher-counter ops against the WRONG causal prefix —
    /// panicking inside loro-internal 1.12's richtext state under debug
    /// assertions, silently corrupting it in release. Callers must treat
    /// `Some` as "do not import; request a snapshot catch-up"
    /// (the RESET path now bumps the peer-id epoch, so the catch-up
    /// permanently heals the fork).
    ///
    /// ## What is NOT a fork
    ///
    /// * `local own-counter == 0` — this doc never minted an op under
    ///   its peer id, so there is nothing to collide with. A peer
    ///   re-sending our own pre-reset history into a freshly reset
    ///   (empty) doc is the *clean* resync path: loro imports it and
    ///   local counters continue from the imported vv.
    /// * `blob end_vv[own] <= local own-counter` — the blob carries
    ///   nothing of ours beyond what we hold (the normal echo /
    ///   idempotent re-import shape).
    ///
    /// The inverse fork shape — we re-minted MORE post-reset ops than
    /// the peer holds pre-reset ones — is indistinguishable from a
    /// benign echo at the version-vector level and is NOT detected
    /// here; see #792 for why vv metadata is the practical limit.
    ///
    /// Decode failures are deliberately tolerated (`None` + a warn):
    /// the guard must never block an import the real
    /// [`Self::import_with_changed_blocks`] would have accepted, and a
    /// genuinely malformed blob will surface a proper error there.
    pub fn own_peer_fork_in_blob(&self, bytes: &[u8]) -> Option<String> {
        // Cheap precondition first: a doc that never minted an op under
        // its own peer id has nothing to fork, so skip the blob-meta
        // decode entirely (it rebuilds the blob's full change store —
        // non-trivial for snapshot blobs, and this empty-doc shape is
        // exactly the post-reset resync window where snapshots arrive).
        let own = self.doc.peer_id();
        let local_counter = self.doc.oplog_vv().get(&own).copied().unwrap_or(0);
        if local_counter == 0 {
            return None;
        }
        let meta = match LoroDoc::decode_import_blob_meta(bytes, true) {
            Ok(m) => m,
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    "loro: own_peer_fork_in_blob: blob meta decode failed; \
                     skipping the fork guard (import will surface the real error)"
                );
                return None;
            }
        };
        let blob_counter = meta.partial_end_vv.get(&own).copied().unwrap_or(0);
        if blob_counter > local_counter {
            return Some(format!(
                "(peer,counter) fork detected for own peer id {own} (#792): inbound blob \
                 carries our ops through counter {blob_counter} but this doc only holds \
                 {local_counter} — a pre-epoch snapshot RESET reused the deterministic \
                 peer id; importing would corrupt causal state. Snapshot catch-up required."
            ));
        }
        None
    }

    /// #1054 — detect an *update*-shaped blob whose causal base is NOT
    /// reachable from this doc's current `oplog_vv()`, BEFORE importing it.
    ///
    /// ## Why this mirrors the live MAINT-228 gate
    ///
    /// [`crate::sync_protocol::loro_sync::apply_remote`] runs the MAINT-228
    /// reachability gate on a `LoroSyncMessage::Update`'s declared `from_vv`
    /// and short-circuits into the snapshot-fallback path on a miss — an
    /// unreachable update would otherwise surface as an *opaque Loro decode
    /// error* from [`Self::import_with_changed_blocks`]. The boot-replay path
    /// has only `(space_id, bytes)` in the inbox row (no `from_vv`), so it
    /// recovers the base from the blob itself: `partial_start_vv` is the blob's
    /// own start frontier — the update's causal base — and is compared against
    /// the local `oplog_vv()` with the SAME "every (peer,counter) entry must be
    /// matched by a local entry whose counter is `>=`" rule as the live gate.
    ///
    /// Returns `Some(reason)` iff the blob is update-shaped AND its
    /// `partial_start_vv` is unreachable. Callers must treat `Some` as "do not
    /// import; drop the slot and let the next live sync session detect the gap
    /// in `apply_remote` and route into snapshot catch-up".
    ///
    /// ## What is NOT flagged (safe to import unconditionally)
    ///
    /// * **Snapshot-shaped blobs** (`meta.mode.is_snapshot()`) — a snapshot is
    ///   self-contained: it carries a full causal base and imports against any
    ///   prior state, exactly as the live gate only checks `Update` (never
    ///   `Snapshot`) variants. Returns `None`.
    /// * A `0`-counter entry in `partial_start_vv` carries no ops and is
    ///   trivially reachable (mirrors the live classifier's no-op skip).
    ///
    /// Decode failures are deliberately tolerated (`None` + a warn), identical
    /// to [`Self::own_peer_fork_in_blob`]: the guard must never block an import
    /// the real [`Self::import_with_changed_blocks`] would have accepted, and a
    /// genuinely malformed blob will surface a proper error there.
    pub fn unreachable_update_in_blob(&self, bytes: &[u8]) -> Option<String> {
        let meta = match LoroDoc::decode_import_blob_meta(bytes, true) {
            Ok(m) => m,
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    "loro: unreachable_update_in_blob: blob meta decode failed; \
                     skipping the reachability guard (import will surface the real error)"
                );
                return None;
            }
        };
        // Snapshot-shaped blobs are self-contained and always safe to import
        // (the live MAINT-228 gate only checks Update variants). Skip them.
        if meta.mode.is_snapshot() {
            return None;
        }

        // Update-shaped: the blob's `partial_start_vv` is its causal base.
        // Reachable iff, for every (peer,counter) entry the base requires,
        // our local oplog_vv holds the same peer at a counter `>=` it. A
        // `0`-counter entry carries no ops and is trivially reachable.
        let local_vv = self.doc.oplog_vv();
        for (peer_id, &base_counter) in meta.partial_start_vv.iter() {
            if base_counter == 0 {
                continue;
            }
            match local_vv.get(peer_id) {
                Some(&local_counter) if local_counter >= base_counter => continue,
                Some(&local_counter) => {
                    return Some(format!(
                        "boot-replay update base unreachable (#1054): requires peer={peer_id} \
                         counter>={base_counter}, local oplog_vv has counter={local_counter}"
                    ));
                }
                None => {
                    return Some(format!(
                        "boot-replay update base unreachable (#1054): requires peer={peer_id} \
                         counter>={base_counter}, local oplog_vv has no entry for that peer"
                    ));
                }
            }
        }
        None
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

/// True iff `e` is LoroTree's deterministic cycle-rejection error — a
/// `mov` whose target would become an ancestor of itself. The block
/// hierarchy uses this to skip (not fail on) a cycle-forming reparent that
/// reaches the engine despite the command-layer guard.
fn is_cyclic_move(e: &LoroError) -> bool {
    matches!(e, LoroError::TreeError(LoroTreeError::CyclicMoveError))
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

/// Read a node-meta `deleted_at` slot: `None` for an absent slot or an
/// explicit `Null` (alive), `Some(ts)` for a soft-delete timestamp.
fn read_deleted_at_meta(meta: &LoroMap, block_id: &str) -> Result<Option<String>, AppError> {
    match meta.get(FIELD_DELETED_AT) {
        None => Ok(None),
        Some(voc) => {
            let value = voc.into_value().map_err(|_| {
                AppError::Validation(format!("loro: block {block_id} deleted_at is not a scalar"))
            })?;
            match value {
                LoroValue::Null => Ok(None),
                LoroValue::String(s) => Ok(Some((*s).clone())),
                other => Err(AppError::Validation(format!(
                    "loro: block {block_id}: deleted_at expected String|Null, got {other:?}"
                ))),
            }
        }
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

/// Clamp a requested sibling slot to `0..=max` so `create_at`/`mov_to` never
/// error on an out-of-range index (e.g. a stale frontend slot or a converted
/// legacy position past the current child count). Clamping degrades to
/// "append at end" rather than failing the whole op.
fn clamp_slot(slot: usize, max: usize) -> usize {
    slot.min(max)
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
// Tag-container helpers (Phase-2 day-8.5; reshaped for #622).  Centralised so
// `apply_add_tag` / `apply_remove_tag` / `read_tags` share one source of truth
// for the per-block container shape sniffing and the LoroList<String> ->
// String mapping on the legacy path.
// ---------------------------------------------------------------------------

/// The two shapes a per-block [`BLOCK_TAGS_ROOT`] slot can hold (see
/// the constant's docstring): the current name-keyed `LoroMap` (#622 /
/// #709 Phase 1) or a legacy pre-#622 `LoroList` kept in place until
/// the Phase-2 wholesale re-key.
enum TagsSlot {
    Map(LoroMap),
    List(LoroList),
}

/// Sniff the per-block tag container under the `block_tags` root.
/// `Ok(None)` when the block has no slot; an error when the slot holds
/// a scalar or an unexpected container type (writer/reader drift —
/// fail loudly).  `ctx` is the operation name (e.g. `"add_tag"`) for
/// error-context prefixing.
fn tags_slot(tags_root: &LoroMap, block_id: &str, ctx: &str) -> Result<Option<TagsSlot>, AppError> {
    let Some(voc) = tags_root.get(block_id) else {
        return Ok(None);
    };
    let container = voc.into_container().map_err(|_| {
        AppError::Validation(format!(
            "loro: {ctx} block {block_id} tags slot is not a container"
        ))
    })?;
    match container {
        Container::Map(map) => Ok(Some(TagsSlot::Map(map))),
        Container::List(list) => Ok(Some(TagsSlot::List(list))),
        other => Err(AppError::Validation(format!(
            "loro: {ctx} block {block_id} tags slot is neither a LoroMap \
             nor a legacy LoroList (got {:?})",
            other.get_type()
        ))),
    }
}

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
        if let Ok(LoroValue::String(s)) = voc.into_value()
            && s.as_str() == needle
        {
            return Some(idx);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::peer_id_from_device_id;

    // PEND-80 §2.1: the engine stores property values with their native type
    // (Num/Bool) and round-trips them losslessly via `read_all_properties_typed`,
    // while the legacy string path stays back-compatible.
    #[test]
    fn typed_property_values_round_trip() {
        use super::{LoroEngine, PropertyValue};
        let mut e = LoroEngine::new();
        e.apply_set_property_typed("B1", "count", &PropertyValue::Num(3.5))
            .unwrap();
        e.apply_set_property_typed("B1", "done", &PropertyValue::Bool(true))
            .unwrap();
        e.apply_set_property_typed("B1", "title", &PropertyValue::Str("hi".into()))
            .unwrap();
        e.apply_set_property_typed("B1", "cleared", &PropertyValue::Null)
            .unwrap();

        let mut typed = e.read_all_properties_typed("B1").unwrap();
        typed.sort_by(|a, b| a.0.cmp(&b.0));
        assert_eq!(
            typed,
            vec![
                ("cleared".to_string(), PropertyValue::Null),
                ("count".to_string(), PropertyValue::Num(3.5)),
                ("done".to_string(), PropertyValue::Bool(true)),
                ("title".to_string(), PropertyValue::Str("hi".to_string())),
            ]
        );

        // The string shim still works and stores a String value.
        e.apply_set_property("B1", "note", Some("x")).unwrap();
        assert_eq!(
            e.read_all_properties_typed("B1")
                .unwrap()
                .into_iter()
                .find(|(k, _)| k == "note"),
            Some(("note".to_string(), PropertyValue::Str("x".to_string())))
        );
    }

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

    // -----------------------------------------------------------------
    // #792 — peer-id epoch: a snapshot RESET retires the deterministic
    // peer id instead of forking the (peer, counter) space.
    // -----------------------------------------------------------------

    /// Epoch 0 IS the legacy mapping — existing vaults (which have no
    /// epoch row) keep their wire-visible PeerID with no migration.
    #[test]
    fn peer_id_for_epoch_zero_matches_legacy_mapping_792() {
        use super::peer_id_for_epoch;
        for dev in ["DEV-A", "01ARZ3NDEKTSV4RRFFQ69G5FAV", ""] {
            assert_eq!(
                peer_id_for_epoch(dev, 0),
                peer_id_from_device_id(dev),
                "epoch 0 must reproduce the legacy mapping for {dev:?}"
            );
        }
    }

    /// Distinct epochs yield distinct peer ids for the same device —
    /// the property the post-RESET fork fix rests on.
    #[test]
    fn peer_id_for_epoch_distinct_across_epochs_792() {
        use super::peer_id_for_epoch;
        let dev = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
        let ids = [
            peer_id_for_epoch(dev, 0),
            peer_id_for_epoch(dev, 1),
            peer_id_for_epoch(dev, 2),
        ];
        assert_ne!(ids[0], ids[1]);
        assert_ne!(ids[1], ids[2]);
        assert_ne!(ids[0], ids[2]);
        // Determinism: re-derivation lands on the same value.
        assert_eq!(peer_id_for_epoch(dev, 1), ids[1]);
    }

    /// Pins the epoch-salted bytes-in / u64-out mapping for fixed
    /// inputs — same coordinated-migration rules as
    /// `peer_id_from_device_id_is_stable_against_known_values`: a
    /// device that went through a RESET re-derives its post-reset
    /// PeerID from `(device_id, epoch)` on every boot, so this mapping
    /// is wire-format. Do NOT update these values without a team
    /// review and a migration plan.
    #[test]
    fn peer_id_for_epoch_is_stable_against_known_values_792() {
        use super::peer_id_for_epoch;
        assert_eq!(
            peer_id_for_epoch("01ARZ3NDEKTSV4RRFFQ69G5FAV", 1),
            0xd95d_315c_0529_08ad_u64,
        );
        assert_eq!(
            peer_id_for_epoch("01ARZ3NDEKTSV4RRFFQ69G5FAV", 2),
            0x1799_4df7_4030_7445_u64,
        );
    }

    /// #792 reproduction — the OUTBOUND silent-drop direction of the
    /// fork, exactly as the issue probed it. This test documents the
    /// pre-#792 RESET behaviour (fresh engine, SAME deterministic peer
    /// id): the peer's import returns `Ok` but the post-reset block is
    /// silently dropped, because the peer's version vector already
    /// covers the re-minted (peer, counter) ids. The companion test
    /// below proves the epoch bump fixes it.
    #[test]
    fn reset_reusing_same_peer_id_silently_drops_post_reset_ops_at_peer_792() {
        use super::LoroEngine;

        // Device A mints three blocks; peer B imports A's history.
        let mut a = LoroEngine::with_peer_id("DEV-A").expect("A");
        a.apply_create_block("PRE-1", "content", "one", None, 0)
            .expect("pre-1");
        a.apply_create_block("PRE-2", "content", "two", None, 1)
            .expect("pre-2");
        a.apply_create_block("PRE-3", "content", "three", None, 2)
            .expect("pre-3");
        let mut b = LoroEngine::with_peer_id("DEV-B").expect("B");
        b.import(&a.export_snapshot().expect("snap"))
            .expect("seed B");

        // A goes through a pre-#792 snapshot RESET: engines reload
        // EMPTY under the SAME deterministic peer id (epoch 0) and op
        // counters restart at 0 — forking the (peer, counter) space.
        let mut a_reset = LoroEngine::with_peer_id("DEV-A").expect("A reset");
        assert_eq!(a_reset.peer_id(), a.peer_id(), "pre-#792: same peer id");
        a_reset
            .apply_create_block("POST-1", "content", "after reset", None, 0)
            .expect("post-1");

        // Outbound: B's import returns Ok…
        b.import(&a_reset.export_snapshot().expect("snap2"))
            .expect("import of the forked doc reports Ok — that's the trap");
        // …but the post-reset block was silently dropped (B's vv already
        // covers those (peer, counter) ids from the PRE blocks).
        assert!(
            b.read_block("POST-1").expect("read").is_none(),
            "documents the #792 bug shape: with the peer id reused, the \
             post-reset block must be silently dropped at the peer — if \
             this ever starts importing, loro's import semantics changed \
             and the #792 design needs re-review"
        );
    }

    /// #792 fix — the same RESET scenario with the bumped peer-id
    /// epoch: the post-reset engine mints ops under a FRESH PeerID, so
    /// the peer imports them instead of silently dropping them.
    #[test]
    fn reset_with_bumped_epoch_delivers_post_reset_ops_to_peer_792() {
        use super::LoroEngine;

        let mut a = LoroEngine::with_peer_id("DEV-A").expect("A");
        a.apply_create_block("PRE-1", "content", "one", None, 0)
            .expect("pre-1");
        a.apply_create_block("PRE-2", "content", "two", None, 1)
            .expect("pre-2");
        a.apply_create_block("PRE-3", "content", "three", None, 2)
            .expect("pre-3");
        let mut b = LoroEngine::with_peer_id("DEV-B").expect("B");
        b.import(&a.export_snapshot().expect("snap"))
            .expect("seed B");

        // The RESET now bumps the persisted epoch; the reloaded engine
        // derives a fresh peer id and counters can restart at 0 safely.
        let mut a_reset = LoroEngine::with_peer_id_epoch("DEV-A", 1).expect("A reset");
        assert_ne!(
            a_reset.peer_id(),
            a.peer_id(),
            "the epoch bump must retire the pre-reset peer id"
        );
        a_reset
            .apply_create_block("POST-1", "content", "after reset", None, 0)
            .expect("post-1");

        b.import(&a_reset.export_snapshot().expect("snap2"))
            .expect("import");
        let snap = b
            .read_block("POST-1")
            .expect("read")
            .expect("#792 regression: the post-reset block must reach the peer");
        assert_eq!(snap.content, "after reset");
    }

    /// #792 guard — a blob carrying our own peer id at counters beyond
    /// what we hold, while we already minted ops under that id, is the
    /// fork signature (a pre-epoch RESET reused the peer id). Importing
    /// it would corrupt loro-internal's causal state (the inbound
    /// SIGABRT direction of the issue — not reproducible in-suite
    /// because the failure is a destructor panic → abort), so the guard
    /// must flag it BEFORE any import.
    #[test]
    fn own_peer_fork_in_blob_detects_peer_held_pre_reset_history_792() {
        use super::LoroEngine;

        // The peer's copy of our pre-reset history (3 blocks of ops).
        let mut a = LoroEngine::with_peer_id("DEV-A").expect("A");
        a.apply_create_block("PRE-1", "content", "one", None, 0)
            .expect("pre-1");
        a.apply_create_block("PRE-2", "content", "two", None, 1)
            .expect("pre-2");
        a.apply_create_block("PRE-3", "content", "three", None, 2)
            .expect("pre-3");
        let peer_held_history = a.export_snapshot().expect("snap");

        // Our forked post-reset doc: same peer id, one re-minted block.
        let mut forked = LoroEngine::with_peer_id("DEV-A").expect("forked");
        forked
            .apply_create_block("POST-1", "content", "after reset", None, 0)
            .expect("post-1");

        let reason = forked
            .own_peer_fork_in_blob(&peer_held_history)
            .expect("the fork guard must flag the peer-held pre-reset history");
        assert!(
            reason.contains("fork") && reason.contains("#792"),
            "reason should be self-diagnosing, got: {reason}"
        );
    }

    /// #792 guard control — the CLEAN post-reset resync (no local ops
    /// minted before the first inbound import) must pass the guard and
    /// import cleanly, with counters continuing from the imported vv.
    /// This is the issue's "control" probe and the path the snapshot
    /// catch-up heal relies on.
    #[test]
    fn own_peer_fork_in_blob_allows_clean_post_reset_resync_792() {
        use super::LoroEngine;

        let mut a = LoroEngine::with_peer_id("DEV-A").expect("A");
        a.apply_create_block("PRE-1", "content", "one", None, 0)
            .expect("pre-1");
        let peer_held_history = a.export_snapshot().expect("snap");

        // Freshly reset doc, SAME peer id, ZERO local ops.
        let mut fresh = LoroEngine::with_peer_id("DEV-A").expect("fresh");
        assert!(
            fresh.own_peer_fork_in_blob(&peer_held_history).is_none(),
            "a doc with no own ops has nothing to fork — resync must pass"
        );
        fresh.import(&peer_held_history).expect("clean resync");
        assert!(fresh.read_block("PRE-1").expect("read").is_some());

        // Counters continue from the imported vv: a new local op must
        // reach a peer that holds the full pre-reset history.
        fresh
            .apply_create_block("POST-1", "content", "continued", None, 1)
            .expect("post-1");
        let mut b = LoroEngine::with_peer_id("DEV-B").expect("B");
        b.import(&peer_held_history).expect("seed B");
        b.import(&fresh.export_snapshot().expect("snap2"))
            .expect("import");
        assert!(
            b.read_block("POST-1").expect("read").is_some(),
            "continued counters must deliver new ops to the peer"
        );
    }

    /// #792 guard control — ordinary traffic never trips the guard:
    /// (a) a peer's update carrying only the PEER's ops, and (b) an
    /// idempotent echo of our own full history (blob end_vv == local).
    #[test]
    fn own_peer_fork_in_blob_allows_normal_updates_and_echo_792() {
        use super::LoroEngine;

        let mut a = LoroEngine::with_peer_id("DEV-A").expect("A");
        a.apply_create_block("A-1", "content", "from A", None, 0)
            .expect("a-1");

        // (a) B receives A's state, mints its own block, sends A the
        // delta since A's vv — the blob carries only B's ops.
        let mut b = LoroEngine::with_peer_id("DEV-B").expect("B");
        b.import(&a.export_snapshot().expect("snap"))
            .expect("seed B");
        b.apply_create_block("B-1", "content", "from B", None, 1)
            .expect("b-1");
        let delta = b.export_update_since(&a.version_vector()).expect("delta");
        assert!(
            a.own_peer_fork_in_blob(&delta).is_none(),
            "a peer-only update must not trip the fork guard"
        );

        // (b) An echo of our own history: blob end_vv[us] == local.
        let echo = a.export_snapshot().expect("echo");
        assert!(
            a.own_peer_fork_in_blob(&echo).is_none(),
            "an idempotent echo of our own ops must not trip the fork guard"
        );
    }

    /// #792 guard robustness — sync input is untrusted bytes. The guard
    /// runs BEFORE the real import, so a malformed / truncated / hostile
    /// blob must degrade to `None` (warn + let the import surface the
    /// real error), never panic. Exercised against a doc that HAS local
    /// ops, so the decode path is actually reached.
    #[test]
    fn own_peer_fork_in_blob_tolerates_malformed_bytes_792() {
        use super::LoroEngine;

        let mut a = LoroEngine::with_peer_id("DEV-A").expect("A");
        a.apply_create_block("A-1", "content", "from A", None, 0)
            .expect("a-1");

        // Arbitrary garbage, empty input, and a truncated-but-prefixed
        // real blob (valid magic header, corrupt body/checksum).
        assert!(a.own_peer_fork_in_blob(b"not a loro blob").is_none());
        assert!(a.own_peer_fork_in_blob(&[]).is_none());
        let real = a.export_snapshot().expect("snap");
        for len in [4usize, 16, real.len() / 2, real.len() - 1] {
            assert!(
                a.own_peer_fork_in_blob(&real[..len.min(real.len())])
                    .is_none(),
                "truncated blob (len {len}) must not trip or panic the guard"
            );
        }
        let mut flipped = real.clone();
        if let Some(last) = flipped.last_mut() {
            *last ^= 0xFF;
        }
        assert!(
            a.own_peer_fork_in_blob(&flipped).is_none(),
            "checksum-corrupt blob must not trip or panic the guard"
        );
    }

    // -----------------------------------------------------------------
    // #1054 — `unreachable_update_in_blob` reachability guard.
    // -----------------------------------------------------------------

    /// #1054 — an Update-shaped blob whose `partial_start_vv` (causal base)
    /// is unreachable from this doc's `oplog_vv()` must be flagged BEFORE
    /// import (it would otherwise surface as an opaque Loro decode error).
    #[test]
    fn unreachable_update_in_blob_flags_unreachable_update_1054() {
        use super::LoroEngine;

        // Producer: 2 ops → vv → 3rd op; export the delta since the
        // post-2-ops vv (base = producer @ counter 2).
        let mut a = LoroEngine::with_peer_id("DEV-A").expect("A");
        a.apply_create_block("A-1", "content", "one", None, 0)
            .expect("a-1");
        a.apply_create_block("A-2", "content", "two", None, 1)
            .expect("a-2");
        let base_vv = a.version_vector();
        a.apply_create_block("A-3", "content", "three", None, 2)
            .expect("a-3");
        let update = a.export_update_since(&base_vv).expect("delta");

        // A fresh doc has never seen DEV-A's ops → base unreachable.
        let fresh = LoroEngine::with_peer_id("DEV-B").expect("fresh");
        let reason = fresh
            .unreachable_update_in_blob(&update)
            .expect("unreachable update must be flagged");
        assert!(
            reason.contains("#1054") && reason.contains("unreachable"),
            "reason must be self-diagnosing, got: {reason}"
        );
    }

    /// #1054 — an Update whose base IS reachable must NOT be flagged
    /// (the guard must not block a legitimately-applicable update), and a
    /// snapshot blob is self-contained → never flagged, even on a fresh
    /// doc.
    #[test]
    fn unreachable_update_in_blob_allows_reachable_update_and_snapshot_1054() {
        use super::LoroEngine;

        let mut a = LoroEngine::with_peer_id("DEV-A").expect("A");
        a.apply_create_block("A-1", "content", "one", None, 0)
            .expect("a-1");
        a.apply_create_block("A-2", "content", "two", None, 1)
            .expect("a-2");
        let base_vv = a.version_vector();
        let snapshot = a.export_snapshot().expect("snap");
        a.apply_create_block("A-3", "content", "three", None, 2)
            .expect("a-3");
        let update = a.export_update_since(&base_vv).expect("delta");

        // A receiver that already holds the base (the first 2 ops): the
        // update's base is reachable.
        let mut b = LoroEngine::with_peer_id("DEV-B").expect("B");
        b.import(&snapshot).expect("seed B");
        assert!(
            b.unreachable_update_in_blob(&update).is_none(),
            "a reachable update must not be flagged"
        );

        // A snapshot is self-contained: never flagged, even on a fresh doc.
        let fresh = LoroEngine::with_peer_id("DEV-C").expect("fresh");
        assert!(
            fresh.unreachable_update_in_blob(&snapshot).is_none(),
            "a snapshot-shaped blob must always be safe to import"
        );
    }

    /// #1054 robustness — like the #792 guard, malformed bytes must
    /// degrade to `None` (let the real import surface the error), never
    /// panic.
    #[test]
    fn unreachable_update_in_blob_tolerates_malformed_bytes_1054() {
        use super::LoroEngine;

        let mut a = LoroEngine::with_peer_id("DEV-A").expect("A");
        a.apply_create_block("A-1", "content", "from A", None, 0)
            .expect("a-1");
        assert!(a.unreachable_update_in_blob(b"not a loro blob").is_none());
        assert!(a.unreachable_update_in_blob(&[]).is_none());
        let real = a.export_snapshot().expect("snap");
        let mut flipped = real.clone();
        if let Some(last) = flipped.last_mut() {
            *last ^= 0xFF;
        }
        assert!(
            a.unreachable_update_in_blob(&flipped).is_none(),
            "checksum-corrupt blob must not trip or panic the guard"
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
        engine
            .apply_delete_block(BLOCK_A, "2025-01-15T12:00:00Z")
            .expect("delete");
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
    fn read_deleted_at_round_trips_real_timestamp() {
        let mut engine = engine_with_block(BLOCK_A);
        // Alive block: no deleted_at slot → None.
        assert_eq!(
            engine.read_deleted_at(BLOCK_A).unwrap(),
            None,
            "an alive block must read back deleted_at = None"
        );
        // After delete, the real timestamp round-trips losslessly
        // (PEND-80 Phase 2 — was a fixed marker before). #668: production
        // writes epoch-ms decimal strings (`created_at.to_string()`), not
        // RFC-3339 — the fixture must match that wire format.
        engine
            .apply_delete_block(BLOCK_A, "1779701400000")
            .expect("delete");
        assert_eq!(
            engine.read_deleted_at(BLOCK_A).unwrap(),
            Some("1779701400000".to_string()),
            "the stored deleted_at timestamp must round-trip exactly"
        );
        // Restore clears the slot back to None.
        engine.apply_restore_block(BLOCK_A).expect("restore");
        assert_eq!(
            engine.read_deleted_at(BLOCK_A).unwrap(),
            None,
            "post-restore deleted_at must read back None"
        );
    }

    #[test]
    fn read_deleted_at_is_none_for_absent_block() {
        let engine = LoroEngine::new();
        assert_eq!(
            engine.read_deleted_at(BLOCK_A).unwrap(),
            None,
            "an absent block maps to None (not deleted), not an error"
        );
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
            engine.read_property_typed(BLOCK_A, "k").unwrap().is_none(),
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
        use super::PropertyValue;
        let mut engine = engine_with_block(BLOCK_A);
        engine
            .apply_set_property(BLOCK_A, "priority", Some("high"))
            .expect("set");
        assert_eq!(
            engine.read_property_typed(BLOCK_A, "priority").unwrap(),
            Some(PropertyValue::Str("high".to_string()))
        );
        engine
            .apply_delete_property(BLOCK_A, "priority")
            .expect("delete");
        // After delete the key must be entirely absent — distinct
        // from `apply_set_property(value=None)` which would leave
        // `Some(PropertyValue::Null)` (explicit-null clear).
        assert_eq!(
            engine.read_property_typed(BLOCK_A, "priority").unwrap(),
            None,
            "deleted property key must be absent (Ok(None)), not present-as-null"
        );
    }

    #[test]
    fn apply_delete_property_is_noop_for_missing_key() {
        use super::PropertyValue;
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
            engine.read_property_typed(BLOCK_A, "priority").unwrap(),
            Some(PropertyValue::Str("high".to_string()))
        );
    }

    #[test]
    fn apply_delete_property_distinct_from_set_property_null() {
        use super::PropertyValue;
        // `set_property(value=None)` writes an explicit Null at the
        // key — `read_property_typed` returns `Some(PropertyValue::Null)`.
        // `delete_property` removes the key entirely — `read_property_typed`
        // returns `None`.  This invariant is the reason both ops exist.
        let mut engine_clear = engine_with_block(BLOCK_A);
        engine_clear
            .apply_set_property(BLOCK_A, "k", None)
            .expect("clear");
        assert_eq!(
            engine_clear.read_property_typed(BLOCK_A, "k").unwrap(),
            Some(PropertyValue::Null),
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
            engine_delete.read_property_typed(BLOCK_A, "k").unwrap(),
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
            engine_null_then_delete
                .read_property_typed(BLOCK_A, "k")
                .unwrap(),
            None,
            "delete_property must remove key even when value is explicit-Null"
        );
    }

    // ── read_all_properties ───────────────────────────────────────────

    #[test]
    fn read_all_properties_returns_every_entry_including_explicit_null() {
        use super::PropertyValue;
        let mut engine = engine_with_block(BLOCK_A);
        engine
            .apply_set_property(BLOCK_A, "effort", Some("3"))
            .expect("set effort");
        engine
            .apply_set_property(BLOCK_A, "assignee", Some("alice"))
            .expect("set assignee");
        // An explicit-null clear must round-trip as `None`, distinct
        // from an absent key (which simply won't appear in the vec).
        engine
            .apply_set_property(BLOCK_A, "cleared", None)
            .expect("set cleared");

        let mut props = engine.read_all_properties_typed(BLOCK_A).expect("read all");
        props.sort_by(|a, b| a.0.cmp(&b.0));
        assert_eq!(
            props,
            vec![
                (
                    "assignee".to_string(),
                    PropertyValue::Str("alice".to_string())
                ),
                ("cleared".to_string(), PropertyValue::Null),
                ("effort".to_string(), PropertyValue::Str("3".to_string())),
            ],
        );
    }

    #[test]
    fn read_all_properties_for_block_without_props_is_empty() {
        let engine = engine_with_block(BLOCK_A);
        let props = engine.read_all_properties_typed(BLOCK_A).expect("read all");
        assert!(
            props.is_empty(),
            "block with no properties yields empty vec"
        );

        // A block_id that has never existed at all must also yield an
        // empty vec (no entry in the block_properties root).
        let fresh = LoroEngine::new();
        assert!(
            fresh
                .read_all_properties_typed(BLOCK_B)
                .expect("read all")
                .is_empty()
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

/// PEND-80 Phase 3 — LoroTree block hierarchy: tree-op behaviour, the
/// flat-map → tree snapshot migration, and concurrent-move convergence.
#[cfg(test)]
mod tree_tests {
    use super::*;

    /// Create A and B under root, C under A; verify the read surface
    /// derives parent/position from the tree + meta, then reparent C
    /// under B and re-verify.
    #[test]
    fn create_reparent_and_read() {
        let mut e = LoroEngine::new();
        e.apply_create_block("A", "content", "a-text", None, 1)
            .unwrap();
        e.apply_create_block("B", "content", "b-text", None, 2)
            .unwrap();
        e.apply_create_block("C", "content", "c-text", Some("A"), 1)
            .unwrap();

        let c = e.read_block("C").unwrap().unwrap();
        assert_eq!(c.parent_id.as_deref(), Some("A"));
        assert_eq!(c.position, 1);
        assert_eq!(c.content, "c-text");
        assert_eq!(c.block_type, "content");
        assert_eq!(e.read_parent("A").unwrap(), None, "A is a tree root");
        assert_eq!(e.list_children_walk("A").unwrap(), vec!["C".to_string()]);
        assert_eq!(e.list_children_walk("B").unwrap(), Vec::<String>::new());

        // Reparent C under B at a new position.
        e.apply_move_block("C", Some("B"), 7).unwrap();
        let c = e.read_block("C").unwrap().unwrap();
        assert_eq!(c.parent_id.as_deref(), Some("B"));
        assert_eq!(c.position, 1, "C is B's only child → dense rank 1");
        assert_eq!(e.list_children_walk("A").unwrap(), Vec::<String>::new());
        assert_eq!(e.list_children_walk("B").unwrap(), vec!["C".to_string()]);
    }

    /// `list_children_walk` returns live children in `(position, id)`
    /// order and excludes soft-deleted siblings — matching the SQL
    /// projection's `ORDER BY position` + `deleted_at IS NULL` filter.
    #[test]
    fn list_children_orders_by_position_excludes_deleted() {
        let mut e = LoroEngine::new();
        e.apply_create_block("P", "page", "p", None, 0).unwrap();
        e.apply_create_block("c2", "content", "", Some("P"), 20)
            .unwrap();
        e.apply_create_block("c1", "content", "", Some("P"), 10)
            .unwrap();
        e.apply_create_block("c3", "content", "", Some("P"), 30)
            .unwrap();
        e.apply_delete_block("c2", "2025-01-01T00:00:00Z").unwrap();

        assert_eq!(
            e.list_children_walk("P").unwrap(),
            vec!["c1".to_string(), "c3".to_string()],
        );
    }

    /// A cycle-forming reparent (move a node under its own descendant) is
    /// rejected deterministically by LoroTree and skipped (the apply
    /// succeeds, the parent is left unchanged) — the headline cycle-safety
    /// win over the old per-key-LWW flat map.
    #[test]
    fn cycle_move_is_rejected_and_skipped() {
        let mut e = LoroEngine::new();
        e.apply_create_block("A", "content", "", None, 0).unwrap();
        e.apply_create_block("B", "content", "", Some("A"), 0)
            .unwrap();
        // Move A under B (B is A's child) — would form a cycle.
        e.apply_move_block("A", Some("B"), 0).unwrap();
        // A stays a root; B stays under A.
        assert_eq!(e.read_parent("A").unwrap(), None);
        assert_eq!(e.read_parent("B").unwrap().as_deref(), Some("A"));
    }

    /// Soft-delete keeps the node in the tree (restore-able); purge removes
    /// it. `count_alive_blocks` reflects the soft-delete state.
    #[test]
    fn soft_delete_restore_purge_lifecycle() {
        let mut e = LoroEngine::new();
        e.apply_create_block("X", "content", "x", None, 0).unwrap();
        assert_eq!(e.count_alive_blocks().unwrap(), 1);

        e.apply_delete_block("X", "2025-06-02T00:00:00Z").unwrap();
        assert!(e.read_deleted("X").unwrap());
        assert_eq!(
            e.read_deleted_at("X").unwrap().as_deref(),
            Some("2025-06-02T00:00:00Z")
        );
        assert_eq!(e.count_alive_blocks().unwrap(), 0);
        // Still readable (node survives for restore + cascade derivation).
        assert!(e.read_block("X").unwrap().is_some());

        e.apply_restore_block("X").unwrap();
        assert!(!e.read_deleted("X").unwrap());
        assert_eq!(e.read_deleted_at("X").unwrap(), None);
        assert_eq!(e.count_alive_blocks().unwrap(), 1);

        e.apply_purge_block("X").unwrap();
        assert!(e.read_block("X").unwrap().is_none());
        assert_eq!(e.count_alive_blocks().unwrap(), 0);
        // Purge is idempotent.
        e.apply_purge_block("X").unwrap();
    }

    /// Re-applying `CreateBlock` for an existing id (boot-replay heal)
    /// updates in place rather than erroring or duplicating.
    #[test]
    fn create_is_idempotent_under_replay() {
        let mut e = LoroEngine::new();
        e.apply_create_block("P", "page", "p", None, 0).unwrap();
        e.apply_create_block("X", "content", "v1", Some("P"), 1)
            .unwrap();
        e.apply_create_block("X", "content", "v2", Some("P"), 1)
            .unwrap();
        let x = e.read_block("X").unwrap().unwrap();
        assert_eq!(x.content, "v2");
        assert_eq!(e.count_alive_blocks().unwrap(), 2);
        assert_eq!(e.list_children_walk("P").unwrap(), vec!["X".to_string()]);
    }
    /// Two devices concurrently reparent the same node to different
    /// parents; after exchanging snapshots both converge on the **same**
    /// parent (Loro's move-CRDT), not a per-key-LWW split. This is the
    /// core Phase-3 convergence guarantee.
    #[test]
    fn concurrent_reparent_converges() {
        let mut a = LoroEngine::with_peer_id("DEV-A").unwrap();
        let mut b = LoroEngine::with_peer_id("DEV-B").unwrap();

        // Seed a shared tree: two pages + one block under p1.
        a.apply_create_block("p1", "page", "P1", None, 0).unwrap();
        a.apply_create_block("p2", "page", "P2", None, 1).unwrap();
        a.apply_create_block("x", "content", "X", Some("p1"), 0)
            .unwrap();
        b.import(&a.export_snapshot().unwrap()).unwrap();
        assert_eq!(b.read_parent("x").unwrap().as_deref(), Some("p1"));

        // Concurrent divergent reparents.
        a.apply_move_block("x", Some("p2"), 0).unwrap();
        b.apply_move_block("x", Some("p1"), 0).unwrap();

        // Exchange full snapshots both ways.
        let a_bytes = a.export_snapshot().unwrap();
        let b_bytes = b.export_snapshot().unwrap();
        a.import(&b_bytes).unwrap();
        b.import(&a_bytes).unwrap();

        let pa = a.read_parent("x").unwrap();
        let pb = b.read_parent("x").unwrap();
        assert_eq!(pa, pb, "both peers must converge on the same parent for x");
        assert!(
            pa.as_deref() == Some("p1") || pa.as_deref() == Some("p2"),
            "converged parent is one of the two concurrent intents, got {pa:?}"
        );
    }

    /// A purge on one peer converges across a snapshot exchange: the block
    /// is gone on both sides.
    #[test]
    fn concurrent_purge_converges() {
        let mut a = LoroEngine::with_peer_id("DEV-A").unwrap();
        let mut b = LoroEngine::with_peer_id("DEV-B").unwrap();
        a.apply_create_block("root", "page", "R", None, 0).unwrap();
        a.apply_create_block("k", "content", "K", Some("root"), 0)
            .unwrap();
        b.import(&a.export_snapshot().unwrap()).unwrap();

        a.apply_purge_block("k").unwrap();
        b.import(&a.export_snapshot().unwrap()).unwrap();
        assert!(b.read_block("k").unwrap().is_none());
        assert_eq!(b.list_children_walk("root").unwrap(), Vec::<String>::new());
    }

    /// Purging a parent (the command emits ONE PurgeBlock op for the seed,
    /// SQL-cascades the rest) prunes the whole subtree from the engine read
    /// surface — a descendant is no longer readable as a stray live root
    /// block (review Finding 1). And it converges across a snapshot exchange.
    #[test]
    fn purge_parent_prunes_descendants_from_read_surface() {
        let mut a = LoroEngine::with_peer_id("DEV-A").unwrap();
        a.apply_create_block("p", "page", "P", None, 0).unwrap();
        a.apply_create_block("c", "content", "C", Some("p"), 0)
            .unwrap();
        a.apply_create_block("g", "content", "G", Some("c"), 0)
            .unwrap();
        assert_eq!(a.count_alive_blocks().unwrap(), 3);

        // Purge the seed only (mirrors the command's single-op cascade).
        a.apply_purge_block("p").unwrap();

        // Seed and both descendants are gone from the local read surface —
        // not lingering as orphaned live root blocks.
        assert!(a.read_block("p").unwrap().is_none());
        assert!(a.read_block("c").unwrap().is_none());
        assert!(a.read_block("g").unwrap().is_none());
        assert_eq!(a.count_alive_blocks().unwrap(), 0);

        // Converges to a peer that shares the same tree (imported from A
        // BEFORE the purge, so the nodes share TreeIDs) and then imports the
        // purge.
        let mut a2 = LoroEngine::with_peer_id("DEV-A").unwrap();
        a2.apply_create_block("p", "page", "P", None, 0).unwrap();
        a2.apply_create_block("c", "content", "C", Some("p"), 0)
            .unwrap();
        a2.apply_create_block("g", "content", "G", Some("c"), 0)
            .unwrap();
        let mut b = LoroEngine::with_peer_id("DEV-B").unwrap();
        b.import(&a2.export_snapshot().unwrap()).unwrap();
        assert_eq!(b.count_alive_blocks().unwrap(), 3);
        // A2 purges the seed; B imports the purge.
        a2.apply_purge_block("p").unwrap();
        b.import(&a2.export_snapshot().unwrap()).unwrap();
        assert!(b.read_block("c").unwrap().is_none());
        assert!(b.read_block("g").unwrap().is_none());
        assert_eq!(b.count_alive_blocks().unwrap(), 0);
    }

    /// A cyclic move skips the reparent; the node keeps its current parent and
    /// sibling slot (review Finding 5). Post-#400, `position` is the dense rank,
    /// so A stays at root rank 1 (B lives under A, not at root).
    #[test]
    fn cyclic_move_lands_position_not_reparent() {
        let mut e = LoroEngine::new();
        e.apply_create_block("A", "content", "", None, 5).unwrap();
        e.apply_create_block("B", "content", "", Some("A"), 0)
            .unwrap();
        // Move A under its own child B — cyclic, so the reparent is rejected.
        e.apply_move_block("A", Some("B"), 99).unwrap();
        let a = e.read_block("A").unwrap().unwrap();
        assert_eq!(a.parent_id, None, "reparent skipped (would be a cycle)");
        assert_eq!(a.position, 1, "A keeps its root slot (rank 1)");
    }

    /// A move whose `new_parent_id` is not (yet) in the engine must NOT
    /// detach the node to root — it keeps its current parent and slot, and the
    /// intent is recorded so a later create of the parent re-attaches it.
    #[test]
    fn move_to_unknown_parent_keeps_current_parent_then_attaches() {
        let mut e = LoroEngine::new();
        e.apply_create_block("P", "page", "", None, 0).unwrap();
        e.apply_create_block("X", "content", "", Some("P"), 1)
            .unwrap();
        // Move X under a parent that does not exist yet.
        e.apply_move_block("X", Some("ghost"), 9).unwrap();
        let x = e.read_block("X").unwrap().unwrap();
        assert_eq!(
            x.parent_id.as_deref(),
            Some("P"),
            "unknown parent must not detach X to root",
        );
        assert_eq!(x.position, 1, "X keeps its slot under P (rank 1)");

        // The parent appears → the pending intent re-attaches X.
        e.apply_create_block("ghost", "content", "", None, 0)
            .unwrap();
        assert_eq!(
            e.read_block("X").unwrap().unwrap().parent_id.as_deref(),
            Some("ghost"),
            "X re-attaches once its intended parent is created",
        );
    }
    /// `rebuild_index` (run on import) drops a stale `pending_parent` intent
    /// once the child is already attached to a real parent in the imported
    /// tree, so a later create of the (unrelated) intended parent cannot
    /// re-fire and mis-reparent it. Uses a single shared node (no block_id
    /// collision) moved by a peer — the realistic way the intent resolves.
    #[test]
    fn import_reconciles_stale_pending_parent() {
        // E creates `p`, then `c` referencing an absent parent `ghost` →
        // `c` is parked at root and pending_parent[c] = ghost.
        let mut e = LoroEngine::with_peer_id("DEV-E").unwrap();
        e.apply_create_block("p", "page", "P", None, 0).unwrap();
        e.apply_create_block("c", "content", "C", Some("ghost"), 0)
            .unwrap();
        assert_eq!(e.read_parent("c").unwrap(), None, "c parked at root");

        // Peer F shares E's tree (same TreeIDs) and moves `c` under `p`.
        let mut f = LoroEngine::with_peer_id("DEV-F").unwrap();
        f.import(&e.export_snapshot().unwrap()).unwrap();
        f.apply_move_block("c", Some("p"), 0).unwrap();

        // E imports F's move → `c` is now under the real parent `p`, so the
        // stale `ghost` intent must be reconciled away by rebuild_index.
        e.import(&f.export_snapshot().unwrap()).unwrap();
        assert_eq!(e.read_parent("c").unwrap().as_deref(), Some("p"));

        // Creating `ghost` now must NOT steal `c` back (intent was dropped).
        e.apply_create_block("ghost", "content", "G", None, 9)
            .unwrap();
        assert_eq!(
            e.read_parent("c").unwrap().as_deref(),
            Some("p"),
            "reconciled pending intent must not re-fire",
        );
    }

    /// #332: a persisted v1 (flat-map) snapshot is now rejected loudly on
    /// import — the v1→v2 migration was retired, so a stray v1 snapshot must
    /// error with a clear message rather than silently yield an empty tree.
    #[test]
    fn import_rejects_legacy_v1_flat_map_snapshot() {
        // Hand-build a raw doc carrying the deprecated v1 `blocks` flat map.
        let doc = LoroDoc::new();
        let blocks: LoroMap = doc.get_map(LEGACY_BLOCKS_ROOT);
        let bm: LoroMap = blocks.insert_container("k", LoroMap::new()).unwrap();
        bm.insert(FIELD_BLOCK_TYPE, LoroValue::from("content"))
            .unwrap();
        bm.insert(FIELD_POSITION, LoroValue::from(0_i64)).unwrap();
        doc.commit();
        let bytes = doc.export(ExportMode::Snapshot).unwrap();

        let mut e = LoroEngine::new();
        match e.import(&bytes).unwrap_err() {
            AppError::Validation(m) => assert!(
                m.contains("v1") && m.contains("flat-map"),
                "expected a v1-rejection message, got: {m}"
            ),
            other => panic!("expected Validation error, got {other:?}"),
        }

        // The guard is not a false-positive: a clean v2 snapshot imports fine.
        let mut a = LoroEngine::with_peer_id("DEV-A").unwrap();
        a.apply_create_block("x", "content", "X", None, 0).unwrap();
        let mut b = LoroEngine::new();
        b.import(&a.export_snapshot().unwrap()).unwrap();
        assert_eq!(b.count_alive_blocks().unwrap(), 1);
    }

    // ── #400 new index-based apply path (apply_create_block_at / _move_block_to) ──

    /// `apply_create_block_at` inserts at the given 0-based slot among siblings,
    /// and the read-back `position` is the dense 1-based rank.
    #[test]
    fn create_block_at_inserts_at_slot() {
        let mut e = LoroEngine::new();
        e.apply_create_block_at("P", "page", "P", None, 0).unwrap();
        // Append A, then B; insert C at slot 1 (between A and B).
        e.apply_create_block_at("A", "content", "", Some("P"), 0)
            .unwrap();
        e.apply_create_block_at("B", "content", "", Some("P"), 1)
            .unwrap();
        e.apply_create_block_at("C", "content", "", Some("P"), 1)
            .unwrap();
        assert_eq!(e.list_children_walk("P").unwrap(), vec!["A", "C", "B"]);
        assert_eq!(e.read_block("A").unwrap().unwrap().position, 1);
        assert_eq!(e.read_block("C").unwrap().unwrap().position, 2);
        assert_eq!(e.read_block("B").unwrap().unwrap().position, 3);
    }

    /// `apply_move_block_to` re-places at a slot, including slot 0 ("to top" /
    /// "first child") which the pre-#400 scheme rejected.
    #[test]
    fn move_block_to_slot_zero_is_valid() {
        let mut e = LoroEngine::new();
        e.apply_create_block_at("P", "page", "P", None, 0).unwrap();
        for (i, id) in ["A", "B", "C"].iter().enumerate() {
            e.apply_create_block_at(id, "content", "", Some("P"), i)
                .unwrap();
        }
        // Move C to the top (slot 0) → [C, A, B].
        e.apply_move_block_to("C", Some("P"), 0).unwrap();
        assert_eq!(e.list_children_walk("P").unwrap(), vec!["C", "A", "B"]);
        // Move A up between C and B (slot 1) → [C, A, B] unchanged… move B to 1.
        e.apply_move_block_to("B", Some("P"), 1).unwrap();
        assert_eq!(e.list_children_walk("P").unwrap(), vec!["C", "B", "A"]);
    }

    /// The frontend sends a **live**-sibling slot; a soft-deleted sibling
    /// ordered before the drop point must NOT shift the placement (#400 review).
    /// CREATE path (`exclude = None`: the new node counts no live sibling out).
    #[test]
    fn create_block_at_live_slot_skips_soft_deleted_sibling() {
        let mut e = LoroEngine::new();
        e.apply_create_block_at("P", "page", "P", None, 0).unwrap();
        for (i, id) in ["A", "B", "C"].iter().enumerate() {
            e.apply_create_block_at(id, "content", "", Some("P"), i)
                .unwrap();
        }
        // Soft-delete A (the first sibling); live order is now [B, C].
        e.apply_delete_block("A", "2026-06-04T00:00:00Z").unwrap();
        // Create X and place it at LIVE slot 1 (after B, before C). With A
        // (deleted) still occupying tree slot 0, a naive tree-slot interpretation
        // would land X after A → wrong live order. The live-slot translation
        // makes it land after B among the live siblings.
        e.apply_create_block_at("X", "content", "", Some("P"), 1)
            .unwrap();
        // Full tree order keeps the tombstone; live order is what users see.
        assert_eq!(e.list_children_walk("P").unwrap(), vec!["B", "X", "C"]);
    }

    /// MOVE path of the live-slot translation (`exclude = Some(moved node)`):
    /// the harder branch that must skip BOTH the tombstone and the moved node
    /// itself when counting live slots (#400 review).
    #[test]
    fn move_block_to_live_slot_skips_soft_deleted_sibling() {
        let mut e = LoroEngine::new();
        e.apply_create_block_at("P", "page", "P", None, 0).unwrap();
        for (i, id) in ["A", "B", "C", "D"].iter().enumerate() {
            e.apply_create_block_at(id, "content", "", Some("P"), i)
                .unwrap();
        }
        // Soft-delete A (first sibling). Live order: [B, C, D].
        e.apply_delete_block("A", "2026-06-04T00:00:00Z").unwrap();
        // Move D to LIVE slot 1 — among the OTHER live children [B, C], slot 1
        // is after B / before C. The exclude branch must skip the tombstone A
        // AND the moved node D, landing D between B and C.
        e.apply_move_block_to("D", Some("P"), 1).unwrap();
        assert_eq!(e.list_children_walk("P").unwrap(), vec!["B", "D", "C"]);
    }

    /// A genuine pre-#400 doc (legacy `position` meta, NO marker, tree order
    /// DISAGREEING with position order) is reordered to the old
    /// `ORDER BY position ASC, id ASC` by the migration. This actually drives
    /// the reorder loop, unlike a doc built via the legacy apply path (which
    /// already inserts in position order, leaving nothing to reorder).
    #[test]
    fn migrate_legacy_sibling_order_reorders_divergent_doc() {
        let mut e = LoroEngine::new();
        e.apply_create_block_at("P", "page", "P", None, 0).unwrap();
        // Tree (fractional) order is A, B, C.
        for (i, id) in ["A", "B", "C"].iter().enumerate() {
            e.apply_create_block_at(id, "content", "", Some("P"), i)
                .unwrap();
        }
        // Forge legacy positions that DISAGREE with tree order: A=3, B=2, C=1
        // → position order is C, B, A. Also drops the scheme marker.
        e.force_legacy_scheme_for_test(&[("A", 3), ("B", 2), ("C", 1)]);
        assert_eq!(e.sibling_order_version(), 0, "marker must be cleared");

        e.migrate_legacy_sibling_order_if_needed().unwrap();

        // Tree is now reordered to position order, and the marker is stamped.
        assert_eq!(e.list_children_walk("P").unwrap(), vec!["C", "B", "A"]);
        assert_eq!(e.sibling_order_version(), SIBLING_ORDER_VERSION);

        // Idempotent: a second run (marker set) is a no-op.
        e.migrate_legacy_sibling_order_if_needed().unwrap();
        assert_eq!(e.list_children_walk("P").unwrap(), vec!["C", "B", "A"]);
    }

    /// `legacy_slot`'s `(position, id)` tie-break reproduces the pre-#400
    /// `ORDER BY position ASC, id ASC`: two siblings sharing a position order by
    /// ascending block-id.
    #[test]
    fn migrate_legacy_sibling_order_tie_breaks_by_id() {
        let mut e = LoroEngine::new();
        e.apply_create_block_at("P", "page", "P", None, 0).unwrap();
        // Insert in non-id order Z, A, M so tree order != id order.
        for (i, id) in ["Z", "A", "M"].iter().enumerate() {
            e.apply_create_block_at(id, "content", "", Some("P"), i)
                .unwrap();
        }
        // All three share position 5 → migration must tie-break by id: A, M, Z.
        e.force_legacy_scheme_for_test(&[("Z", 5), ("A", 5), ("M", 5)]);
        e.migrate_legacy_sibling_order_if_needed().unwrap();
        assert_eq!(e.list_children_walk("P").unwrap(), vec!["A", "M", "Z"]);
    }

    /// jitter=0 soundness: two peers concurrently reordering siblings (including
    /// to the SAME slot) converge to an identical sibling order after a snapshot
    /// exchange — equal fractional indices tie-break deterministically by idlp.
    /// This is the property the `FRACTIONAL_INDEX_JITTER` docstring rests on.
    #[test]
    fn concurrent_reorder_converges() {
        let mut a = LoroEngine::with_peer_id("DEV-A").unwrap();
        let mut b = LoroEngine::with_peer_id("DEV-B").unwrap();
        a.apply_create_block_at("P", "page", "P", None, 0).unwrap();
        for (i, id) in ["A", "B", "C"].iter().enumerate() {
            a.apply_create_block_at(id, "content", "", Some("P"), i)
                .unwrap();
        }
        b.import(&a.export_snapshot().unwrap()).unwrap();
        assert_eq!(b.list_children_walk("P").unwrap(), vec!["A", "B", "C"]);

        // Concurrent reorders, both targeting slot 0 of the same parent.
        a.apply_move_block_to("C", Some("P"), 0).unwrap();
        b.apply_move_block_to("A", Some("P"), 0).unwrap();

        // Exchange full snapshots both ways.
        let a_bytes = a.export_snapshot().unwrap();
        let b_bytes = b.export_snapshot().unwrap();
        a.import(&b_bytes).unwrap();
        b.import(&a_bytes).unwrap();

        let oa = a.list_children_walk("P").unwrap();
        let ob = b.list_children_walk("P").unwrap();
        assert_eq!(oa, ob, "both peers must converge on one sibling order");
        // No loss: all three children survive the concurrent reorder.
        let mut sorted = oa.clone();
        sorted.sort();
        assert_eq!(sorted, vec!["A", "B", "C"]);
    }
}

// ---------------------------------------------------------------------------
// #622 — tag-set convergence tests.
//
// Repro shape (pre-fix): the per-block tag container was a LoroList and
// `apply_add_tag` deduped with a local check-then-push, which is NOT
// convergent — two peers concurrently adding the same tag each pass the
// local check, and the list CRDT keeps BOTH concurrent inserts after
// merge. `apply_remove_tag` deleted only the FIRST occurrence, so one
// duplicate survived removal and `reproject_block_tags_from_engine`
// resurrected the tag in SQL on the next sync pull.
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tag_convergence_tests {
    use super::LoroEngine;

    const BLOCK_A: &str = "01HZ0000000000000000000B01";
    const BLOCK_B: &str = "01HZ0000000000000000000B02";
    const TAG_X: &str = "01HZ0000000000000000000T0X";
    const TAG_Y: &str = "01HZ0000000000000000000T0Y";

    /// Full-snapshot one-way sync helper (test fixture shape used across
    /// this file's convergence tests).
    fn sync(from: &LoroEngine, to: &mut LoroEngine) {
        to.import(&from.export_snapshot().expect("export"))
            .expect("import");
    }

    /// Two peers share a block that already carries one tag (so the
    /// per-block tag container itself is shared, not racing on creation),
    /// then concurrently AddTag the SAME tag, merge, and one peer removes
    /// it. The tag must not survive removal on either peer — that
    /// survivor is what `reproject_block_tags_from_engine` would
    /// authoritatively re-insert into SQL (the #622 resurrection).
    #[test]
    fn concurrent_add_tag_then_remove_does_not_resurrect() {
        let mut a = LoroEngine::with_peer_id("device-622-a").expect("peer a");
        let mut b = LoroEngine::with_peer_id("device-622-b").expect("peer b");

        a.apply_create_block(BLOCK_A, "content", "hello", None, 0)
            .expect("create block");
        a.apply_create_block(TAG_X, "tag", "Project", None, 1)
            .expect("create tag X");
        a.apply_create_block(TAG_Y, "tag", "Other", None, 2)
            .expect("create tag Y");
        // Establish the shared per-block tag container BEFORE the race —
        // otherwise the peers race on container creation at the map slot
        // (a different, pre-existing loro pitfall) instead of on element
        // insertion within one shared container.
        a.apply_add_tag(BLOCK_A, TAG_Y).expect("seed tag Y");
        sync(&a, &mut b);

        // Concurrent AddTag(X) on both peers; each local dedupe check
        // passes because neither has seen the other's insert yet.
        a.apply_add_tag(BLOCK_A, TAG_X).expect("a adds X");
        b.apply_add_tag(BLOCK_A, TAG_X).expect("b adds X");

        // Cross-merge the concurrent states.
        let a_bytes = a.export_snapshot().expect("export a");
        let b_bytes = b.export_snapshot().expect("export b");
        a.import(&b_bytes).expect("a imports b");
        b.import(&a_bytes).expect("b imports a");

        for (label, engine) in [("a", &a), ("b", &b)] {
            let tags = engine.read_tags(BLOCK_A).expect("read tags");
            let x_count = tags.iter().filter(|t| *t == TAG_X).count();
            assert_eq!(
                x_count, 1,
                "peer {label}: concurrent AddTag of the same tag must \
                 converge to ONE element, got {tags:?}"
            );
        }

        // Remove the tag on one peer and propagate.
        a.apply_remove_tag(BLOCK_A, TAG_X).expect("a removes X");
        assert!(
            !a.read_tags(BLOCK_A)
                .expect("read a")
                .contains(&TAG_X.to_string()),
            "peer a: removed tag must be gone locally"
        );
        sync(&a, &mut b);
        for (label, engine) in [("a", &a), ("b", &b)] {
            let tags = engine.read_tags(BLOCK_A).expect("read tags");
            assert_eq!(
                tags,
                vec![TAG_Y.to_string()],
                "peer {label}: RemoveTag must not leave a resurrectable \
                 occurrence behind"
            );
        }
    }

    /// Legacy-list race fixed in place: duplicates created by concurrent
    /// pushes into a shared legacy LoroList must (a) dedupe on read and
    /// (b) be removed wholesale by `apply_remove_tag`, on both peers.
    #[test]
    fn legacy_list_concurrent_duplicates_dedupe_and_remove_all() {
        let mut a = LoroEngine::with_peer_id("device-622-c").expect("peer a");
        let mut b = LoroEngine::with_peer_id("device-622-d").expect("peer b");

        a.apply_create_block(BLOCK_A, "content", "hello", None, 0)
            .expect("create block");
        // Seed an (empty) legacy LoroList container in the tag slot —
        // simulates a doc written before the #622 fix.
        a.seed_legacy_tag_list(BLOCK_A, &[]).expect("seed legacy");
        sync(&a, &mut b);

        // Concurrent adds land in the SHARED legacy list on both peers;
        // the local contains-check passes on each, so after merge the
        // list holds two TAG_X elements (list CRDTs keep both inserts).
        a.apply_add_tag(BLOCK_A, TAG_X).expect("a adds X");
        b.apply_add_tag(BLOCK_A, TAG_X).expect("b adds X");
        let a_bytes = a.export_snapshot().expect("export a");
        let b_bytes = b.export_snapshot().expect("export b");
        a.import(&b_bytes).expect("a imports b");
        b.import(&a_bytes).expect("b imports a");

        // (a) read-side dedupe: projection input must not carry dupes.
        for (label, engine) in [("a", &a), ("b", &b)] {
            let tags = engine.read_tags(BLOCK_A).expect("read tags");
            assert_eq!(
                tags,
                vec![TAG_X.to_string()],
                "peer {label}: legacy duplicate elements must dedupe on read"
            );
        }

        // (b) remove-all: removal must delete EVERY occurrence so no
        // element survives to resurrect the tag on reprojection.
        a.apply_remove_tag(BLOCK_A, TAG_X).expect("a removes X");
        sync(&a, &mut b);
        for (label, engine) in [("a", &a), ("b", &b)] {
            let tags = engine.read_tags(BLOCK_A).expect("read tags");
            assert!(
                tags.is_empty(),
                "peer {label}: remove must clear all occurrences, got {tags:?}"
            );
        }
    }

    /// A persisted doc whose legacy list ALREADY contains duplicate
    /// elements (written by pre-fix code) must project correctly after
    /// the fix: dedupe on read, remove-all on removal, surviving an
    /// export/import round trip.
    #[test]
    fn legacy_persisted_duplicates_project_and_remove_cleanly() {
        let mut a = LoroEngine::with_peer_id("device-622-e").expect("peer a");
        a.apply_create_block(BLOCK_A, "content", "hello", None, 0)
            .expect("create block");
        a.seed_legacy_tag_list(BLOCK_A, &[TAG_X, TAG_X, TAG_Y])
            .expect("seed legacy duplicates");

        // Round-trip through persistence bytes — the shape a vault
        // snapshot written by pre-fix code would arrive in.
        let mut fresh = LoroEngine::with_peer_id("device-622-f").expect("peer f");
        fresh
            .import(&a.export_snapshot().expect("export"))
            .expect("import legacy doc");

        assert_eq!(
            fresh.read_tags(BLOCK_A).expect("read tags"),
            vec![TAG_X.to_string(), TAG_Y.to_string()],
            "duplicate legacy elements must flatten on read (first \
             occurrence order)"
        );

        fresh.apply_remove_tag(BLOCK_A, TAG_X).expect("remove X");
        assert_eq!(
            fresh.read_tags(BLOCK_A).expect("read tags"),
            vec![TAG_Y.to_string()],
            "remove must take out BOTH legacy occurrences"
        );

        // Adding to a legacy-list block keeps working (slot stays a
        // list; in-place semantics, no structural migration pre-#709
        // Phase 2).
        fresh.apply_add_tag(BLOCK_A, TAG_X).expect("re-add X");
        fresh
            .apply_add_tag(BLOCK_A, TAG_X)
            .expect("dup re-add is no-op");
        assert_eq!(
            fresh.read_tags(BLOCK_A).expect("read tags"),
            vec![TAG_Y.to_string(), TAG_X.to_string()],
        );
    }

    /// Name-keyed identity (#709 Phase 1): the map key is the
    /// NORMALIZED tag name, so peers whose tag blocks spell the name
    /// with different case/composition still converge to one entry.
    /// Here one engine holds the tag block (key = normalized name) and
    /// both add the same tag_id concurrently — same key, one survivor.
    #[test]
    fn map_key_is_normalized_tag_name() {
        let mut a = LoroEngine::with_peer_id("device-622-g").expect("peer a");
        a.apply_create_block(BLOCK_A, "content", "hello", None, 0)
            .expect("create block");
        // Tag name in NFD with mixed case; key must be the NFC
        // lowercase form.
        a.apply_create_block(TAG_X, "tag", "Re\u{0301}ussi", None, 1)
            .expect("create tag");
        a.apply_add_tag(BLOCK_A, TAG_X).expect("add tag");

        let tags_root: super::LoroMap = a.doc.get_map(super::BLOCK_TAGS_ROOT);
        let slot = tags_root
            .get(BLOCK_A)
            .expect("slot exists")
            .into_container()
            .expect("container")
            .into_map()
            .expect("map-shaped slot (post-#622 write path)");
        let keys: Vec<String> = slot.keys().map(|k| k.to_string()).collect();
        assert_eq!(
            keys,
            vec!["r\u{e9}ussi".to_string()],
            "map key must be the NFC + lowercased tag name"
        );
        assert_eq!(
            a.read_tags(BLOCK_A).expect("read tags"),
            vec![TAG_X.to_string()],
            "read must surface the tag_id value, not the name key"
        );
    }

    /// When the tag block is NOT present in the doc (cross-space tag,
    /// out-of-order replay), the key degrades to the raw tag_id — set
    /// semantics still hold and removal still clears it.
    #[test]
    fn unresolvable_tag_id_degrades_to_id_key() {
        let mut a = LoroEngine::with_peer_id("device-622-h").expect("peer a");
        a.apply_create_block(BLOCK_A, "content", "hello", None, 0)
            .expect("create block");
        // TAG_X block never created in this doc.
        a.apply_add_tag(BLOCK_A, TAG_X)
            .expect("add unresolvable tag");
        a.apply_add_tag(BLOCK_A, TAG_X).expect("idempotent re-add");
        assert_eq!(
            a.read_tags(BLOCK_A).expect("read tags"),
            vec![TAG_X.to_string()]
        );
        a.apply_remove_tag(BLOCK_A, TAG_X).expect("remove");
        assert!(a.read_tags(BLOCK_A).expect("read tags").is_empty());
    }

    /// Rename staleness (pre-#709-Phase-2 hazard): add tag → rename the
    /// tag block → add again re-keys the same tag_id under the new
    /// name. Reads must dedupe the doubled value and removal must sweep
    /// BOTH keys — a key-only delete would leave the stale-name entry
    /// to resurrect the tag on reprojection.
    #[test]
    fn rename_then_readd_dedupes_and_remove_sweeps_stale_key() {
        let mut a = LoroEngine::with_peer_id("device-622-i").expect("peer a");
        a.apply_create_block(BLOCK_A, "content", "hello", None, 0)
            .expect("create block");
        a.apply_create_block(TAG_X, "tag", "foo", None, 1)
            .expect("create tag");
        a.apply_add_tag(BLOCK_A, TAG_X).expect("add under 'foo'");

        // Rename the tag block: "foo" -> "bar".
        a.apply_edit_content(TAG_X, 0, 3, "bar")
            .expect("rename tag");
        a.apply_add_tag(BLOCK_A, TAG_X).expect("re-add under 'bar'");

        assert_eq!(
            a.read_tags(BLOCK_A).expect("read tags"),
            vec![TAG_X.to_string()],
            "same tag_id under stale + current name keys must read as one"
        );

        a.apply_remove_tag(BLOCK_A, TAG_X).expect("remove");
        assert!(
            a.read_tags(BLOCK_A).expect("read tags").is_empty(),
            "removal must sweep the stale-name key too — no resurrection"
        );
    }

    /// Two DISTINCT tag blocks carrying the same name coalesce to one
    /// entry (per-key LWW) — name IS the identity (#709; the engine-
    /// level shape of the #626 same-name problem). The later add wins.
    #[test]
    fn same_name_distinct_tag_ids_coalesce_by_name() {
        let mut a = LoroEngine::with_peer_id("device-622-j").expect("peer a");
        a.apply_create_block(BLOCK_A, "content", "hello", None, 0)
            .expect("create block");
        a.apply_create_block(TAG_X, "tag", "Project", None, 1)
            .expect("create tag X");
        a.apply_create_block(TAG_Y, "tag", "pROJECT", None, 2)
            .expect("create tag Y (same name, different case)");

        a.apply_add_tag(BLOCK_A, TAG_X).expect("add X");
        a.apply_add_tag(BLOCK_A, TAG_Y)
            .expect("add Y overwrites by name");

        assert_eq!(
            a.read_tags(BLOCK_A).expect("read tags"),
            vec![TAG_Y.to_string()],
            "same normalized name must coalesce to the latest tag_id"
        );
    }

    /// #845: rename + old-name reuse must NOT overwrite the renamed tag's
    /// block association. Distinct from
    /// `same_name_distinct_tag_ids_coalesce_by_name`: there both tags
    /// genuinely carry the same name *now*, so coalescing is the #709
    /// end-state. Here tag1's CURRENT name is "bar" — its entry only sits
    /// under the stale "foo" key because the rename left it there. A new
    /// tag2 named "foo" added to the SAME block would (pre-fix) insert at
    /// key "foo" and clobber tag1's still-valid association, which the
    /// next reprojection silently deletes from SQL. The add path must be
    /// rename-aware: re-key tag1 to its current name first, so both
    /// associations survive.
    #[test]
    fn rename_then_old_name_reuse_keeps_renamed_tags_association() {
        let mut a = LoroEngine::with_peer_id("device-845-a").expect("peer a");
        a.apply_create_block(BLOCK_A, "content", "hello", None, 0)
            .expect("create block A");
        a.apply_create_block(BLOCK_B, "content", "world", None, 1)
            .expect("create block B");

        // tag1 named "foo" on block A.
        a.apply_create_block(TAG_X, "tag", "foo", None, 2)
            .expect("create tag1 'foo'");
        a.apply_add_tag(BLOCK_A, TAG_X)
            .expect("tag block A with #foo");

        // Rename tag1 'foo' -> 'bar'. block A now logically carries #bar
        // (tag1), but the engine map still holds the stale key 'foo' -> tag1.
        a.apply_edit_content(TAG_X, 0, 3, "bar")
            .expect("rename tag1 foo->bar");

        // A NEW tag2 reusing the old name 'foo' is created and added to a
        // DIFFERENT block. The collision target is block A's stale 'foo'
        // key when tag2 is later added there.
        a.apply_create_block(TAG_Y, "tag", "foo", None, 3)
            .expect("create tag2 'foo' (reuses old name)");
        a.apply_add_tag(BLOCK_B, TAG_Y)
            .expect("tag block B with new #foo");

        // Now add the new #foo (tag2) to block A as well — its name key is
        // 'foo', colliding with tag1's stale 'foo' entry on block A.
        a.apply_add_tag(BLOCK_A, TAG_Y)
            .expect("add new #foo to block A");

        // block A must still resolve to the renamed tag1 (#bar) AND carry
        // the new tag2 (#foo) — tag1's association must NOT be overwritten.
        let mut tags_a = a.read_tags(BLOCK_A).expect("read tags A");
        tags_a.sort();
        let mut want = vec![TAG_X.to_string(), TAG_Y.to_string()];
        want.sort();
        assert_eq!(
            tags_a, want,
            "block A must retain the renamed tag (tag1/#bar) after a new \
             tag reusing the old name (tag2/#foo) is added — got {tags_a:?}"
        );
    }
}
