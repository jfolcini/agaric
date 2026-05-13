//! `loro_batch` op-log payload envelope.
//!
//! Reserved for a future on-the-wire shape carrying both Loro
//! exported batch bytes AND a small versioning preamble for
//! `op_type='loro_batch'` rows. Today only the type, a roundtrip
//! test, and a `From<&OpRecord>` conversion helper exist — no
//! production call site writes a `LoroBatch` to `op_log.payload` yet.
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
///
/// ## Version history
///
/// * `1` — Envelope carries `(loro_version, payload_version,
///   original_op_type, payload)` only; no Loro-exported bytes.
/// * `2` — Adds the `loro_bytes` field carrying
///   `LoroDoc::export(ExportMode::*)` bytes.
///
/// **Backward compatibility.**  v1 envelopes remain readable
/// indefinitely: the new `loro_bytes` field is `#[serde(default,
/// skip_serializing_if = "Vec::is_empty")]`, so a v1 row's JSON (no
/// `loro_bytes` key) deserialises into the v2 struct with
/// `loro_bytes: Vec::new()`, and a v2 envelope constructed with
/// empty bytes serialises identically to v1.  See the
/// `loro_batch_v1_decodes_into_v2_struct_with_empty_bytes` and
/// `loro_batch_v2_with_empty_bytes_serialises_as_v1` tests.
pub const CURRENT_LORO_VERSION: u8 = 2;

/// Current agaric `LoroBatch` envelope schema version.
///
/// Independent of [`CURRENT_LORO_VERSION`] — bumped when the
/// envelope's own field layout changes, not when the Loro library
/// underneath moves.
pub const CURRENT_PAYLOAD_VERSION: u8 = 1;

/// `loro_batch` op-log payload envelope.
///
/// See module-level docs for the why.  Fields are versioned + typed
/// so the persistent parity sink and op_log row writer can treat
/// this as a fixed shape.
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
    /// when the row's `op_log.op_type` column carries `'loro_batch'`.
    pub original_op_type: String,

    /// The typed `OpPayload` body, kept as a JSON `Value` so the
    /// envelope is forward-compatible (an unknown future variant
    /// can ride through old readers without breaking decode).  The
    /// shape inside matches `serde_json::to_value(&op_payload)` for
    /// every variant of [`crate::op::OpPayload`].
    pub payload: serde_json::Value,

    /// Loro-exported batch bytes for the op(s) in this row.
    ///
    /// Empty (`Vec::new()`) when the envelope was constructed from a
    /// typed-only `OpRecord`. When populated, carries
    /// `LoroDoc::export(ExportMode::*)` bytes so a remote peer can
    /// apply the batch via Loro's own import path.
    ///
    /// ## Wire-format back-compat (v1 → v2)
    ///
    /// `#[serde(default)]` makes a v1 row (no `loro_bytes` key)
    /// deserialise into the v2 struct with an empty `Vec<u8>`.
    /// `skip_serializing_if = "Vec::is_empty"` makes a v2 envelope
    /// with empty bytes serialise identically to v1 (no `loro_bytes`
    /// key emitted).  The two together let us bump
    /// [`CURRENT_LORO_VERSION`] to `2` without invalidating the
    /// (empty, today) v1 corpus and without forcing a parallel
    /// reader path.
    ///
    /// Plain `Vec<u8>` rather than `serde_bytes::ByteBuf` because
    /// (a) JSON is the wire format today and JSON has no native
    /// byte-string type — `serde_bytes` would still encode as a
    /// JSON array — so the only saving is on a hypothetical future
    /// non-JSON encoder; (b) avoiding a new dep keeps the default-
    /// build dep graph unchanged.  Switching to `serde_bytes` later
    /// is a non-breaking encoder swap.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub loro_bytes: Vec<u8>,
}

impl LoroBatch {
    /// Construct an envelope at the current versions, given the
    /// original op-type string + decoded payload value.
    ///
    /// `loro_bytes` is initialised empty.  Use
    /// [`LoroBatch::with_loro_bytes`] when you have Loro-exported
    /// bytes to attach.
    pub fn new(original_op_type: String, payload: serde_json::Value) -> Self {
        Self {
            loro_version: CURRENT_LORO_VERSION,
            payload_version: CURRENT_PAYLOAD_VERSION,
            original_op_type,
            payload,
            loro_bytes: Vec::new(),
        }
    }

    /// Construct an envelope at the current versions, given the
    /// original op-type string, decoded payload value, AND a buffer
    /// of Loro-exported batch bytes (typically the result of
    /// `LoroDoc::export(ExportMode::updates(&since_vv))` or
    /// `ExportMode::Snapshot`).
    pub fn with_loro_bytes(
        original_op_type: String,
        payload: serde_json::Value,
        loro_bytes: Vec<u8>,
    ) -> Self {
        Self {
            loro_version: CURRENT_LORO_VERSION,
            payload_version: CURRENT_PAYLOAD_VERSION,
            original_op_type,
            payload,
            loro_bytes,
        }
    }
}

/// Wrap an `OpRecord` as a `LoroBatch` envelope.
///
/// `loro_bytes` is left empty: this is the typed-only shape.  Code
/// that has Loro-exported bytes goes through
/// [`LoroBatch::with_loro_bytes`] instead.
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
    /// payload-decode bug.
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
    /// rather than panic — readers must surface this as a
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

    /// Phase-2 day-3: a v2 envelope built with `with_loro_bytes`
    /// survives a JSON round-trip with all five fields preserved
    /// byte-identical, including the embedded `loro_bytes` buffer.
    /// Locks the v2 wire shape in place.
    #[test]
    fn loro_batch_v2_roundtrip_with_bytes() {
        let bytes: Vec<u8> = vec![0x00, 0x01, 0x02, 0x03, 0xfe, 0xff, b'L', b'o', b'r', b'o'];
        let original = LoroBatch::with_loro_bytes(
            "create_block".to_string(),
            serde_json::json!({
                "block_id": "01HZ00000000000000000000AB",
                "block_type": "content",
                "content": "hello",
                "parent_id": null,
                "position": 0,
            }),
            bytes.clone(),
        );

        let encoded = serde_json::to_string(&original).expect("encode");
        let decoded: LoroBatch = serde_json::from_str(&encoded).expect("decode");

        assert_eq!(decoded, original);
        assert_eq!(decoded.loro_version, CURRENT_LORO_VERSION);
        assert_eq!(
            decoded.loro_version, 2,
            "Phase-2 day-3 bumps loro_version to 2"
        );
        assert_eq!(decoded.payload_version, CURRENT_PAYLOAD_VERSION);
        assert_eq!(decoded.original_op_type, "create_block");
        assert_eq!(decoded.loro_bytes, bytes);
        assert!(
            !decoded.loro_bytes.is_empty(),
            "loro_bytes must round-trip non-empty"
        );

        // `loro_bytes` shows up in the JSON because it's non-empty.
        assert!(
            encoded.contains("\"loro_bytes\""),
            "non-empty loro_bytes must appear in serialised JSON: {encoded}"
        );
    }

    /// Phase-2 day-3: wire-format BACK-COMPAT.  A real v1 byte
    /// sequence — produced by serialising the actual Phase-1 day-3
    /// struct shape (4 fields, no `loro_bytes`) — must deserialise
    /// cleanly into the v2 struct with `loro_bytes: Vec::new()`.
    ///
    /// This test does NOT use a hand-typed JSON literal; it builds
    /// a `V1Envelope` mirror struct, serialises it through the same
    /// `serde_json` path the Phase-1 code used, and feeds the result
    /// to the v2 deserialiser.  The mirror struct's field set,
    /// field order, and field types match the v1 source exactly
    /// (verified against `git show 16d369d2:.../envelope.rs`), so
    /// this exercises a real v1 wire shape, not a synthetic one.
    #[test]
    fn loro_batch_v1_decodes_into_v2_struct_with_empty_bytes() {
        /// Mirror of the Phase-1 day-3 `LoroBatch` struct.  Field
        /// set + order + types match commit `16d369d2`'s envelope
        /// definition.  Kept local to this test so a future schema
        /// change here doesn't drift it out of sync silently.
        #[derive(Serialize)]
        struct V1Envelope {
            loro_version: u8,
            payload_version: u8,
            original_op_type: String,
            payload: serde_json::Value,
        }

        let v1 = V1Envelope {
            loro_version: 1,
            payload_version: 1,
            original_op_type: "create_block".to_string(),
            payload: serde_json::json!({
                "block_id": "01HZ00000000000000000000AB",
                "block_type": "content",
                "content": "hello",
                "parent_id": null,
                "position": 0,
            }),
        };
        let v1_json = serde_json::to_string(&v1).expect("v1 encode");

        // Sanity: the v1 wire form has no loro_bytes key.
        assert!(
            !v1_json.contains("loro_bytes"),
            "v1 wire form must not contain loro_bytes: {v1_json}"
        );

        // Decode the real v1 byte sequence into the v2 struct.
        let decoded: LoroBatch = serde_json::from_str(&v1_json).expect("v1 → v2 decode");

        assert_eq!(decoded.loro_version, 1, "v1 source pinned at 1");
        assert_eq!(decoded.payload_version, 1);
        assert_eq!(decoded.original_op_type, "create_block");
        assert!(
            decoded.loro_bytes.is_empty(),
            "missing loro_bytes field must default to empty Vec"
        );
        // Inner payload survives intact.
        assert_eq!(
            decoded.payload.get("block_id").and_then(|v| v.as_str()),
            Some("01HZ00000000000000000000AB")
        );
    }

    /// Phase-2 day-3: a v2 envelope constructed with empty
    /// `loro_bytes` serialises identically to v1 — the
    /// `skip_serializing_if = "Vec::is_empty"` attribute drops the
    /// key entirely.  This is what makes the bump non-breaking for
    /// readers that already exist out in the wild.
    #[test]
    fn loro_batch_v2_with_empty_bytes_serialises_as_v1() {
        // `LoroBatch::new` produces an empty `loro_bytes`.
        let envelope = LoroBatch::new(
            "create_block".to_string(),
            serde_json::json!({
                "block_id": "01HZ00000000000000000000AB",
                "block_type": "content",
                "content": "hello",
                "parent_id": null,
                "position": 0,
            }),
        );
        assert!(envelope.loro_bytes.is_empty());

        let encoded = serde_json::to_string(&envelope).expect("encode");

        // Critical assertion: the empty `loro_bytes` must NOT appear
        // in the serialised JSON.  If `skip_serializing_if` is ever
        // dropped or the field renamed, this test fires.
        assert!(
            !encoded.contains("loro_bytes"),
            "empty loro_bytes must be omitted from JSON (skip_serializing_if): {encoded}"
        );

        // The serialised JSON should match the v1 wire shape exactly
        // for the same logical content.  Build a v1 mirror to compare
        // against.  Using the same field ordering serde uses by
        // source declaration.
        #[derive(Serialize)]
        struct V1Envelope {
            loro_version: u8,
            payload_version: u8,
            original_op_type: String,
            payload: serde_json::Value,
        }
        let v1 = V1Envelope {
            loro_version: envelope.loro_version, // = 2 in this build
            payload_version: envelope.payload_version,
            original_op_type: envelope.original_op_type.clone(),
            payload: envelope.payload.clone(),
        };
        let v1_encoded = serde_json::to_string(&v1).expect("v1 encode");
        assert_eq!(
            encoded, v1_encoded,
            "v2-with-empty-bytes must serialise identically to a v1-shape struct \
             with the same scalar fields"
        );
    }

    /// Phase-2 day-3: the new `with_loro_bytes` constructor populates
    /// every field correctly — including the new `loro_bytes` slot —
    /// at the current schema versions.  Builder-shape sanity check.
    #[test]
    fn loro_batch_with_loro_bytes_constructor_populates_field() {
        let bytes: Vec<u8> = vec![0xde, 0xad, 0xbe, 0xef];
        let payload = serde_json::json!({
            "block_id": "01HZ00000000000000000000AB",
            "block_type": "content",
            "content": "x",
            "parent_id": null,
            "position": 0,
        });

        let envelope =
            LoroBatch::with_loro_bytes("create_block".to_string(), payload.clone(), bytes.clone());

        assert_eq!(envelope.loro_version, CURRENT_LORO_VERSION);
        assert_eq!(envelope.payload_version, CURRENT_PAYLOAD_VERSION);
        assert_eq!(envelope.original_op_type, "create_block");
        assert_eq!(envelope.payload, payload);
        assert_eq!(envelope.loro_bytes, bytes);
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
