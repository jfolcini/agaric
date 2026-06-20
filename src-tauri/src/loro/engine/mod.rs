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
///
/// #1584: this version is now *stamped* into [`ENGINE_META_ROOT`] under
/// [`FIELD_FORMAT_VERSION`] on export and *checked* on import, so a
/// well-formed-but-newer-than-supported Loro blob is rejected up front rather
/// than trusted and left to fail downstream on the projection path. See
/// [`LoroEngine::stamp_format_version`] / [`LoroEngine::reject_unknown_format_version`].
pub const ENGINE_FORMAT_VERSION: u32 = 2;
/// Key under [`ENGINE_META_ROOT`] recording the engine format version a doc was
/// written under (#1584). Stored as a Loro `I64`. Absent ⇒ a pre-#1584 export
/// (legacy-unstamped); such docs are *accepted* — see
/// [`LoroEngine::reject_unknown_format_version`] for the backward-compat reasoning.
const FIELD_FORMAT_VERSION: &str = "format_version";

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
            // `PropertyValue` has no integer variant — i64 payloads are stored
            // as `Num(f64)`. This is exact for every integer in the f64-safe
            // range `[-(2^53), 2^53]`, which covers the date-ms / priority ints
            // actually written today. Larger magnitudes (a future nanosecond
            // timestamp, 64-bit id, or large counter) silently lose precision
            // in the cast, so guard with a loud warning to make the truncation
            // observable rather than corrupting data invisibly. Reworking this
            // into a lossless `PropertyValue::Int(i64)` variant (the eventual
            // fix) touches every match arm, the SQL projection, and the wire
            // types, so it is deliberately left as future work (issue #1542).
            LoroValue::I64(i) => {
                // 2^53 is the largest magnitude for which every integer is
                // representable exactly as f64; `unsigned_abs` avoids the
                // `i64::MIN` overflow that plain `abs()` would hit.
                if i.unsigned_abs() > (1u64 << 53) {
                    tracing::warn!(
                        value = i,
                        "loro: i64 property value exceeds the f64-exact integer \
                         range (|i| > 2^53); precision is lost converting to \
                         PropertyValue::Num (see #1542)"
                    );
                }
                Ok(PropertyValue::Num(i as f64))
            }
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
}

// -----------------------------------------------------------------
// Cohesive `impl LoroEngine` submodules (#1262). Rust allows the
// inherent impl to be split across files in one module; each submodule
// below holds one responsibility cluster and shares this module's
// private struct fields, consts, and free helpers via `use super::*`.
// -----------------------------------------------------------------

/// Tree slot/position mechanics, the `block_id -> TreeID` index, and the
/// pending-parent reconciler (PEND-80 Phase 3).
mod tree;

/// One-time legacy (pre-#400) sibling-order migration cluster.
mod migration;

/// Op-application handlers (`apply_*` + their shared create/move impls).
mod apply;

/// Read-back getters and queries (`read_*`, `list_children_walk`,
/// `count_alive_blocks`).
mod reads;

/// Snapshot import/export I/O and the legacy-v1 rejection (#332).
mod snapshot;

/// Sync-update generation + inbound-blob inspection (#792 / #1054).
mod sync;

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

    // #1542: `from_loro` casts `LoroValue::I64` to `Num(f64)`, which is exact
    // only inside the f64-safe integer range `[-(2^53), 2^53]`. The conversion
    // is kept (a lossless `Int` variant is future work), but magnitudes beyond
    // that range must emit a loud `warn!` so the precision loss is observable
    // instead of silent. The in-range value below also pins that ordinary
    // date-ms / priority ints stay quiet.
    #[test]
    fn from_loro_i64_warns_only_beyond_f64_exact_range() {
        use super::{AppError, LoroValue, PropertyValue};
        use tracing_subscriber::layer::SubscriberExt;

        #[derive(Clone, Default)]
        struct LogBufWriter(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);
        impl std::io::Write for LogBufWriter {
            fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(buf);
                Ok(buf.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for LogBufWriter {
            type Writer = LogBufWriter;
            fn make_writer(&'a self) -> Self::Writer {
                self.clone()
            }
        }

        let capture = |v: LoroValue| -> (Result<PropertyValue, AppError>, String) {
            let writer = LogBufWriter::default();
            let subscriber = tracing_subscriber::registry().with(
                tracing_subscriber::fmt::layer()
                    .with_writer(writer.clone())
                    .with_ansi(false)
                    .with_level(true)
                    .with_target(false),
            );
            let result = {
                let _guard = tracing::subscriber::set_default(subscriber);
                PropertyValue::from_loro(v)
            };
            let logs = String::from_utf8_lossy(&writer.0.lock().unwrap()).into_owned();
            (result, logs)
        };

        // Just past the boundary: 2^53 + 1 cannot be represented exactly as
        // f64 — the guard must fire a WARN and the value still maps to `Num`.
        let big = (1i64 << 53) + 1;
        let (result, logs) = capture(LoroValue::I64(big));
        assert_eq!(result.unwrap(), PropertyValue::Num(big as f64));
        assert!(
            logs.contains("WARN") && logs.contains("2^53"),
            "i64 beyond the f64-exact range must emit a precision-loss WARN, captured: {logs:?}"
        );

        // Negative side of the boundary likewise warns (and `i64::MIN`, which
        // plain `abs()` could not handle, must not panic).
        let (_, neg_logs) = capture(LoroValue::I64(i64::MIN));
        assert!(
            neg_logs.contains("WARN"),
            "large-magnitude negative i64 must also warn, captured: {neg_logs:?}"
        );

        // A representative in-range date-ms value (and the exact +/-2^53
        // boundary, which IS f64-exact) must convert silently — no WARN.
        for in_range in [1_750_000_000_000i64, 1i64 << 53, -(1i64 << 53), 3] {
            let (result, logs) = capture(LoroValue::I64(in_range));
            assert_eq!(result.unwrap(), PropertyValue::Num(in_range as f64));
            assert!(
                !logs.contains("WARN"),
                "in-range i64 {in_range} must convert without a WARN, captured: {logs:?}"
            );
        }
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

    /// #1585: a parent with NO legacy `position` on any child is a pure
    /// new-scheme subtree — the migration must leave its fractional order
    /// untouched, even when some *other* parent in the doc carries legacy
    /// positions (which still triggers the doc-level migration pass).
    #[test]
    fn migrate_legacy_sibling_order_leaves_no_legacy_parent_untouched() {
        let mut e = LoroEngine::new();
        e.apply_create_block_at("P", "page", "P", None, 0).unwrap();
        // New-scheme parent Q, whose children carry no position meta.
        e.apply_create_block_at("Q", "page", "Q", None, 1).unwrap();
        for (i, id) in ["X", "Y", "Z"].iter().enumerate() {
            e.apply_create_block_at(id, "content", "", Some("Q"), i)
                .unwrap();
        }
        // A legacy child elsewhere (under P) forces the migration to run, but
        // Q's order must be preserved exactly.
        e.apply_create_block_at("L", "content", "", Some("P"), 0)
            .unwrap();
        e.force_legacy_scheme_for_test(&[("L", 7)]);
        assert_eq!(e.sibling_order_version(), 0, "marker must be cleared");

        e.migrate_legacy_sibling_order_if_needed().unwrap();

        // Q untouched: position-less children keep their fractional order.
        assert_eq!(e.list_children_walk("Q").unwrap(), vec!["X", "Y", "Z"]);
        assert_eq!(e.sibling_order_version(), SIBLING_ORDER_VERSION);
    }

    /// #1585 core bug: a parent that MIXES legacy position-bearing and
    /// position-less siblings must order the legacy nodes by their position
    /// while the position-less nodes KEEP their existing relative fractional
    /// order — they must NOT all be dumped at the end (the old
    /// `unwrap_or(i64::MAX)` behaviour, which this test pins against).
    #[test]
    fn migrate_legacy_sibling_order_mixed_parent_preserves_position_less_order() {
        let mut e = LoroEngine::new();
        e.apply_create_block_at("P", "page", "P", None, 0).unwrap();
        // Tree (fractional) order: N1, L1, N2, L2, N3.
        //  - N1, N2, N3 are position-less (new-scheme) siblings.
        //  - L1, L2 are legacy nodes whose positions DISAGREE with tree order
        //    (L1=20 sits before L2=10 in the tree → position order L2, L1).
        for (i, id) in ["N1", "L1", "N2", "L2", "N3"].iter().enumerate() {
            e.apply_create_block_at(id, "content", "", Some("P"), i)
                .unwrap();
        }
        e.force_legacy_scheme_for_test(&[("L1", 20), ("L2", 10)]);

        e.migrate_legacy_sibling_order_if_needed().unwrap();

        // Pinned-position-less semantics:
        //  - The position-less nodes N1, N2, N3 stay in their current tree slots
        //    (indices 0, 2, 4) and keep their relative order.
        //  - The legacy nodes are sorted by position (L2=10 before L1=20) and
        //    refill the legacy slots (indices 1, 3) in that order.
        // Slots: [N1, _, N2, _, N3] with legacy slots 1,3 ← [L2, L1].
        let order = e.list_children_walk("P").unwrap();
        assert_eq!(order, vec!["N1", "L2", "N2", "L1", "N3"], "got {order:?}");

        // The #1585 pathology would have produced legacy-first then all
        // position-less dumped at i64::MAX in id order — assert we did NOT.
        assert_ne!(
            order,
            vec!["L2", "L1", "N1", "N2", "N3"],
            "position-less siblings must not be dumped at the end (i64::MAX bug)"
        );
        // Position-less siblings retain their relative fractional order.
        let positionless: Vec<&String> = order.iter().filter(|b| b.starts_with('N')).collect();
        assert_eq!(
            positionless,
            vec!["N1", "N2", "N3"],
            "position-less relative order must be preserved"
        );
        assert_eq!(e.sibling_order_version(), SIBLING_ORDER_VERSION);

        // Idempotent: a second run (marker now set) is a no-op.
        e.migrate_legacy_sibling_order_if_needed().unwrap();
        assert_eq!(e.list_children_walk("P").unwrap(), order);
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
