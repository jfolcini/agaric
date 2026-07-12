//! Transport-level encode/decode for [`SyncMessage`] (#611).
//!
//! Every sync-session message travels as a single JSON text frame,
//! capped at `SyncConnection::MAX_MSG_SIZE` (10 MB) on receive. That
//! is fine for everything except `SyncMessage::LoroSync`: its
//! `LoroSyncMessage.bytes` payload serialises as a JSON number array —
//! worst case 4 characters per byte — so a per-space Loro snapshot of
//! ~2.8 MB already produced an over-cap text frame, every session
//! failed at `recv_json`, and the scheduler backed off and retried
//! forever. A growing vault was guaranteed to cross the threshold.
//!
//! This module fixes that by giving `LoroSync` two transport encodings:
//!
//! * **Inline** (payload `<=` [`LORO_INLINE_MAX_BYTES`]): the exact
//!   pre-#611 JSON text frame, byte-for-byte. Chosen for every payload
//!   small enough that its worst-case JSON stays under the receive cap
//!   — which keeps full interop with pre-#611 peers for every payload
//!   they could ever successfully receive.
//! * **Chunked** (payload `>` [`LORO_INLINE_MAX_BYTES`]): a small
//!   [`SyncMessage::LoroSyncChunked`] JSON header announcing
//!   `size_bytes`, followed by the raw Loro bytes in
//!   [`BINARY_FRAME_CHUNK_SIZE`]-sized binary frames — the same
//!   machinery the snapshot-blob and attachment-file sub-flows use.
//!   No JSON inflation, no per-message cap: only the
//!   [`MAX_LORO_SYNC_PAYLOAD_SIZE`] sanity bound applies.
//!
//! The split/reassembly happens entirely inside
//! [`send_sync_message`] / [`recv_sync_message`]; the protocol
//! orchestrator state machine only ever sees plain
//! [`SyncMessage::LoroSync`] values (it rejects a stray
//! `LoroSyncChunked` loudly — see `sync_protocol::session_state_machine`).
//!
//! [`SyncMessage::OpLogBatch`] (audit-only op-log replication, #2481) shares the
//! identical inline/chunked machinery (#2593): a batch whose serialised records
//! exceed [`OP_LOG_BATCH_INLINE_MAX_BYTES`] ships as a
//! [`SyncMessage::OpLogBatchChunked`] header + binary frames and is reassembled
//! back into a plain `OpLogBatch` on receive, so a lone oversized op record
//! replicates its audit metadata instead of being dropped at the frame cap.
//!
//! Both session loops (initiator `run_sync_session`, responder
//! `handle_incoming_sync`) route every send/recv through these
//! helpers. The snapshot and file-transfer sub-flows keep their plain
//! `send_json`/`recv_json` calls — their message kinds never carry
//! Loro payloads.

use std::io::Read;

use crate::error::AppError;
use crate::sync_constants::{
    BINARY_FRAME_CHUNK_SIZE, LORO_INLINE_MAX_BYTES, MAX_LORO_SYNC_PAYLOAD_SIZE,
    MAX_OP_LOG_BATCH_PAYLOAD_SIZE, OP_LOG_BATCH_INLINE_MAX_BYTES,
};
use crate::sync_net::SyncConnection;
use crate::sync_protocol::SyncMessage;
use crate::sync_protocol::loro_sync_types::LoroSyncChunkedHeader;
use crate::sync_protocol::types::OpTransfer;

/// zstd level for the chunked-`LoroSync` wire payload (#2200). Matches the
/// snapshot codec's level 3: a good ratio/CPU balance, and the encode now
/// runs on the async task inline (the payload is already bounded by
/// [`MAX_LORO_SYNC_PAYLOAD_SIZE`] and compression of a multi-MB Loro blob is
/// fast at level 3). The value is not on the wire — decode is level-agnostic
/// — so it can be retuned without a protocol bump.
const ZSTD_WIRE_LEVEL: i32 = 3;

/// Cap the zstd decompression window at 2^27 = 128 MB on the wire-decode path,
/// mirroring the snapshot codec's `DECODER_WINDOW_LOG_MAX`. Our level-3
/// encoder uses a far smaller window, so this never rejects a payload we
/// produced; it just refuses a frame whose header demands an outsized window
/// allocation (a cheap defence-in-depth bound on top of the paired-peer mTLS
/// trust model).
const WIRE_DECODER_WINDOW_LOG_MAX: u32 = 27;

/// zstd-compress a chunked-`LoroSync` payload for the wire (#2200).
fn compress_wire(raw: &[u8]) -> Result<Vec<u8>, AppError> {
    zstd::bulk::compress(raw, ZSTD_WIRE_LEVEL).map_err(|e| {
        AppError::InvalidOperation(format!("[sync_daemon::wire] zstd compress failed: {e}"))
    })
}

/// Decompress a chunked wire payload, bounding the decompressed size at
/// `max_size` so a corrupt or hostile frame cannot blow up into an unbounded
/// allocation (#2200). The window is also capped via
/// [`WIRE_DECODER_WINDOW_LOG_MAX`]. Corrupt compressed bytes surface as a
/// clean `AppError` (the decoder's `io::Error`), never a panic. Shared by the
/// `LoroSync` (#611/#2200) and `OpLogBatch` (#2593) chunked transports — both
/// bound at 256 MB but kept as an explicit parameter so the two callers stay
/// independently auditable.
fn decompress_wire(compressed: &[u8], max_size: u64) -> Result<Vec<u8>, AppError> {
    let mut decoder = zstd::stream::Decoder::new(compressed).map_err(|e| {
        AppError::InvalidOperation(format!("[sync_daemon::wire] zstd decoder init failed: {e}"))
    })?;
    decoder
        .window_log_max(WIRE_DECODER_WINDOW_LOG_MAX)
        .map_err(|e| {
            AppError::InvalidOperation(format!("[sync_daemon::wire] zstd window cap failed: {e}"))
        })?;
    // Read at most `max_size + 1` decompressed bytes; anything beyond the cap
    // means the frame decompresses past the sanity bound and is rejected.
    let mut out = Vec::new();
    let mut limited = decoder.take(max_size.saturating_add(1));
    limited.read_to_end(&mut out).map_err(|e| {
        AppError::InvalidOperation(format!(
            "[sync_daemon::wire] corrupt compressed payload: {e}"
        ))
    })?;
    if out.len() as u64 > max_size {
        return Err(AppError::InvalidOperation(format!(
            "[sync_daemon::wire] decompressed payload exceeds {max_size} \
             bytes — possible decompression bomb"
        )));
    }
    Ok(out)
}

/// Send one [`SyncMessage`], choosing the transport encoding.
///
/// * `LoroSync` with payload `> LORO_INLINE_MAX_BYTES` → chunked
///   header + binary frames.
/// * Everything else (including small `LoroSync`) → one JSON text
///   frame, identical to the pre-#611 wire format.
///
/// `LoroSyncChunked` is a transport-internal encoding produced only by
/// this module; callers must always pass the plain `LoroSync` form, so
/// receiving one here is a programmer error and is rejected.
pub(crate) async fn send_sync_message(
    conn: &mut SyncConnection,
    msg: &SyncMessage,
) -> Result<(), AppError> {
    match msg {
        SyncMessage::LoroSync { msg: loro, is_last } => {
            let (mut header, payload) = LoroSyncChunkedHeader::split(loro);
            if payload.len() <= LORO_INLINE_MAX_BYTES {
                // Inline: worst-case JSON (4 chars/byte + envelope) is
                // guaranteed under the peer's receive cap — see the
                // `LORO_INLINE_MAX_BYTES` rationale in `sync_constants`
                // and the `inline_threshold_*` tripwires below. Compression
                // never applies here: the inline path must stay byte-for-byte
                // pre-#611 for old peers (#2200).
                return conn.send_json(msg).await;
            }
            // Sanity-cap the *raw* payload (unchanged semantics) so a
            // genuinely over-cap message fails loudly at the source instead
            // of after shipping bytes the peer will reject anyway. Checked
            // before compression because the raw size is the memory the peer
            // must ultimately materialise.
            if payload.len() as u64 > MAX_LORO_SYNC_PAYLOAD_SIZE {
                return Err(AppError::InvalidOperation(format!(
                    "[sync_daemon::wire] LoroSync payload too large to send: {} bytes \
                     (max {MAX_LORO_SYNC_PAYLOAD_SIZE})",
                    payload.len(),
                )));
            }
            // #2200: compress the bulk chunked payload iff the peer advertised
            // `wire_compression` AND compression actually shrinks it (a Loro
            // update that is already near-incompressible falls back to raw so
            // we never pay a size penalty). The `compressed` flag on the
            // envelope tells the receiver which case applies; a peer that
            // never advertised the capability is never sent `compressed:
            // true`, so an old #611 peer only ever sees raw bytes.
            let (wire_bytes, compressed): (std::borrow::Cow<'_, [u8]>, bool) =
                if conn.peer_wire_compression() {
                    let z = compress_wire(payload)?;
                    if z.len() < payload.len() {
                        (std::borrow::Cow::Owned(z), true)
                    } else {
                        (std::borrow::Cow::Borrowed(payload), false)
                    }
                } else {
                    (std::borrow::Cow::Borrowed(payload), false)
                };
            // The header advertises the *wire* (compressed) byte count that
            // `receive_binary_chunked` consumes; `split` initialised it to the
            // raw length, so correct it whenever compression changed the size.
            header.set_size_bytes(wire_bytes.len() as u64);
            conn.send_json(&SyncMessage::LoroSyncChunked {
                header,
                is_last: *is_last,
                compressed,
            })
            .await?;
            conn.send_binary_chunked(&wire_bytes, BINARY_FRAME_CHUNK_SIZE)
                .await
        }
        SyncMessage::LoroSyncChunked { .. } => Err(AppError::InvalidOperation(
            "[sync_daemon::wire] LoroSyncChunked is a transport-internal encoding; \
             pass the plain LoroSync form to send_sync_message"
                .into(),
        )),
        // #2593 — mirror the LoroSync inline/chunked split for OpLogBatch so a
        // lone oversized op record replicates instead of being skipped at the
        // 10 MB inline frame cap. The records serialise to bytes once; a batch
        // whose payload fits the inline bound keeps the exact pre-#2593
        // `OpLogBatch` JSON shape (old-peer interop), otherwise it rides a
        // chunked header + binary frames.
        SyncMessage::OpLogBatch { records, is_last } => {
            let payload = serde_json::to_vec(records).map_err(|e| {
                AppError::InvalidOperation(format!(
                    "[sync_daemon::wire] OpLogBatch records serialise failed: {e}"
                ))
            })?;
            if payload.len() <= OP_LOG_BATCH_INLINE_MAX_BYTES {
                // Inline: byte-for-byte the pre-#2593 `OpLogBatch` frame. A peer
                // that understands OpLogBatch (#2481) but not the chunked
                // envelope decodes every batch it could ever receive.
                return conn.send_json(msg).await;
            }
            // Sanity-cap the raw serialised payload before shipping bytes the
            // peer would reject anyway (checked before compression — the raw
            // size is the memory the peer must ultimately materialise).
            if payload.len() as u64 > MAX_OP_LOG_BATCH_PAYLOAD_SIZE {
                return Err(AppError::InvalidOperation(format!(
                    "[sync_daemon::wire] OpLogBatch payload too large to send: {} bytes \
                     (max {MAX_OP_LOG_BATCH_PAYLOAD_SIZE})",
                    payload.len(),
                )));
            }
            // #2200-style: compress the bulk payload iff the peer advertised
            // `wire_compression` AND compression actually shrinks it. Op
            // payloads are text (block content) and compress well, so this is
            // usually a large win; an un-negotiated peer only ever sees raw
            // bytes.
            let (wire_bytes, compressed): (std::borrow::Cow<'_, [u8]>, bool) =
                if conn.peer_wire_compression() {
                    let z = compress_wire(&payload)?;
                    if z.len() < payload.len() {
                        (std::borrow::Cow::Owned(z), true)
                    } else {
                        (std::borrow::Cow::Borrowed(payload.as_slice()), false)
                    }
                } else {
                    (std::borrow::Cow::Borrowed(payload.as_slice()), false)
                };
            conn.send_json(&SyncMessage::OpLogBatchChunked {
                size_bytes: wire_bytes.len() as u64,
                is_last: *is_last,
                compressed,
            })
            .await?;
            conn.send_binary_chunked(&wire_bytes, BINARY_FRAME_CHUNK_SIZE)
                .await
        }
        SyncMessage::OpLogBatchChunked { .. } => Err(AppError::InvalidOperation(
            "[sync_daemon::wire] OpLogBatchChunked is a transport-internal encoding; \
             pass the plain OpLogBatch form to send_sync_message"
                .into(),
        )),
        other => conn.send_json(other).await,
    }
}

/// Receive one [`SyncMessage`], reassembling the chunked transport
/// encoding back into a plain [`SyncMessage::LoroSync`].
///
/// On a `LoroSyncChunked` header this consumes exactly
/// `header.size_bytes()` of follow-up binary frames (rejecting
/// over-run, wrong frame types, and headers advertising more than
/// [`MAX_LORO_SYNC_PAYLOAD_SIZE`] — the latter *before* reading any
/// payload frame, so a runaway header cannot trigger a large
/// allocation). All other message kinds — including the unchanged
/// pre-#611 inline `LoroSync` shape — pass through untouched, which is
/// what keeps old-build peers decodable.
pub(crate) async fn recv_sync_message(conn: &mut SyncConnection) -> Result<SyncMessage, AppError> {
    let msg: SyncMessage = conn.recv_json().await?;
    match msg {
        SyncMessage::LoroSyncChunked {
            header,
            is_last,
            compressed,
        } => {
            let size_bytes = header.size_bytes();
            if size_bytes > MAX_LORO_SYNC_PAYLOAD_SIZE {
                return Err(AppError::InvalidOperation(format!(
                    "[sync_daemon::wire] LoroSyncChunked header advertises {size_bytes} bytes \
                     (max {MAX_LORO_SYNC_PAYLOAD_SIZE})",
                )));
            }
            // `size_bytes` is the wire (compressed, when `compressed`) length.
            let wire_bytes = conn.receive_binary_chunked(size_bytes).await?;
            // #2200: reverse the zstd frame if the sender compressed it. The
            // decompressed size is re-bounded by `MAX_LORO_SYNC_PAYLOAD_SIZE`
            // inside `decompress_wire`, and corrupt compressed bytes surface
            // as a clean `AppError` rather than a panic.
            let bytes = if compressed {
                decompress_wire(&wire_bytes, MAX_LORO_SYNC_PAYLOAD_SIZE)?
            } else {
                wire_bytes
            };
            Ok(SyncMessage::LoroSync {
                msg: header.into_message(bytes),
                is_last,
            })
        }
        // #2593 — reassemble a chunked OpLogBatch back into the plain form the
        // orchestrator dispatches on. Mirrors the LoroSyncChunked arm: bound the
        // advertised size before reading any frame, consume exactly that many
        // (optionally compressed) bytes, then deserialise the records.
        SyncMessage::OpLogBatchChunked {
            size_bytes,
            is_last,
            compressed,
        } => {
            if size_bytes > MAX_OP_LOG_BATCH_PAYLOAD_SIZE {
                return Err(AppError::InvalidOperation(format!(
                    "[sync_daemon::wire] OpLogBatchChunked header advertises {size_bytes} bytes \
                     (max {MAX_OP_LOG_BATCH_PAYLOAD_SIZE})",
                )));
            }
            let wire_bytes = conn.receive_binary_chunked(size_bytes).await?;
            let bytes = if compressed {
                decompress_wire(&wire_bytes, MAX_OP_LOG_BATCH_PAYLOAD_SIZE)?
            } else {
                wire_bytes
            };
            let records: Vec<OpTransfer> = serde_json::from_slice(&bytes).map_err(|e| {
                AppError::InvalidOperation(format!(
                    "[sync_daemon::wire] OpLogBatchChunked records deserialise failed: {e}"
                ))
            })?;
            Ok(SyncMessage::OpLogBatch { records, is_last })
        }
        other => Ok(other),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::space::SpaceId;
    use crate::sync_net::test_connection_pair;
    use crate::sync_protocol::loro_sync_types::{LORO_SYNC_PROTOCOL_VERSION, LoroSyncMessage};

    fn test_space_id() -> SpaceId {
        SpaceId::from_trusted("01HZ00000000000000000000SP")
    }

    fn snapshot_msg(bytes: Vec<u8>, is_last: bool) -> SyncMessage {
        SyncMessage::LoroSync {
            msg: LoroSyncMessage::Snapshot {
                protocol_version: LORO_SYNC_PROTOCOL_VERSION,
                space_id: test_space_id(),
                bytes,
            },
            is_last,
        }
    }

    /// Round-trip one message through `send_sync_message` /
    /// `recv_sync_message` over an in-memory pair, driving both ends
    /// concurrently (the duplex buffer is only 64 KB).
    async fn roundtrip(msg: SyncMessage) -> SyncMessage {
        let (mut a, mut b) = test_connection_pair().await;
        let (sent, received) = tokio::join!(send_sync_message(&mut a, &msg), async {
            recv_sync_message(&mut b).await
        });
        sent.expect("send must succeed");
        received.expect("recv must succeed")
    }

    // ── #611 reproduction: the pre-fix encoding breaks near the cap ──

    /// Reproduce the original breakage: a 3 MB Loro payload of 0xFF
    /// bytes serialises to ~12.6 MB of JSON number array ("255," per
    /// byte), which exceeds the 10 MB receive cap — the pre-#611
    /// `send_json`/`recv_json` path fails the session. This is the
    /// permanent-sync-break condition the chunked path eliminates.
    #[tokio::test]
    async fn old_inline_encoding_fails_for_3mb_payload() {
        let msg = snapshot_msg(vec![0xff; 3_000_000], true);
        let (mut a, mut b) = test_connection_pair().await;
        // The sender blocks once the 64 KB duplex fills and the
        // receiver has already errored out — spawn it and abort after
        // the receive side fails.
        let sender = tokio::spawn(async move {
            let _ = a.send_json(&msg).await;
        });
        let err = b
            .recv_json::<SyncMessage>()
            .await
            .expect_err("a >10MB JSON text frame must be rejected");
        let rendered = err.to_string();
        assert!(
            rendered.contains("too long") || rendered.contains("too large"),
            "error must be the size-cap rejection, got: {rendered}"
        );
        sender.abort();
    }

    /// The same 3 MB payload round-trips losslessly through the #611
    /// wire helpers — the fix for the exact breakage above.
    #[tokio::test]
    async fn fixed_wire_roundtrips_3mb_payload_that_broke_old_encoding() {
        let msg = snapshot_msg(vec![0xff; 3_000_000], true);
        assert_eq!(roundtrip(msg.clone()).await, msg);
    }

    // ── Round-trips straddling the inline/chunked threshold ──────────

    /// Exactly `LORO_INLINE_MAX_BYTES` stays on the inline path and
    /// round-trips (worst-case 0xFF content, the maximum-inflation
    /// case for the JSON number-array encoding).
    #[tokio::test]
    async fn payload_at_inline_threshold_roundtrips() {
        let msg = snapshot_msg(vec![0xff; LORO_INLINE_MAX_BYTES], false);
        assert_eq!(roundtrip(msg.clone()).await, msg);
    }

    /// One byte over the threshold flips to the chunked path and
    /// round-trips.
    #[tokio::test]
    async fn payload_just_over_inline_threshold_roundtrips() {
        let msg = snapshot_msg(vec![0xff; LORO_INLINE_MAX_BYTES + 1], true);
        assert_eq!(roundtrip(msg.clone()).await, msg);
    }

    /// A 12 MB payload exceeds `MAX_MSG_SIZE` even as *raw* bytes —
    /// it must span multiple binary frames (5 MB chunks) and still
    /// round-trip. Proves the chunked path lifts the per-message cap
    /// entirely, not just the JSON-inflation factor.
    #[tokio::test]
    async fn payload_exceeding_per_message_cap_roundtrips_across_frames() {
        // Patterned (not constant) content so a chunk-reassembly
        // ordering bug cannot slip through equality.
        let bytes: Vec<u8> = (0..12_000_000u32).map(|i| (i % 251) as u8).collect();
        let msg = snapshot_msg(bytes, true);
        assert_eq!(roundtrip(msg.clone()).await, msg);
    }

    /// Update variant (with `from_vv`) over the chunked path.
    #[tokio::test]
    async fn update_variant_roundtrips_chunked() {
        let msg = SyncMessage::LoroSync {
            msg: LoroSyncMessage::Update {
                protocol_version: LORO_SYNC_PROTOCOL_VERSION,
                space_id: test_space_id(),
                from_vv: vec![0xde, 0xad, 0xbe, 0xef],
                bytes: vec![0xab; LORO_INLINE_MAX_BYTES + 17],
            },
            is_last: false,
        };
        assert_eq!(roundtrip(msg.clone()).await, msg);
    }

    /// Empty and tiny payloads stay inline and round-trip (the
    /// degenerate ends of the size spectrum).
    #[tokio::test]
    async fn tiny_payloads_roundtrip_inline() {
        for bytes in [vec![], vec![0x01], vec![0x10, 0x20, 0xff]] {
            let msg = snapshot_msg(bytes, true);
            assert_eq!(roundtrip(msg.clone()).await, msg);
        }
    }

    /// Non-LoroSync messages pass through the helpers unchanged.
    #[tokio::test]
    async fn non_loro_messages_pass_through() {
        for msg in [
            SyncMessage::HeadExchange {
                heads: vec![],
                loro_vvs: vec![],
                engine_format_version: crate::loro::engine::ENGINE_FORMAT_VERSION,
                op_log_replication: false,
                wire_compression: false,
            },
            SyncMessage::SyncComplete {
                last_hash: "abc123".into(),
            },
            SyncMessage::Error {
                message: "boom".into(),
            },
        ] {
            assert_eq!(roundtrip(msg.clone()).await, msg);
        }
    }

    // ── Cross-version wire-shape compatibility ────────────────────────

    /// A small `LoroSync` sent through `send_sync_message` produces
    /// the exact pre-#611 inline JSON shape — `type: "LoroSync"` with
    /// `bytes` as a plain number array — so an old-build peer decodes
    /// it untouched.
    #[tokio::test]
    async fn small_payload_keeps_pre_611_inline_wire_shape() {
        let msg = snapshot_msg(vec![0x10, 0x20, 0xff], true);
        let (mut a, mut b) = test_connection_pair().await;
        let (sent, raw) = tokio::join!(send_sync_message(&mut a, &msg), async {
            b.recv_json::<serde_json::Value>().await
        });
        sent.expect("send must succeed");
        let value = raw.expect("raw JSON recv must succeed");
        assert_eq!(value["type"], serde_json::json!("LoroSync"));
        assert_eq!(value["is_last"], serde_json::json!(true));
        assert_eq!(value["msg"]["kind"], serde_json::json!("snapshot"));
        assert_eq!(value["msg"]["protocol_version"], serde_json::json!(1));
        assert_eq!(
            value["msg"]["bytes"],
            serde_json::json!([0x10, 0x20, 0xff]),
            "bytes must stay a JSON number array — the pre-#611 shape old peers decode"
        );
    }

    /// `recv_sync_message` still accepts the old inline shape coming
    /// FROM a pre-#611 peer (hand-built JSON, not round-tripped
    /// through our own serializer).
    #[tokio::test]
    async fn old_peer_inline_shape_still_decodes() {
        let old_shape: serde_json::Value = serde_json::json!({
            "type": "LoroSync",
            "msg": {
                "kind": "update",
                "protocol_version": 1,
                "space_id": "01HZ00000000000000000000SP",
                "from_vv": [222, 173],
                "bytes": [1, 2, 3, 4, 5],
            },
            "is_last": false,
        });
        let (mut a, mut b) = test_connection_pair().await;
        let (sent, received) = tokio::join!(a.send_json(&old_shape), async {
            recv_sync_message(&mut b).await
        });
        sent.expect("send must succeed");
        let expected = SyncMessage::LoroSync {
            msg: LoroSyncMessage::Update {
                protocol_version: LORO_SYNC_PROTOCOL_VERSION,
                space_id: test_space_id(),
                from_vv: vec![222, 173],
                bytes: vec![1, 2, 3, 4, 5],
            },
            is_last: false,
        };
        assert_eq!(received.expect("decode old shape"), expected);
    }

    /// An over-threshold send produces the chunked header envelope on
    /// the wire (pin the transport shape the receiver dispatches on).
    #[tokio::test]
    async fn large_payload_produces_chunked_header_envelope() {
        let payload_len = LORO_INLINE_MAX_BYTES + 5;
        let msg = snapshot_msg(vec![0x42; payload_len], false);
        let (mut a, mut b) = test_connection_pair().await;
        let (sent, result) = tokio::join!(send_sync_message(&mut a, &msg), async {
            let header = b.recv_json::<serde_json::Value>().await?;
            // Drain the binary payload so the sender completes.
            let bytes = b.receive_binary_chunked(payload_len as u64).await?;
            Ok::<_, AppError>((header, bytes))
        });
        sent.expect("send must succeed");
        let (header, bytes) = result.expect("header + payload recv must succeed");
        assert_eq!(header["type"], serde_json::json!("LoroSyncChunked"));
        assert_eq!(header["is_last"], serde_json::json!(false));
        assert_eq!(header["header"]["kind"], serde_json::json!("snapshot"));
        assert_eq!(
            header["header"]["size_bytes"],
            serde_json::json!(payload_len)
        );
        assert_eq!(bytes.len(), payload_len);
    }

    // ── Malformed-frame error paths ───────────────────────────────────

    /// A chunked header advertising more than the sanity cap is
    /// rejected before any binary frame is read.
    #[tokio::test]
    async fn oversized_chunked_header_is_rejected_before_payload() {
        let (mut a, mut b) = test_connection_pair().await;
        let header = SyncMessage::LoroSyncChunked {
            header: LoroSyncChunkedHeader::Snapshot {
                protocol_version: LORO_SYNC_PROTOCOL_VERSION,
                space_id: test_space_id(),
                size_bytes: MAX_LORO_SYNC_PAYLOAD_SIZE + 1,
            },
            is_last: true,
            compressed: false,
        };
        a.send_json(&header).await.expect("header send");
        let err = recv_sync_message(&mut b)
            .await
            .expect_err("over-cap header must be rejected");
        assert!(
            err.to_string().contains("advertises"),
            "must fail on the advertised size, got: {err}"
        );
    }

    /// Sender shipping more binary bytes than the header advertised is
    /// an over-run error.
    #[tokio::test]
    async fn payload_overrun_is_rejected() {
        let (mut a, mut b) = test_connection_pair().await;
        let header = SyncMessage::LoroSyncChunked {
            header: LoroSyncChunkedHeader::Snapshot {
                protocol_version: LORO_SYNC_PROTOCOL_VERSION,
                space_id: test_space_id(),
                size_bytes: 10,
            },
            is_last: true,
            compressed: false,
        };
        a.send_json(&header).await.expect("header send");
        a.send_binary(&[0u8; 20]).await.expect("over-run frame");
        let err = recv_sync_message(&mut b)
            .await
            .expect_err("over-run must be rejected");
        assert!(
            err.to_string().contains("expected 10"),
            "must report the advertised size, got: {err}"
        );
    }

    /// A text frame arriving where binary payload was announced is a
    /// frame-type error.
    #[tokio::test]
    async fn text_frame_in_binary_payload_is_rejected() {
        let (mut a, mut b) = test_connection_pair().await;
        let header = SyncMessage::LoroSyncChunked {
            header: LoroSyncChunkedHeader::Snapshot {
                protocol_version: LORO_SYNC_PROTOCOL_VERSION,
                space_id: test_space_id(),
                size_bytes: 10,
            },
            is_last: true,
            compressed: false,
        };
        a.send_json(&header).await.expect("header send");
        a.send_json(&SyncMessage::SnapshotAccept)
            .await
            .expect("stray text frame send");
        let err = recv_sync_message(&mut b)
            .await
            .expect_err("text frame in binary payload must be rejected");
        assert!(
            err.to_string().contains("expected binary message"),
            "must be the frame-type error, got: {err}"
        );
    }

    /// Passing the transport-internal `LoroSyncChunked` form to
    /// `send_sync_message` is a programmer error.
    #[tokio::test]
    async fn sending_chunked_form_directly_is_rejected() {
        let (mut a, _b) = test_connection_pair().await;
        let msg = SyncMessage::LoroSyncChunked {
            header: LoroSyncChunkedHeader::Snapshot {
                protocol_version: LORO_SYNC_PROTOCOL_VERSION,
                space_id: test_space_id(),
                size_bytes: 1,
            },
            is_last: true,
            compressed: false,
        };
        let err = send_sync_message(&mut a, &msg)
            .await
            .expect_err("LoroSyncChunked must not be sendable directly");
        assert!(err.to_string().contains("transport-internal"));
    }

    /// Sender-side mirror of the receiver's sanity cap.
    #[tokio::test]
    async fn sending_over_cap_payload_is_rejected_at_source() {
        let (mut a, _b) = test_connection_pair().await;
        // Don't allocate 256 MB: a Vec with the right *len* is needed
        // for `split` to compute size_bytes, so this test is gated on
        // the cap being cheap to exceed via from-element construction.
        // 256 MB + 1 of zeroes allocates lazily on Linux (untouched
        // pages), so this stays fast.
        let over_cap = usize::try_from(MAX_LORO_SYNC_PAYLOAD_SIZE + 1).expect("64-bit usize");
        let msg = snapshot_msg(vec![0u8; over_cap], true);
        let err = send_sync_message(&mut a, &msg)
            .await
            .expect_err("over-cap payload must fail at the source");
        assert!(
            err.to_string().contains("too large to send"),
            "must be the sender-side cap error, got: {err}"
        );
    }

    // ── Threshold tripwires ───────────────────────────────────────────

    /// The inline threshold must guarantee the worst-case serialised
    /// JSON fits under the receive cap. Measured, not assumed: build
    /// the maximum-inflation message (all 0xFF bytes, Update variant
    /// with a `from_vv`) at exactly the threshold and check the actual
    /// serialised length against `MAX_MSG_SIZE`.
    #[test]
    fn inline_threshold_worst_case_json_fits_recv_cap() {
        let msg = SyncMessage::LoroSync {
            msg: LoroSyncMessage::Update {
                protocol_version: LORO_SYNC_PROTOCOL_VERSION,
                space_id: test_space_id(),
                from_vv: vec![0xff; 64],
                bytes: vec![0xff; LORO_INLINE_MAX_BYTES],
            },
            is_last: false,
        };
        let json = serde_json::to_string(&msg).expect("serialise worst case");
        assert!(
            json.len() <= SyncConnection::MAX_MSG_SIZE,
            "worst-case inline JSON ({} bytes) must fit MAX_MSG_SIZE ({}) — \
             if this fails, lower LORO_INLINE_MAX_BYTES",
            json.len(),
            SyncConnection::MAX_MSG_SIZE,
        );
    }

    /// Arithmetic tripwire (no allocation): 4 chars/byte plus 1 KB of
    /// envelope slack must stay under the cap.
    // Deliberate constant assertion — this is a tripwire against
    // someone editing LORO_INLINE_MAX_BYTES or MAX_MSG_SIZE without
    // re-checking the inflation arithmetic.
    #[allow(clippy::assertions_on_constants)]
    #[test]
    fn inline_threshold_arithmetic_headroom() {
        assert!(
            LORO_INLINE_MAX_BYTES * 4 + 1024 <= SyncConnection::MAX_MSG_SIZE,
            "LORO_INLINE_MAX_BYTES ({LORO_INLINE_MAX_BYTES}) * 4 + envelope slack must \
             stay under MAX_MSG_SIZE ({})",
            SyncConnection::MAX_MSG_SIZE,
        );
    }

    // ── #2200: zstd wire compression ─────────────────────────────────

    /// Round-trip one message with compression negotiated on the sender
    /// (mirrors production: the responder sets `peer_wire_compression`
    /// after reading the initiator's `HeadExchange { wire_compression:
    /// true }`). Drives both ends concurrently over the 64 KB duplex.
    async fn roundtrip_compressed(msg: SyncMessage) -> SyncMessage {
        let (mut a, mut b) = test_connection_pair().await;
        a.set_peer_wire_compression(true);
        let (sent, received) = tokio::join!(send_sync_message(&mut a, &msg), async {
            recv_sync_message(&mut b).await
        });
        sent.expect("send must succeed");
        received.expect("recv must succeed")
    }

    /// A highly-compressible over-threshold payload round-trips losslessly
    /// through the compressed chunked path.
    #[tokio::test]
    async fn compressed_payload_roundtrips_when_negotiated() {
        // Zeroes compress to almost nothing — exercises the compressed
        // branch end-to-end (encode on send, decode on recv).
        let msg = snapshot_msg(vec![0u8; 3_000_000], true);
        assert_eq!(roundtrip_compressed(msg.clone()).await, msg);
    }

    /// With compression negotiated, a compressible payload actually rides
    /// the wire as fewer bytes and the envelope's `compressed` flag is set.
    #[tokio::test]
    async fn compressed_payload_shrinks_wire_and_sets_flag() {
        let payload_len = 3_000_000usize;
        let msg = snapshot_msg(vec![0u8; payload_len], false);
        let (mut a, mut b) = test_connection_pair().await;
        a.set_peer_wire_compression(true);
        let (sent, result) = tokio::join!(send_sync_message(&mut a, &msg), async {
            let header = b.recv_json::<serde_json::Value>().await?;
            let size = header["header"]["size_bytes"].as_u64().expect("size_bytes");
            // Drain the compressed binary payload so the sender completes.
            let bytes = b.receive_binary_chunked(size).await?;
            Ok::<_, AppError>((header, bytes))
        });
        sent.expect("send must succeed");
        let (header, bytes) = result.expect("header + payload recv must succeed");
        assert_eq!(header["type"], serde_json::json!("LoroSyncChunked"));
        assert_eq!(
            header["compressed"],
            serde_json::json!(true),
            "envelope must flag the payload as compressed"
        );
        assert!(
            (bytes.len() as u64) < payload_len as u64,
            "compressed wire payload ({}) must be smaller than raw ({payload_len})",
            bytes.len(),
        );
        assert_eq!(
            header["header"]["size_bytes"].as_u64().unwrap(),
            bytes.len() as u64,
            "size_bytes must equal the actual compressed wire length",
        );
    }

    /// Mixed-version session: the peer never advertised `wire_compression`
    /// (default `false` on the connection), so the sender streams the
    /// chunked payload RAW — `compressed: false`, `size_bytes == raw len`.
    /// This is the old-#611-peer interop case.
    #[tokio::test]
    async fn uncompressed_when_peer_lacks_capability() {
        let payload_len = LORO_INLINE_MAX_BYTES + 500_000;
        let msg = snapshot_msg(vec![0u8; payload_len], true);
        let (mut a, mut b) = test_connection_pair().await;
        // NB: peer_wire_compression stays false (not negotiated).
        let (sent, result) = tokio::join!(send_sync_message(&mut a, &msg), async {
            let header = b.recv_json::<serde_json::Value>().await?;
            let bytes = b.receive_binary_chunked(payload_len as u64).await?;
            Ok::<_, AppError>((header, bytes))
        });
        sent.expect("send must succeed");
        let (header, bytes) = result.expect("header + payload recv must succeed");
        assert_eq!(
            header["compressed"],
            serde_json::json!(false),
            "an un-negotiated peer must receive raw (uncompressed) bytes"
        );
        assert_eq!(
            header["header"]["size_bytes"].as_u64().unwrap(),
            payload_len as u64,
            "raw path keeps size_bytes == raw payload length"
        );
        assert_eq!(bytes.len(), payload_len);
    }

    /// Even with compression negotiated, an incompressible payload (random
    /// bytes) falls back to raw rather than paying a size penalty — zstd
    /// would grow it, so `compressed` stays `false` and the round-trip is
    /// still lossless.
    #[tokio::test]
    async fn incompressible_payload_falls_back_to_raw() {
        // High-entropy content (xorshift64 PRNG): zstd cannot shrink it, so
        // the compressed size is >= raw and the sender falls back to raw.
        let len = LORO_INLINE_MAX_BYTES + 100_000;
        let mut state: u64 = 0x9E37_79B9_7F4A_7C15;
        let bytes: Vec<u8> = (0..len)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                // Low byte of a high-quality PRNG word — high entropy, no
                // narrowing cast (clippy::cast_possible_truncation).
                state.to_le_bytes()[0]
            })
            .collect();
        let payload_len = bytes.len();
        let msg = snapshot_msg(bytes, true);
        let (mut a, mut b) = test_connection_pair().await;
        a.set_peer_wire_compression(true);
        let (sent, result) = tokio::join!(send_sync_message(&mut a, &msg), async {
            let header = b.recv_json::<serde_json::Value>().await?;
            let size = header["header"]["size_bytes"].as_u64().expect("size_bytes");
            let bytes = b.receive_binary_chunked(size).await?;
            Ok::<_, AppError>((header, bytes))
        });
        sent.expect("send must succeed");
        let (header, _bytes) = result.expect("recv must succeed");
        assert_eq!(
            header["compressed"],
            serde_json::json!(false),
            "incompressible payload must fall back to the raw path"
        );
        assert_eq!(
            header["header"]["size_bytes"].as_u64().unwrap(),
            payload_len as u64,
            "raw fallback keeps size_bytes == raw payload length"
        );
    }

    // ── #2593: OpLogBatch inline/chunked transport ───────────────────

    /// Build an `OpLogBatch` with one record whose `payload` string is
    /// `payload_len` bytes, so the serialised batch straddles the inline
    /// threshold on demand.
    fn op_log_batch(payload_len: usize, is_last: bool) -> SyncMessage {
        SyncMessage::OpLogBatch {
            records: vec![OpTransfer {
                device_id: "device-A".into(),
                seq: 1,
                parent_seqs: None,
                hash: "deadbeef".into(),
                op_type: "create_block".into(),
                // Content-like payload (JSON string) of the requested size.
                payload: "y".repeat(payload_len),
                created_at: 1_749_988_800_000,
                origin: "user".into(),
            }],
            is_last,
        }
    }

    /// A small `OpLogBatch` keeps the exact pre-#2593 inline JSON shape —
    /// `type: "OpLogBatch"` with an inline `records` array — so a peer that
    /// understands #2481 but not the chunked envelope decodes it untouched.
    #[tokio::test]
    async fn op_log_batch_small_keeps_inline_wire_shape() {
        let msg = op_log_batch(64, true);
        let (mut a, mut b) = test_connection_pair().await;
        let (sent, raw) = tokio::join!(send_sync_message(&mut a, &msg), async {
            b.recv_json::<serde_json::Value>().await
        });
        sent.expect("send must succeed");
        let value = raw.expect("raw JSON recv must succeed");
        assert_eq!(value["type"], serde_json::json!("OpLogBatch"));
        assert_eq!(value["is_last"], serde_json::json!(true));
        assert!(
            value["records"].is_array(),
            "records must stay an inline JSON array — the pre-#2593 shape"
        );
    }

    /// A small batch round-trips through the helpers unchanged.
    #[tokio::test]
    async fn op_log_batch_small_roundtrips_inline() {
        let msg = op_log_batch(1000, false);
        assert_eq!(roundtrip(msg.clone()).await, msg);
    }

    /// An over-threshold `OpLogBatch` (a lone ~10 MB record — the #2593 case
    /// that the old skip guard dropped) rides the chunked transport and
    /// round-trips losslessly across multiple binary frames.
    #[tokio::test]
    async fn op_log_batch_oversized_roundtrips_chunked() {
        let msg = op_log_batch(10_000_000, true);
        assert_eq!(roundtrip(msg.clone()).await, msg);
    }

    /// An over-threshold send produces the `OpLogBatchChunked` header envelope
    /// on the wire (pin the transport shape the receiver dispatches on).
    #[tokio::test]
    async fn op_log_batch_oversized_produces_chunked_envelope() {
        let msg = op_log_batch(OP_LOG_BATCH_INLINE_MAX_BYTES + 500_000, false);
        let (mut a, mut b) = test_connection_pair().await;
        let (sent, result) = tokio::join!(send_sync_message(&mut a, &msg), async {
            let header = b.recv_json::<serde_json::Value>().await?;
            let size = header["size_bytes"].as_u64().expect("size_bytes");
            let bytes = b.receive_binary_chunked(size).await?;
            Ok::<_, AppError>((header, bytes))
        });
        sent.expect("send must succeed");
        let (header, bytes) = result.expect("header + payload recv must succeed");
        assert_eq!(header["type"], serde_json::json!("OpLogBatchChunked"));
        assert_eq!(header["is_last"], serde_json::json!(false));
        assert_eq!(header["compressed"], serde_json::json!(false));
        assert_eq!(header["size_bytes"].as_u64().unwrap(), bytes.len() as u64);
    }

    /// With compression negotiated, a (highly compressible) oversized text
    /// payload rides the wire as fewer bytes, the envelope's `compressed` flag
    /// is set, and it still round-trips.
    #[tokio::test]
    async fn op_log_batch_compressed_roundtrips_when_negotiated() {
        let msg = op_log_batch(10_000_000, true);
        assert_eq!(roundtrip_compressed(msg.clone()).await, msg);
    }

    /// Passing the transport-internal `OpLogBatchChunked` form to
    /// `send_sync_message` is a programmer error.
    #[tokio::test]
    async fn sending_op_log_batch_chunked_form_directly_is_rejected() {
        let (mut a, _b) = test_connection_pair().await;
        let msg = SyncMessage::OpLogBatchChunked {
            size_bytes: 1,
            is_last: true,
            compressed: false,
        };
        let err = send_sync_message(&mut a, &msg)
            .await
            .expect_err("OpLogBatchChunked must not be sendable directly");
        assert!(err.to_string().contains("transport-internal"));
    }

    /// An `OpLogBatchChunked` header advertising more than the sanity cap is
    /// rejected before any binary frame is read.
    #[tokio::test]
    async fn oversized_op_log_batch_chunked_header_is_rejected_before_payload() {
        let (mut a, mut b) = test_connection_pair().await;
        let header = SyncMessage::OpLogBatchChunked {
            size_bytes: MAX_OP_LOG_BATCH_PAYLOAD_SIZE + 1,
            is_last: true,
            compressed: false,
        };
        a.send_json(&header).await.expect("header send");
        let err = recv_sync_message(&mut b)
            .await
            .expect_err("over-cap header must be rejected");
        assert!(
            err.to_string().contains("advertises"),
            "must fail on the advertised size, got: {err}"
        );
    }

    /// Corrupt compressed data: a `LoroSyncChunked { compressed: true }`
    /// header followed by bytes that are not a valid zstd frame must be
    /// rejected as a clean error (not a panic) on decode.
    #[tokio::test]
    async fn corrupt_compressed_payload_is_rejected() {
        let (mut a, mut b) = test_connection_pair().await;
        let garbage = vec![0xab_u8; 32]; // not a zstd frame
        let header = SyncMessage::LoroSyncChunked {
            header: LoroSyncChunkedHeader::Snapshot {
                protocol_version: LORO_SYNC_PROTOCOL_VERSION,
                space_id: test_space_id(),
                size_bytes: garbage.len() as u64,
            },
            is_last: true,
            compressed: true,
        };
        let (sent, received) = tokio::join!(
            async {
                a.send_json(&header).await.expect("header send");
                a.send_binary_chunked(&garbage, BINARY_FRAME_CHUNK_SIZE)
                    .await
                    .expect("garbage payload send");
            },
            async { recv_sync_message(&mut b).await }
        );
        let () = sent;
        let err = received.expect_err("corrupt compressed payload must be rejected");
        assert!(
            err.to_string().contains("corrupt compressed"),
            "must be the corrupt-compressed error, got: {err}"
        );
    }
}
