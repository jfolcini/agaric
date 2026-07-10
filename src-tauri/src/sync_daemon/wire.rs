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
//! Both session loops (initiator `run_sync_session`, responder
//! `handle_incoming_sync`) route every send/recv through these
//! helpers. The snapshot and file-transfer sub-flows keep their plain
//! `send_json`/`recv_json` calls — their message kinds never carry
//! Loro payloads.
//!
//! ## Chunked-payload zstd compression (#2200)
//!
//! Loro export bytes are highly compressible (structured CBOR-like
//! framing, repeated container ids), so the chunked binary payload is
//! zstd-compressed when — and only when — the peer advertised
//! `HeadExchange { loro_chunk_zstd: true, .. }`. The compressed form is
//! announced by `LoroSyncChunked::compressed_size_bytes: Some(n)`; the
//! header's `size_bytes` keeps its pre-#2200 meaning (the
//! *uncompressed* payload length) and doubles as the receiver's exact
//! decompression-size bound — the decode buffer is capped at
//! `size_bytes` (itself capped at [`MAX_LORO_SYNC_PAYLOAD_SIZE`]
//! before any frame is read), so a decompression bomb is rejected
//! cleanly instead of allocating unbounded memory (mirrors the
//! `snapshot::codec` #428 guard, with an exact bound instead of a
//! ratio bound because the true size is known here). An incompressible
//! payload (zstd output not strictly smaller) falls back to the raw
//! pre-#2200 encoding, so `compressed_size_bytes < size_bytes` always
//! holds on the wire and is enforced on receive. The inline path is
//! untouched — it must stay byte-identical for old-peer interop, and
//! small payloads gain little from compression anyway.

use crate::error::AppError;
use crate::sync_constants::{
    BINARY_FRAME_CHUNK_SIZE, LORO_INLINE_MAX_BYTES, MAX_LORO_SYNC_PAYLOAD_SIZE,
};
use crate::sync_net::SyncConnection;
use crate::sync_protocol::SyncMessage;
use crate::sync_protocol::loro_sync_types::LoroSyncChunkedHeader;

/// zstd level for chunked LoroSync payloads (#2200). Matches the
/// snapshot blob encoder (`snapshot::codec::encode_snapshot`, level 3):
/// same order-of-magnitude payloads, same latency/ratio trade-off.
const LORO_CHUNK_ZSTD_LEVEL: i32 = 3;

/// Cap the zstd decompression window at 2^27 = 128 MB, mirroring
/// `snapshot::codec::DECODER_WINDOW_LOG_MAX`. Our own level-3 encoder
/// uses a far smaller window; this just refuses a frame whose header
/// demands an outsized window allocation before decoding starts.
const LORO_CHUNK_ZSTD_WINDOW_LOG_MAX: u32 = 27;

/// Send one [`SyncMessage`], choosing the transport encoding.
///
/// * `LoroSync` with payload `> LORO_INLINE_MAX_BYTES` → chunked
///   header + binary frames; the binary payload is zstd-compressed
///   when `peer_accepts_zstd` is set (#2200 — the peer advertised
///   `HeadExchange { loro_chunk_zstd: true, .. }`) and the compressed
///   form is strictly smaller than the raw payload.
/// * Everything else (including small `LoroSync`) → one JSON text
///   frame, identical to the pre-#611 wire format.
///
/// `peer_accepts_zstd` MUST be `false` unless the peer's capability
/// has actually been observed — a peer that never advertised
/// `loro_chunk_zstd` would consume the compressed bytes as raw Loro
/// payload and fail the import on every session (a permanent
/// mixed-version sync break).
///
/// `LoroSyncChunked` is a transport-internal encoding produced only by
/// this module; callers must always pass the plain `LoroSync` form, so
/// receiving one here is a programmer error and is rejected.
pub(crate) async fn send_sync_message(
    conn: &mut SyncConnection,
    msg: &SyncMessage,
    peer_accepts_zstd: bool,
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
            // #2200: compress for a capable peer. Falls back to the raw
            // encoding when zstd does not strictly shrink the payload
            // (already-compressed content), so the receiver-side
            // `compressed_size_bytes < size_bytes` invariant holds by
            // construction. Compression runs inline on the session task,
            // matching the snapshot codec's convention (level-3 zstd on
            // a bounded payload; the session is a dedicated exchange,
            // not a shared executor hot path).
            let compressed = if peer_accepts_zstd {
                let c = zstd::bulk::compress(payload, LORO_CHUNK_ZSTD_LEVEL).map_err(|e| {
                    AppError::InvalidOperation(format!(
                        "[sync_daemon::wire] zstd compression of LoroSync payload failed: {e}"
                    ))
                })?;
                (c.len() < payload.len()).then_some(c)
            } else {
                None
            };
            let (wire_payload, compressed_size_bytes): (&[u8], Option<u64>) = match &compressed {
                Some(c) => (c.as_slice(), Some(c.len() as u64)),
                None => (payload, None),
            };
            conn.send_json(&SyncMessage::LoroSyncChunked {
                header,
                is_last: *is_last,
                compressed_size_bytes,
            })
            .await?;
            conn.send_binary_chunked(wire_payload, BINARY_FRAME_CHUNK_SIZE)
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

/// Decompress a #2200 zstd chunked payload, bounding the decoded size
/// at exactly `expected_len` (the header's `size_bytes`, already
/// validated `<= MAX_LORO_SYNC_PAYLOAD_SIZE` by the caller).
///
/// Decompression-bomb guard: the decode buffer's capacity IS the
/// bound — `zstd::bulk::Decompressor::decompress` fails when the frame
/// produces more than `expected_len` bytes, so a bomb is rejected
/// after at most one over-cap write attempt instead of allocating its
/// advertised size. A short result (frame decoded to fewer bytes than
/// the header promised) is equally an error: `size_bytes` is the
/// authoritative payload length the reassembled `LoroSync` must have.
fn decompress_loro_chunk(compressed: &[u8], expected_len: u64) -> Result<Vec<u8>, AppError> {
    let capacity = usize::try_from(expected_len).map_err(|_| {
        AppError::InvalidOperation(format!(
            "[sync_daemon::wire] LoroSyncChunked size_bytes {expected_len} exceeds usize"
        ))
    })?;
    let mut decompressor = zstd::bulk::Decompressor::new().map_err(|e| {
        AppError::InvalidOperation(format!(
            "[sync_daemon::wire] zstd decompressor init failed: {e}"
        ))
    })?;
    decompressor
        .window_log_max(LORO_CHUNK_ZSTD_WINDOW_LOG_MAX)
        .map_err(|e| {
            AppError::InvalidOperation(format!("[sync_daemon::wire] zstd window cap failed: {e}"))
        })?;
    let bytes = decompressor.decompress(compressed, capacity).map_err(|e| {
        AppError::InvalidOperation(format!(
            "[sync_daemon::wire] zstd decompression of LoroSyncChunked payload failed \
             (expected at most {expected_len} bytes): {e}"
        ))
    })?;
    if bytes.len() as u64 != expected_len {
        return Err(AppError::InvalidOperation(format!(
            "[sync_daemon::wire] LoroSyncChunked payload decompressed to {} bytes but the \
             header advertised size_bytes {expected_len}",
            bytes.len(),
        )));
    }
    Ok(bytes)
}

/// Receive one [`SyncMessage`], reassembling the chunked transport
/// encoding back into a plain [`SyncMessage::LoroSync`].
///
/// On a `LoroSyncChunked` header this consumes exactly
/// `header.size_bytes()` (raw) or `compressed_size_bytes` (#2200,
/// zstd) of follow-up binary frames — rejecting over-run, wrong frame
/// types, and headers advertising more than
/// [`MAX_LORO_SYNC_PAYLOAD_SIZE`] or a `compressed_size_bytes` not
/// strictly smaller than `size_bytes`, all *before* reading any
/// payload frame, so a runaway header cannot trigger a large
/// allocation. A compressed payload is accepted regardless of what we
/// advertised (decompression support is unconditional in this build);
/// the decoded size is bounded at exactly `size_bytes` — see
/// [`decompress_loro_chunk`]. All other message kinds — including the
/// unchanged pre-#611 inline `LoroSync` shape and a pre-#2200 peer's
/// raw chunked encoding — pass through untouched, which is what keeps
/// old-build peers decodable.
pub(crate) async fn recv_sync_message(conn: &mut SyncConnection) -> Result<SyncMessage, AppError> {
    let msg: SyncMessage = conn.recv_json().await?;
    match msg {
        SyncMessage::LoroSyncChunked {
            header,
            is_last,
            compressed_size_bytes,
        } => {
            let size_bytes = header.size_bytes();
            if size_bytes > MAX_LORO_SYNC_PAYLOAD_SIZE {
                return Err(AppError::InvalidOperation(format!(
                    "[sync_daemon::wire] LoroSyncChunked header advertises {size_bytes} bytes \
                     (max {MAX_LORO_SYNC_PAYLOAD_SIZE})",
                )));
            }
            let bytes = match compressed_size_bytes {
                None => conn.receive_binary_chunked(size_bytes).await?,
                Some(compressed_size) => {
                    // #2200: the sender only compresses when it strictly
                    // shrinks the payload, so an equal-or-larger claim is
                    // malformed. Enforcing it here also transitively
                    // bounds the compressed-frame allocation below
                    // `MAX_LORO_SYNC_PAYLOAD_SIZE` (via `size_bytes`,
                    // checked above) before any frame is read.
                    if compressed_size >= size_bytes {
                        return Err(AppError::InvalidOperation(format!(
                            "[sync_daemon::wire] LoroSyncChunked header advertises \
                             compressed_size_bytes {compressed_size} >= size_bytes \
                             {size_bytes}; the compressed encoding must be strictly smaller",
                        )));
                    }
                    let compressed = conn.receive_binary_chunked(compressed_size).await?;
                    decompress_loro_chunk(&compressed, size_bytes)?
                }
            };
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
    /// `peer_accepts_zstd = false` — the pre-#2200 raw wire encoding.
    async fn roundtrip(msg: SyncMessage) -> SyncMessage {
        roundtrip_with(msg, false).await
    }

    /// [`roundtrip`] with the #2200 zstd capability flag under test
    /// control.
    async fn roundtrip_with(msg: SyncMessage, peer_accepts_zstd: bool) -> SyncMessage {
        let (mut a, mut b) = test_connection_pair().await;
        let (sent, received) =
            tokio::join!(send_sync_message(&mut a, &msg, peer_accepts_zstd), async {
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
                loro_chunk_zstd: false,
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
    /// it untouched. `peer_accepts_zstd = true` deliberately: even for
    /// a #2200-capable peer, the inline path must stay byte-identical
    /// (compression applies only to the chunked binary payload).
    #[tokio::test]
    async fn small_payload_keeps_pre_611_inline_wire_shape() {
        let msg = snapshot_msg(vec![0x10, 0x20, 0xff], true);
        let (mut a, mut b) = test_connection_pair().await;
        let (sent, raw) = tokio::join!(send_sync_message(&mut a, &msg, true), async {
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

    /// An over-threshold send to a NON-#2200 peer produces the chunked
    /// header envelope on the wire (pin the transport shape the
    /// receiver dispatches on) — with NO `compressed_size_bytes` key at
    /// all, so the envelope stays byte-compatible with the pre-#2200
    /// shape a post-#611 old peer decodes.
    #[tokio::test]
    async fn large_payload_produces_chunked_header_envelope() {
        let payload_len = LORO_INLINE_MAX_BYTES + 5;
        let msg = snapshot_msg(vec![0x42; payload_len], false);
        let (mut a, mut b) = test_connection_pair().await;
        let (sent, result) = tokio::join!(send_sync_message(&mut a, &msg, false), async {
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
        assert!(
            header.get("compressed_size_bytes").is_none(),
            "#2200: the raw chunked envelope must not carry a compressed_size_bytes key \
             (skip_serializing_if keeps the pre-#2200 shape), got: {header}"
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
            compressed_size_bytes: None,
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
            compressed_size_bytes: None,
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
            compressed_size_bytes: None,
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
            compressed_size_bytes: None,
        };
        let err = send_sync_message(&mut a, &msg, false)
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
        let err = send_sync_message(&mut a, &msg, false)
            .await
            .expect_err("over-cap payload must fail at the source");
        assert!(
            err.to_string().contains("too large to send"),
            "must be the sender-side cap error, got: {err}"
        );
    }

    // ── #2200: zstd-compressed chunked payloads ───────────────────────

    /// Round-trips with the peer's zstd capability advertised, across
    /// the size spectrum: empty and small payloads (which stay on the
    /// untouched inline path), a large compressible payload (chunked +
    /// compressed), and a multi-frame payload larger than the raw
    /// per-message cap.
    #[tokio::test]
    async fn zstd_roundtrips_empty_small_and_large_payloads() {
        for bytes in [
            vec![],
            vec![0x01],
            vec![0x10, 0x20, 0xff],
            // Large + compressible → the compressed chunked path.
            vec![0xab; LORO_INLINE_MAX_BYTES + 1],
            // Larger than MAX_MSG_SIZE raw, patterned so a chunk-
            // reassembly ordering bug cannot slip through equality.
            (0..12_000_000u32).map(|i| (i % 251) as u8).collect(),
        ] {
            let msg = snapshot_msg(bytes, true);
            assert_eq!(roundtrip_with(msg.clone(), true).await, msg);
        }
    }

    /// Update variant (with `from_vv`) over the compressed chunked
    /// path.
    #[tokio::test]
    async fn zstd_update_variant_roundtrips_chunked() {
        let msg = SyncMessage::LoroSync {
            msg: LoroSyncMessage::Update {
                protocol_version: LORO_SYNC_PROTOCOL_VERSION,
                space_id: test_space_id(),
                from_vv: vec![0xde, 0xad, 0xbe, 0xef],
                bytes: vec![0xab; LORO_INLINE_MAX_BYTES + 17],
            },
            is_last: false,
        };
        assert_eq!(roundtrip_with(msg.clone(), true).await, msg);
    }

    /// An over-threshold send to a #2200-capable peer produces the
    /// compressed envelope: `compressed_size_bytes` set (and strictly
    /// smaller than `size_bytes`), exactly that many binary bytes on
    /// the wire, and those bytes zstd-decompress back to the payload.
    #[tokio::test]
    async fn zstd_large_payload_produces_compressed_envelope() {
        let payload_len = LORO_INLINE_MAX_BYTES + 5;
        let payload = vec![0x42; payload_len];
        let msg = snapshot_msg(payload.clone(), false);
        let (mut a, mut b) = test_connection_pair().await;
        let (sent, result) = tokio::join!(send_sync_message(&mut a, &msg, true), async {
            let header = b.recv_json::<serde_json::Value>().await?;
            let compressed_len = header["compressed_size_bytes"]
                .as_u64()
                .ok_or_else(|| AppError::InvalidOperation("no compressed_size_bytes".into()))?;
            // Drain exactly the advertised compressed bytes so the
            // sender completes.
            let bytes = b.receive_binary_chunked(compressed_len).await?;
            Ok::<_, AppError>((header, bytes))
        });
        sent.expect("send must succeed");
        let (header, wire_bytes) = result.expect("header + payload recv must succeed");
        assert_eq!(header["type"], serde_json::json!("LoroSyncChunked"));
        assert_eq!(
            header["header"]["size_bytes"],
            serde_json::json!(payload_len),
            "size_bytes must keep its pre-#2200 meaning: the UNCOMPRESSED length"
        );
        let compressed_len = header["compressed_size_bytes"]
            .as_u64()
            .expect("compressed envelope must carry compressed_size_bytes");
        assert!(
            compressed_len < payload_len as u64,
            "constant payload must compress strictly smaller ({compressed_len} vs {payload_len})"
        );
        assert_eq!(wire_bytes.len() as u64, compressed_len);
        let decompressed = zstd::bulk::decompress(&wire_bytes, payload_len)
            .expect("wire bytes must be a valid zstd frame");
        assert_eq!(decompressed, payload);
    }

    /// An incompressible payload falls back to the raw encoding even
    /// for a zstd-capable peer (`compressed_size_bytes` absent, raw
    /// bytes on the wire) — zstd would only inflate it.
    #[tokio::test]
    async fn zstd_incompressible_payload_falls_back_to_raw() {
        // xorshift-ish PRNG bytes: high-entropy, so level-3 zstd cannot
        // shrink them below input size + frame overhead.
        let mut state = 0x9e37_79b9_7f4a_7c15u64;
        let payload: Vec<u8> = (0..LORO_INLINE_MAX_BYTES + 9)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                state.to_le_bytes()[3]
            })
            .collect();
        let payload_len = payload.len();
        let msg = snapshot_msg(payload.clone(), true);
        let (mut a, mut b) = test_connection_pair().await;
        let (sent, result) = tokio::join!(send_sync_message(&mut a, &msg, true), async {
            let header = b.recv_json::<serde_json::Value>().await?;
            let bytes = b.receive_binary_chunked(payload_len as u64).await?;
            Ok::<_, AppError>((header, bytes))
        });
        sent.expect("send must succeed");
        let (header, wire_bytes) = result.expect("header + payload recv must succeed");
        assert!(
            header.get("compressed_size_bytes").is_none(),
            "incompressible payload must fall back to the raw encoding, got: {header}"
        );
        assert_eq!(
            wire_bytes, payload,
            "raw fallback must ship the payload verbatim"
        );
    }

    /// Mixed-version fallback, old sender → new receiver: a pre-#2200
    /// peer's chunked envelope (hand-built JSON with NO
    /// `compressed_size_bytes` field) followed by raw binary frames
    /// still decodes.
    #[tokio::test]
    async fn old_peer_raw_chunked_shape_still_decodes() {
        let payload = vec![0x5a; 64];
        let old_shape: serde_json::Value = serde_json::json!({
            "type": "LoroSyncChunked",
            "header": {
                "kind": "snapshot",
                "protocol_version": 1,
                "space_id": "01HZ00000000000000000000SP",
                "size_bytes": payload.len(),
            },
            "is_last": true,
        });
        let (mut a, mut b) = test_connection_pair().await;
        let (sent, received) = tokio::join!(
            async {
                a.send_json(&old_shape).await?;
                a.send_binary(&payload).await
            },
            async { recv_sync_message(&mut b).await }
        );
        sent.expect("send must succeed");
        let expected = snapshot_msg(payload, true);
        assert_eq!(received.expect("decode old raw chunked shape"), expected);
    }

    /// A compressed header whose `compressed_size_bytes` is not
    /// strictly smaller than `size_bytes` is rejected before any
    /// binary frame is read.
    #[tokio::test]
    async fn compressed_size_not_smaller_is_rejected_before_payload() {
        let (mut a, mut b) = test_connection_pair().await;
        let header = SyncMessage::LoroSyncChunked {
            header: LoroSyncChunkedHeader::Snapshot {
                protocol_version: LORO_SYNC_PROTOCOL_VERSION,
                space_id: test_space_id(),
                size_bytes: 10,
            },
            is_last: true,
            compressed_size_bytes: Some(10),
        };
        a.send_json(&header).await.expect("header send");
        let err = recv_sync_message(&mut b)
            .await
            .expect_err("compressed_size_bytes >= size_bytes must be rejected");
        assert!(
            err.to_string().contains("strictly smaller"),
            "must be the compressed-size sanity error, got: {err}"
        );
    }

    /// Decompression-bomb guard: a tiny compressed frame that expands
    /// past the header-advertised `size_bytes` is rejected by the
    /// exact-size decode bound (never allocating the bomb's true
    /// size).
    #[tokio::test]
    async fn zstd_payload_expanding_past_advertised_size_is_rejected() {
        // 8 MB of zeroes compresses to well under 1 KB — a bomb
        // relative to the 2.4 MB the header admits to.
        let bomb = zstd::bulk::compress(&vec![0u8; 8_000_000], 3).expect("compress bomb");
        let advertised = (LORO_INLINE_MAX_BYTES + 1) as u64;
        assert!(
            (bomb.len() as u64) < advertised,
            "bomb must fit the header claim"
        );
        let (mut a, mut b) = test_connection_pair().await;
        let header = SyncMessage::LoroSyncChunked {
            header: LoroSyncChunkedHeader::Snapshot {
                protocol_version: LORO_SYNC_PROTOCOL_VERSION,
                space_id: test_space_id(),
                size_bytes: advertised,
            },
            is_last: true,
            compressed_size_bytes: Some(bomb.len() as u64),
        };
        a.send_json(&header).await.expect("header send");
        a.send_binary(&bomb).await.expect("bomb frame send");
        let err = recv_sync_message(&mut b)
            .await
            .expect_err("over-expanding zstd payload must be rejected");
        assert!(
            err.to_string().contains("decompression"),
            "must be the bounded-decompression error, got: {err}"
        );
    }

    /// A frame that decompresses to FEWER bytes than the header
    /// advertised is rejected too — `size_bytes` is the authoritative
    /// reassembled payload length.
    #[tokio::test]
    async fn zstd_payload_decompressing_short_is_rejected() {
        let actual_len = LORO_INLINE_MAX_BYTES + 1;
        let compressed =
            zstd::bulk::compress(&vec![0xabu8; actual_len], 3).expect("compress payload");
        let (mut a, mut b) = test_connection_pair().await;
        let header = SyncMessage::LoroSyncChunked {
            header: LoroSyncChunkedHeader::Snapshot {
                protocol_version: LORO_SYNC_PROTOCOL_VERSION,
                space_id: test_space_id(),
                // Advertise more than the frame actually holds.
                size_bytes: (actual_len + 1) as u64,
            },
            is_last: true,
            compressed_size_bytes: Some(compressed.len() as u64),
        };
        a.send_json(&header).await.expect("header send");
        a.send_binary(&compressed)
            .await
            .expect("payload frame send");
        let err = recv_sync_message(&mut b)
            .await
            .expect_err("short-decompressing payload must be rejected");
        assert!(
            err.to_string().contains("advertised size_bytes"),
            "must be the exact-length mismatch error, got: {err}"
        );
    }

    /// Garbage bytes where a zstd frame was announced fail cleanly.
    #[tokio::test]
    async fn garbage_zstd_payload_is_rejected() {
        let garbage = vec![0x00u8; 128];
        let (mut a, mut b) = test_connection_pair().await;
        let header = SyncMessage::LoroSyncChunked {
            header: LoroSyncChunkedHeader::Snapshot {
                protocol_version: LORO_SYNC_PROTOCOL_VERSION,
                space_id: test_space_id(),
                size_bytes: (LORO_INLINE_MAX_BYTES + 1) as u64,
            },
            is_last: true,
            compressed_size_bytes: Some(garbage.len() as u64),
        };
        a.send_json(&header).await.expect("header send");
        a.send_binary(&garbage).await.expect("garbage frame send");
        let err = recv_sync_message(&mut b)
            .await
            .expect_err("non-zstd payload bytes must be rejected");
        assert!(
            err.to_string().contains("decompression"),
            "must be the zstd decode error, got: {err}"
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
