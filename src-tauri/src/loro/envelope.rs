//! `loro_batch` op-log payload envelope — Phase-1 day-3 deliverable.
//!
//! Per SPIKE-REPORT.md §6 item 4 and the plan's Q7 risks-table entry
//! (`Op-type dispatcher breaks when every op_type=='loro_batch'`),
//! Phase 2 cutover will rewrite every typed op-log row's `payload`
//! column to a binary `LoroBatch` envelope carrying both the Loro
//! exported batch bytes AND a small versioning preamble.  Day-3
//! ships the **schema** for that envelope so day-4 and day-5 can
//! treat it as fixed-shape data without further design churn.
//!
//! ## What this module is NOT yet
//!
//! Day-3 introduces the type, a roundtrip test, and a
//! `From<&OpRecord>` conversion helper.  No production call site
//! writes a `LoroBatch` to `op_log.payload`, and no reader decodes
//! one — Phase 1 dual-writes the diffy result as the typed payload
//! and observes Loro alongside.  That changes in Phase 2 (cutover),
//! at which point this envelope becomes the on-the-wire shape for
//! every new `op_type='loro_batch'` row.
//!
//! ## Why a JSON `Value` for `payload`
//!
//! The day-3 envelope keeps the inner payload as `serde_json::Value`
//! rather than the strongly-typed [`crate::op::OpPayload`] enum so
//! the wrapper is **forward-compatible**: a future op-type variant
//! that doesn't yet exist in `OpPayload` can still be embedded
//! inside a `LoroBatch` and decoded by an old client (which would
//! see an unknown variant and skip it, instead of failing the whole
//! envelope decode).  When the writer constructs a `LoroBatch` from
//! a typed `OpRecord` it goes through the existing
//! `serde_json::from_str` path — there is no payload-shape lift,
//! only a re-wrap.
//!
//! ## Versioning
//!
//! Two version fields, both `u8`:
//!
//! * `loro_version` — the Loro library major version this payload
//!   was produced against.  Currently `1` (matching `loro = "1.12"`
//!   in `Cargo.toml`).  A reader that sees a `loro_version` it
//!   cannot decode rejects the row at decode time rather than
//!   silently importing garbage.
//! * `payload_version` — agaric's own envelope schema version,
//!   independent of the Loro library version.  Starts at `1`.  This
//!   bumps when the *envelope's* fields change (e.g. adding a
//!   `compression: u8` column) without the Loro library moving.
//!
//! Both are `u8` because we do not anticipate >= 256 versions of
//! either before this code is rewritten or removed.  If the
//! migration path ever needs more headroom the field type can be
//! widened in a `payload_version=2` envelope without breaking old
//! readers (they'd reject the unknown version cleanly).

use serde::{Deserialize, Serialize};

use crate::op_log::OpRecord;

/// Current Loro library major version this binary is built against.
///
/// Bumped in lockstep with the `loro = "..."` pin in `Cargo.toml`.
/// Read by [`LoroBatch::from`] when wrapping a fresh `OpRecord`.
pub const CURRENT_LORO_VERSION: u8 = 1;

/// Current agaric `LoroBatch` envelope schema version.
///
/// Independent of [`CURRENT_LORO_VERSION`] — bumped when the
/// envelope's own field layout changes, not when the Loro library
/// underneath moves.
pub const CURRENT_PAYLOAD_VERSION: u8 = 1;

/// `loro_batch` op-log payload envelope.
///
/// See module-level docs for the why.  Fields are versioned + typed
/// so day-4 (persistent parity sink) and day-5 (op_log row writer)
/// can treat this as a fixed shape.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LoroBatch {
    /// Loro library major version this payload was produced against.
    /// See [`CURRENT_LORO_VERSION`].
    pub loro_version: u8,

    /// Agaric envelope schema version.  See [`CURRENT_PAYLOAD_VERSION`].
    pub payload_version: u8,

    /// The original [`crate::op::OpType`] discriminator (snake_case
    /// string — `"create_block"`, `"edit_block"`, …) preserved here
    /// so the materializer dispatcher can still route by op type
    /// after the row's `op_log.op_type` column flips to
    /// `'loro_batch'` in Phase 2.
    pub original_op_type: String,

    /// The typed `OpPayload` body, kept as a JSON `Value` so the
    /// envelope is forward-compatible (an unknown future variant
    /// can ride through old readers without breaking decode).  The
    /// shape inside matches `serde_json::to_value(&op_payload)` for
    /// every variant of [`crate::op::OpPayload`].
    pub payload: serde_json::Value,
}

impl LoroBatch {
    /// Construct an envelope at the current versions, given the
    /// original op-type string + decoded payload value.  Used by the
    /// `TryFrom<&OpRecord>` impl below and any future direct callers.
    pub fn new(original_op_type: String, payload: serde_json::Value) -> Self {
        Self {
            loro_version: CURRENT_LORO_VERSION,
            payload_version: CURRENT_PAYLOAD_VERSION,
            original_op_type,
            payload,
        }
    }
}

/// Wrap an `OpRecord` as a `LoroBatch` envelope.
///
/// Day-3 has no callers in production — the impl exists so day-4
/// can call it from the persistent-parity-sink writer + day-5 can
/// call it from the op_log row rewrite path without further design
/// churn.
///
/// Returns a `Result` because `OpRecord.payload` is a JSON string
/// that may, in pathological cases, fail to parse — for example a
/// row written by a future client with a payload shape this client
/// can't decode at all.  In that case the envelope cannot be built
/// and the caller must skip the row.
impl TryFrom<&OpRecord> for LoroBatch {
    type Error = serde_json::Error;

    fn try_from(record: &OpRecord) -> Result<Self, Self::Error> {
        let payload: serde_json::Value = serde_json::from_str(&record.payload)?;
        Ok(LoroBatch::new(record.op_type.clone(), payload))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// JSON roundtrip: encode → decode → assert equal.  Locks the
    /// wire shape so a future `serde` rename or field reorder
    /// shows up as a hard test failure rather than a silent
    /// payload-decode bug at Phase 2.
    #[test]
    fn json_roundtrip_preserves_all_fields() {
        let original = LoroBatch::new(
            "create_block".to_string(),
            serde_json::json!({
                "block_id": "01HZ00000000000000000000AB",
                "block_type": "content",
                "content": "hello",
                "parent_id": null,
                "position": 0,
            }),
        );

        let encoded = serde_json::to_string(&original).expect("encode");
        let decoded: LoroBatch = serde_json::from_str(&encoded).expect("decode");

        assert_eq!(decoded, original);
        assert_eq!(decoded.loro_version, CURRENT_LORO_VERSION);
        assert_eq!(decoded.payload_version, CURRENT_PAYLOAD_VERSION);
        assert_eq!(decoded.original_op_type, "create_block");
    }

    /// Wrap a hand-built `OpRecord` and confirm the resulting
    /// envelope carries the original op_type + a parsed payload
    /// `Value` whose shape matches the source JSON.
    #[test]
    fn try_from_op_record_round_trips_through_envelope() {
        let record = OpRecord {
            device_id: "device-test".to_string(),
            seq: 42,
            parent_seqs: None,
            hash: "deadbeef".to_string(),
            op_type: "edit_block".to_string(),
            payload: r#"{"op_type":"edit_block","block_id":"01HZ00000000000000000000AB","to_text":"updated","prev_edit":null}"#.to_string(),
            created_at: "2026-05-09T00:00:00.000Z".to_string(),
            block_id: Some("01HZ00000000000000000000AB".to_string()),
        };

        let envelope = LoroBatch::try_from(&record).expect("wrap OpRecord");
        assert_eq!(envelope.original_op_type, "edit_block");
        assert_eq!(envelope.loro_version, CURRENT_LORO_VERSION);
        assert_eq!(envelope.payload_version, CURRENT_PAYLOAD_VERSION);

        // Inner payload `Value` carries the same structure as the
        // raw JSON string we started from.
        assert_eq!(
            envelope.payload.get("block_id").and_then(|v| v.as_str()),
            Some("01HZ00000000000000000000AB")
        );
        assert_eq!(
            envelope.payload.get("to_text").and_then(|v| v.as_str()),
            Some("updated")
        );

        // Re-encode the envelope + decode back; the inner Value
        // must survive the round-trip identically.
        let encoded = serde_json::to_string(&envelope).expect("encode");
        let decoded: LoroBatch = serde_json::from_str(&encoded).expect("decode");
        assert_eq!(decoded, envelope);
    }

    /// A malformed `OpRecord.payload` string makes `TryFrom` fail
    /// rather than panic — Phase 2 readers must surface this as a
    /// skip-with-warning, not a crash.
    #[test]
    fn try_from_op_record_rejects_invalid_json() {
        let record = OpRecord {
            device_id: "device-test".to_string(),
            seq: 1,
            parent_seqs: None,
            hash: "deadbeef".to_string(),
            op_type: "create_block".to_string(),
            payload: "{not valid json".to_string(),
            created_at: "2026-05-09T00:00:00.000Z".to_string(),
            block_id: None,
        };

        let result = LoroBatch::try_from(&record);
        assert!(result.is_err(), "malformed JSON must yield Err");
    }

    /// An envelope produced from a record-with-typed-payload survives
    /// a round-trip with the original `OpPayload` structure intact:
    /// re-decoding the inner `Value` as `OpPayload` recovers the
    /// same typed enum variant.  This proves the forward-compat
    /// shape (Value-typed inner payload) does NOT lose information
    /// for known op types.
    #[test]
    fn envelope_preserves_typed_op_payload_through_value() {
        use crate::op::{CreateBlockPayload, OpPayload};
        use crate::ulid::BlockId;

        let original = OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::from_trusted("01HZ00000000000000000000AB"),
            block_type: "content".to_string(),
            parent_id: None,
            position: Some(0),
            content: "hello".to_string(),
        });

        // Produce a record-shaped JSON string the way `op_log` does.
        let payload_json = serde_json::to_string(&original).expect("serialize OpPayload");
        let record = OpRecord {
            device_id: "device-test".to_string(),
            seq: 1,
            parent_seqs: None,
            hash: "deadbeef".to_string(),
            op_type: original.op_type_str().to_string(),
            payload: payload_json,
            created_at: "2026-05-09T00:00:00.000Z".to_string(),
            block_id: Some("01HZ00000000000000000000AB".to_string()),
        };

        let envelope = LoroBatch::try_from(&record).expect("wrap");
        // Re-decode the envelope's inner `Value` as `OpPayload` —
        // the typed variant must come back identical.
        let recovered: OpPayload =
            serde_json::from_value(envelope.payload.clone()).expect("decode inner");
        assert_eq!(recovered, original);
    }
}
