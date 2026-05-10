//! PEND-09 Phase 3 day-3 — wire types for Loro-based sync.
//!
//! These types replace the diffy-typed `OpBatch`
//! (`super::types::SyncMessage::OpBatch`, deleted on day 5) with
//! CRDT-binary deltas exported by Loro's `LoroDoc::export(...)` —
//! `ExportMode::Snapshot` for a full state-plus-history blob and
//! `ExportMode::updates(&peer_vv)` for an incremental delta against
//! a known peer version vector.  See
//! `pending/PEND-09-PHASE-3-PLAN.md` §2.1, §3 day 3, §8.3.
//!
//! Phase 3 day-9 retired the `loro-shadow` feature gate; the matching
//! engine API (`engine::version_vector`, `engine::export_update_since`)
//! and these wire types now compile uniformly in every build.
//!
//! ## What's NOT here yet
//!
//! Day 3 ships only the types + their serde round-trip tests.  Day
//! 4 wires them into `sync_daemon` + `sync_protocol::operations`'s
//! sender side, behind a feature gate that picks Loro vs diffy at
//! send time; day 5 swings the receiver and deletes `OpBatch`.

use serde::{Deserialize, Serialize};

use crate::space::SpaceId;

/// Wire-format protocol version for [`LoroSyncMessage`].  Bumped
/// when the message shape changes incompatibly (e.g. a new variant
/// that cannot be safely ignored, or a field-rename that breaks
/// serde compatibility with `protocol_version: 1` peers).
///
/// Distinct from the inner Loro binary format's own version, which
/// Loro itself manages on the `bytes` payload.  This constant
/// versions the *envelope* carrying those bytes.
pub const LORO_SYNC_PROTOCOL_VERSION: u8 = 1;

/// Loro-binary version vector — opaque to this module; passed
/// back to the engine as-is.
///
/// Carried as `Vec<u8>` (the output of Loro 1.12's
/// `VersionVector::encode()`, which is `postcard::to_allocvec(self)`
/// per `loro-internal-1.12.0/src/version.rs:843-845`).  The wire
/// code does not parse it — only the engine's
/// `export_update_since` decodes back into a `loro::VersionVector`.
pub type LoroVersionVector = Vec<u8>;

/// One sync message between peers, scoped to a single [`SpaceId`].
///
/// Per-space partitioning matches the existing per-space [`LoroDoc`]
/// model (`pending/PEND-09-crdt-migration.md` line 13 +
/// `loro::registry::LoroEngineRegistry`); a sync session that
/// covers N spaces sends N of these messages, one per space.
///
/// # Variant choice — Snapshot vs Update
///
/// * **Snapshot** is sent when the receiver has no prior state for
///   `space_id` — typically initial sync, or after the
///   `ResetRequired` side-exit.  The receiver imports
///   unconditionally; no version-vector check is required.
/// * **Update** is sent when the receiver already has a `space_id`
///   engine.  The sender computed the delta as the ops in its own
///   `oplog_vv()` minus the receiver's last-known vv.  The receiver
///   imports against its existing engine state.
///
/// A peer that receives an **Update** for an unknown `space_id`
/// (or one whose vv is older than the `from_vv` floor) can ignore
/// the message and request a fresh **Snapshot** — the choice of
/// fallback policy is wire-shape-orthogonal and lives in day-5's
/// receiver dispatch.
///
/// # Serde shape
///
/// `#[serde(tag = "kind", rename_all = "snake_case")]` produces
/// JSON like
/// `{"kind":"snapshot","protocol_version":1,"space_id":"01HZ…","bytes":[…]}`
/// or
/// `{"kind":"update","protocol_version":1,"space_id":"01HZ…","from_vv":[…],"bytes":[…]}`.
/// The unit-tests below pin the round-trip; future variants must
/// preserve this shape so day-1-protocol peers continue to decode.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LoroSyncMessage {
    /// Full snapshot — receiver imports unconditionally.  Used for
    /// initial sync (peer has no prior state for `space_id`).
    ///
    /// `bytes` is the output of
    /// `LoroDoc::export(ExportMode::Snapshot)`
    /// (`loro-1.12.0/src/lib.rs:1273`).
    Snapshot {
        /// Wire envelope version; locked to
        /// [`LORO_SYNC_PROTOCOL_VERSION`] at send time.
        protocol_version: u8,
        /// Per-space scope (matches `LoroEngineRegistry` keying).
        space_id: SpaceId,
        /// Loro snapshot bytes.
        bytes: Vec<u8>,
    },
    /// Incremental delta — receiver imports against its existing
    /// engine state.  The sender computed this via
    /// `LoroDoc::export(ExportMode::updates(&peer_vv))`
    /// (`loro-1.12.0/src/lib.rs:1297-1300`).
    ///
    /// `from_vv` is the version vector the receiver had when this
    /// delta was computed (encoded via
    /// `VersionVector::encode()` —
    /// `loro-internal-1.12.0/src/version.rs:843`).  The receiver
    /// can verify it has all preceding ops by comparing against its
    /// current `oplog_vv()`; if its vv is strictly behind
    /// `from_vv`, the receiver MUST request a fresh
    /// [`LoroSyncMessage::Snapshot`] instead of importing the
    /// partial delta (day-5 receiver dispatch).
    Update {
        /// Wire envelope version; locked to
        /// [`LORO_SYNC_PROTOCOL_VERSION`] at send time.
        protocol_version: u8,
        /// Per-space scope (matches `LoroEngineRegistry` keying).
        space_id: SpaceId,
        /// The encoded peer-vv used as the `from` of
        /// `ExportMode::updates(&from_vv)`.
        from_vv: LoroVersionVector,
        /// Loro update bytes.
        bytes: Vec<u8>,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pin the wire-protocol version constant.  Bumping this is a
    /// wire-format break — every existing peer's `protocol_version:
    /// 1` envelope stops decoding cleanly.  Treat any failure of
    /// this test as a deliberate-version-bump checkpoint, not a
    /// "fix the test" event.
    #[test]
    fn loro_sync_protocol_version_constant_is_one() {
        assert_eq!(LORO_SYNC_PROTOCOL_VERSION, 1);
    }

    /// JSON serde round-trip preserves every field of a Snapshot
    /// variant.  Locks the on-the-wire shape: any future field
    /// rename / reorder that breaks this round-trip is a wire
    /// format break — bump [`LORO_SYNC_PROTOCOL_VERSION`].
    #[test]
    fn loro_sync_message_snapshot_serde_roundtrip() {
        let original = LoroSyncMessage::Snapshot {
            protocol_version: LORO_SYNC_PROTOCOL_VERSION,
            space_id: SpaceId::from_trusted("01HZ00000000000000000000SP"),
            bytes: vec![0x10, 0x20, 0x30, 0xff, 0x00, 0x7f],
        };
        let json = serde_json::to_string(&original).expect("LoroSyncMessage::Snapshot serialise");
        let deser: LoroSyncMessage =
            serde_json::from_str(&json).expect("LoroSyncMessage::Snapshot deserialise");
        assert_eq!(original, deser);

        // Sanity-check the wire shape itself (not just round-trip
        // identity): the discriminant tag must be `"snapshot"`.
        // Day-5 receiver dispatch reads this tag.
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(value["kind"], serde_json::json!("snapshot"));
        assert_eq!(value["protocol_version"], serde_json::json!(1));
    }

    /// JSON serde round-trip preserves every field of an Update
    /// variant — including the `from_vv` peer-VV bytes and the
    /// payload `bytes`.  Same wire-format-pin contract as the
    /// snapshot test.
    #[test]
    fn loro_sync_message_update_serde_roundtrip() {
        let original = LoroSyncMessage::Update {
            protocol_version: LORO_SYNC_PROTOCOL_VERSION,
            space_id: SpaceId::from_trusted("01HZ00000000000000000000SP"),
            from_vv: vec![0xde, 0xad, 0xbe, 0xef],
            bytes: vec![0x01, 0x02, 0x03, 0x04, 0x05],
        };
        let json = serde_json::to_string(&original).expect("LoroSyncMessage::Update serialise");
        let deser: LoroSyncMessage =
            serde_json::from_str(&json).expect("LoroSyncMessage::Update deserialise");
        assert_eq!(original, deser);

        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(value["kind"], serde_json::json!("update"));
        assert_eq!(value["protocol_version"], serde_json::json!(1));
    }
}
