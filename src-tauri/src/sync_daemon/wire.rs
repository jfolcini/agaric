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
//! `LoroSyncChunked` loudly — see `sync_protocol::orchestrator`).
//!
//! Both session loops (initiator `run_sync_session`, responder
//! `handle_incoming_sync`) route every send/recv through these
//! helpers. The snapshot and file-transfer sub-flows keep their plain
//! `send_json`/`recv_json` calls — their message kinds never carry
//! Loro payloads.

use crate::error::AppError;
use crate::sync_constants::{
    BINARY_FRAME_CHUNK_SIZE, LORO_INLINE_MAX_BYTES, MAX_LORO_SYNC_PAYLOAD_SIZE,
};
use crate::sync_net::SyncConnection;
use crate::sync_protocol::SyncMessage;
use crate::sync_protocol::loro_sync_types::LoroSyncChunkedHeader;

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
            let (header, payload) = LoroSyncChunkedHeader::split(loro);
            if payload.len() <= LORO_INLINE_MAX_BYTES {
                // Inline: worst-case JSON (4 chars/byte + envelope) is
                // guaranteed under the peer's receive cap — see the
                // `LORO_INLINE_MAX_BYTES` rationale in `sync_constants`
                // and the `inline_threshold_*` tripwires below.
                return conn.send_json(msg).await;
            }
            if header.size_bytes() > MAX_LORO_SYNC_PAYLOAD_SIZE {
                // Mirror the receiver's sanity bound so an over-cap
                // payload fails loudly at the source instead of after
                // shipping 256 MB the peer will reject anyway.
                return Err(AppError::InvalidOperation(format!(
                    "[sync_daemon::wire] LoroSync payload too large to send: {} bytes \
                     (max {MAX_LORO_SYNC_PAYLOAD_SIZE})",
                    header.size_bytes(),
                )));
            }
            conn.send_json(&SyncMessage::LoroSyncChunked {
                header,
                is_last: *is_last,
            })
            .await?;
            conn.send_binary_chunked(payload, BINARY_FRAME_CHUNK_SIZE)
                .await
        }
        SyncMessage::LoroSyncChunked { .. } => Err(AppError::InvalidOperation(
            "[sync_daemon::wire] LoroSyncChunked is a transport-internal encoding; \
             pass the plain LoroSync form to send_sync_message"
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
        SyncMessage::LoroSyncChunked { header, is_last } => {
            let size_bytes = header.size_bytes();
            if size_bytes > MAX_LORO_SYNC_PAYLOAD_SIZE {
                return Err(AppError::InvalidOperation(format!(
                    "[sync_daemon::wire] LoroSyncChunked header advertises {size_bytes} bytes \
                     (max {MAX_LORO_SYNC_PAYLOAD_SIZE})",
                )));
            }
            let bytes = conn.receive_binary_chunked(size_bytes).await?;
            Ok(SyncMessage::LoroSync {
                msg: header.into_message(bytes),
                is_last,
            })
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
}
