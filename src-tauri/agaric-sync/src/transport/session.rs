//! [`SyncMessage`] framing over an iroh QUIC bi-stream (#78, plan #3464 slice 1).
//!
//! # Why this is so much smaller than `sync_daemon::wire`
//!
//! `wire.rs` is ~270 lines of production code that exists almost entirely to work
//! around one property of the old transport: a WebSocket message is a *message*, and
//! `SyncConnection` caps it at 10 MB. A per-space Loro snapshot serialises as a JSON
//! number array (~4 bytes of text per byte of payload), so any vault past ~2.5 MB of
//! Loro state produced an over-cap frame and the session failed forever. `wire.rs`
//! answers that with a second encoding per oversized variant: a small JSON header, then
//! the payload split across `BINARY_FRAME_CHUNK_SIZE` binary frames, optionally
//! zstd-compressed, reassembled on receive before the orchestrator ever sees it.
//!
//! A QUIC stream has none of that shape. It is a reliable, ordered, flow-controlled
//! byte stream with no message boundary and no length ceiling, so the only thing the
//! transport still owes the protocol is *where one message ends* — a length prefix.
//! There is no chunking layer here because there is nothing to chunk around: the
//! congestion controller and the connection's flow-control windows already do the work
//! `BINARY_FRAME_CHUNK_SIZE` was hand-rolling.
//!
//! # What did **not** get simpler, and is worth knowing
//!
//! The 4× JSON inflation is a property of `SyncMessage`'s *shape*, not of WebSocket:
//! `LoroSyncMessage::{Snapshot,Update}.bytes` is a `Vec<u8>` inside a
//! `#[serde(tag = "type")]` enum, and serde_json has no choice but to write it as
//! `[104,101,...]`. QUIC removes the *cap* that made the inflation fatal, so nothing
//! here has to care — but a later slice that wants Loro payloads to cost what they
//! weigh will have to change the encoding (a binary serde format, or moving bulk onto
//! its own stream), not the transport. This module deliberately keeps the existing
//! serde encoding so this slice tests the transport claim and nothing else.
//!
//! # The size cap is not decoration
//!
//! The length prefix is attacker-controlled in exactly the same sense every other field
//! is (the threat model is the user's own paired devices, so "attacker" here means
//! "corruption or a version skew"). Allocating whatever it says would turn four
//! mistyped bytes into a 4 GB allocation, so it is bounded by [`MAX_FRAME_SIZE`]
//! *before* the buffer is created — the same discipline `wire.rs` applies to
//! `LoroSyncChunkedHeader::size_bytes`, and the same constant.

use iroh::endpoint::{RecvStream, SendStream};

use agaric_core::error::AppError;

use crate::sync_constants::MAX_LORO_SYNC_PAYLOAD_SIZE;
use crate::sync_protocol::SyncMessage;

/// Largest single framed [`SyncMessage`] accepted, in bytes.
///
/// Deliberately the existing [`MAX_LORO_SYNC_PAYLOAD_SIZE`] (256 MB) rather than a new
/// number: that constant is already the crate's answer to "the largest protocol payload
/// we will allocate for before we have seen the bytes", and it bounds both chunked
/// sub-flows in `sync_daemon::wire`. Under QUIC there is no separate header to bound,
/// so the one cap applies directly to the frame.
pub const MAX_FRAME_SIZE: u64 = MAX_LORO_SYNC_PAYLOAD_SIZE;

/// Bytes of length prefix. A `u32` covers [`MAX_FRAME_SIZE`] with three orders of
/// magnitude to spare; a `u64` would only widen the range of values the cap rejects.
const LEN_PREFIX_BYTES: usize = 4;

fn wire_err(msg: impl Into<String>) -> AppError {
    AppError::InvalidOperation(format!("[transport::session] {}", msg.into()))
}

/// Write one [`SyncMessage`] to `send` as `u32` big-endian length + serde-JSON body.
///
/// The stream is left open: a session is many messages on one bi-stream, so finishing
/// is the caller's decision, not the frame's.
///
/// # Errors
/// If the message fails to serialise, exceeds [`MAX_FRAME_SIZE`], or the stream is
/// closed / reset by the peer.
pub async fn send_sync_message(send: &mut SendStream, msg: &SyncMessage) -> Result<(), AppError> {
    let payload = serde_json::to_vec(msg).map_err(|e| wire_err(format!("serialize: {e}")))?;
    let len = payload.len() as u64;
    if len > MAX_FRAME_SIZE {
        return Err(wire_err(format!(
            "message too large to send: {len} bytes (max {MAX_FRAME_SIZE})"
        )));
    }
    // Infallible given the check above (`MAX_FRAME_SIZE` < `u32::MAX`), but expressed as
    // a conversion rather than a cast so a future raise of the cap fails loudly here
    // instead of silently truncating the prefix.
    let prefix = u32::try_from(len)
        .map_err(|_| wire_err(format!("length {len} does not fit the frame prefix")))?;
    send.write_all(&prefix.to_be_bytes())
        .await
        .map_err(|e| wire_err(format!("write length prefix: {e}")))?;
    send.write_all(&payload)
        .await
        .map_err(|e| wire_err(format!("write payload: {e}")))?;
    Ok(())
}

/// Read one [`SyncMessage`] from `recv`, the inverse of [`send_sync_message`].
///
/// # Errors
/// If the peer closed the stream mid-frame, the announced length exceeds
/// [`MAX_FRAME_SIZE`], or the body does not deserialise.
pub async fn recv_sync_message(recv: &mut RecvStream) -> Result<SyncMessage, AppError> {
    let mut prefix = [0u8; LEN_PREFIX_BYTES];
    recv.read_exact(&mut prefix)
        .await
        .map_err(|e| wire_err(format!("read length prefix: {e}")))?;
    let len = u64::from(u32::from_be_bytes(prefix));
    // Bound BEFORE allocating. This is the whole reason the prefix is checked at all.
    if len > MAX_FRAME_SIZE {
        return Err(wire_err(format!(
            "peer announced a {len}-byte message (max {MAX_FRAME_SIZE}); refusing to allocate"
        )));
    }
    let capacity = usize::try_from(len).map_err(|_| {
        wire_err(format!(
            "announced length {len} exceeds this platform's usize"
        ))
    })?;
    let mut payload = vec![0u8; capacity];
    recv.read_exact(&mut payload)
        .await
        .map_err(|e| wire_err(format!("read payload: {e}")))?;
    serde_json::from_slice(&payload).map_err(|e| wire_err(format!("deserialize: {e}")))
}

#[cfg(test)]
mod tests {
    //! # What these prove, and how each was forced red
    //!
    //! The centrepiece is [`tests::two_lan_only_endpoints_complete_a_real_sync_handshake`]:
    //! two real iroh endpoints, two real `SyncOrchestrator`s over two real migrated
    //! databases, a handshake carried end to end on a QUIC bi-stream. Plan #3464's D1
    //! claims the protocol FSM is transport-agnostic; this is the test that can falsify
    //! that claim, and it did not.
    //!
    //! It asserts [`SyncOrchestrator::is_succeeded`], never `is_terminal`. `Failed(_)`
    //! is terminal too, and a handshake test satisfied by `Failed` proves only that the
    //! process did not hang — [`handshake_assertion_rejects_a_failed_terminal_state`]
    //! is the standing evidence that the distinction is live.

    use std::{
        net::{Ipv4Addr, SocketAddr, SocketAddrV4},
        sync::Arc,
        time::Duration,
    };

    use iroh::endpoint::Builder;
    use iroh_dns::dns::DnsResolver;
    use sqlx::SqlitePool;
    use tempfile::TempDir;

    use super::*;
    use crate::apply_host::ApplyHost;
    use crate::apply_host::test_support::RecordingApplyHost;
    use crate::sync_protocol::{SyncOrchestrator, SyncState};
    use crate::transport::endpoint::{RecordingResolver, lan_only};

    const SYNC_ALPN: &[u8] = b"agaric/sync/0";

    /// Whole-handshake budget. A LAN handshake was measured at 0.07 s in the #3462
    /// spike; 30 s is a hang detector, not a performance bound, and exists so a
    /// regression that deadlocks the pump fails the suite instead of wedging CI.
    const SESSION_TIMEOUT: Duration = Duration::from_secs(30);

    fn lan_builder() -> Builder {
        lan_only(
            SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)),
            8,
            DnsResolver::custom(RecordingResolver::new()),
        )
        .expect("loopback /8 is a valid LAN bind")
    }

    async fn test_pool() -> (SqlitePool, TempDir) {
        agaric_store::test_support::test_pool().await
    }

    /// Build an orchestrator over `pool` that knows which peer it is talking to.
    ///
    /// `with_expected_remote_id` is not test scaffolding papered over a gap: two empty
    /// vaults advertise no heads at all, so neither side can learn the other's
    /// `DeviceId` from the protocol, and `SyncComplete` deliberately fails rather than
    /// write a `peer_id = ""` row. In production the daemon supplies this from the peer
    /// identity it authenticated — under the port, from the QUIC-authenticated
    /// `EndpointId` (D3). Supplying it here is modelling that, not bypassing it.
    fn orchestrator(
        pool: &SqlitePool,
        device_id: &str,
        peer_device_id: &str,
        host: &Arc<RecordingApplyHost>,
    ) -> SyncOrchestrator {
        let erased: Arc<dyn ApplyHost> = host.clone();
        SyncOrchestrator::new(pool.clone(), device_id.to_owned(), erased)
            .with_expected_remote_id(peer_device_id.to_owned())
    }

    /// Pump one side of a session until it is terminal, sending every message the
    /// orchestrator produces. Mirrors the `handle_message` + `next_message` drain
    /// contract the FSM documents, with the transport swapped for QUIC.
    async fn pump(
        orch: &mut SyncOrchestrator,
        send: &mut SendStream,
        recv: &mut RecvStream,
    ) -> Result<(), AppError> {
        while !orch.is_terminal() {
            let incoming = recv_sync_message(recv).await?;
            if let Some(reply) = orch.handle_message(incoming).await? {
                send_sync_message(send, &reply).await?;
            }
            while let Some(queued) = orch.next_message() {
                send_sync_message(send, &queued).await?;
            }
        }
        Ok(())
    }

    // -- The slice's load-bearing test ---------------------------------------

    #[tokio::test(flavor = "multi_thread")]
    async fn two_lan_only_endpoints_complete_a_real_sync_handshake() {
        let (responder_pool, _responder_dir) = test_pool().await;
        let (initiator_pool, _initiator_dir) = test_pool().await;
        let responder_host = Arc::new(RecordingApplyHost::new());
        let initiator_host = Arc::new(RecordingApplyHost::new());

        let listener = lan_builder()
            .alpns(vec![SYNC_ALPN.to_vec()])
            .bind()
            .await
            .expect("responder endpoint binds");
        let listener_addr = listener.addr();
        let connector = lan_builder()
            .bind()
            .await
            .expect("initiator endpoint binds");

        let responder_task = tokio::spawn({
            let listener = listener.clone();
            let host = responder_host.clone();
            async move {
                let mut orch = orchestrator(
                    &responder_pool,
                    "device-responder",
                    "device-initiator",
                    &host,
                );
                let incoming = listener.accept().await.expect("an inbound connection");
                let conn = incoming.await.expect("QUIC handshake completes");
                let (mut send, mut recv) = conn.accept_bi().await.expect("peer opens a bi-stream");
                pump(&mut orch, &mut send, &mut recv)
                    .await
                    .expect("responder pumps to a terminal state");
                let outcome = (orch.is_succeeded(), orch.state.clone());
                // The responder reaches `Complete` the moment it *queues* its
                // `SyncComplete`, one round trip before the initiator has read it.
                // Returning here drops the `Connection`, which closes it immediately and
                // discards the in-flight frame — the first run of this test failed
                // exactly that way ("read length prefix: connection lost"). FIN the
                // stream, then wait for the initiator to close the connection. This is
                // a real property of the port, not test-only ceremony: the session
                // driver rewrite will owe the same shutdown discipline.
                send.finish().expect("responder stream finishes");
                conn.closed().await;
                outcome
            }
        });

        let (initiator_succeeded, initiator_state) = tokio::time::timeout(SESSION_TIMEOUT, async {
            let mut orch = orchestrator(
                &initiator_pool,
                "device-initiator",
                "device-responder",
                &initiator_host,
            );
            let conn = connector
                .connect(listener_addr, SYNC_ALPN)
                .await
                .expect("initiator connects to the LAN endpoint");
            let (mut send, mut recv) = conn.open_bi().await.expect("initiator opens a bi-stream");

            let first = orch
                .start()
                .await
                .expect("orchestrator produces HeadExchange");
            assert!(
                matches!(first, SyncMessage::HeadExchange { .. }),
                "the session must open with HeadExchange, got {first:?}"
            );
            send_sync_message(&mut send, &first)
                .await
                .expect("HeadExchange goes out over QUIC");

            pump(&mut orch, &mut send, &mut recv)
                .await
                .expect("initiator pumps to a terminal state");
            let outcome = (orch.is_succeeded(), orch.state.clone());
            // The initiator is the side that knows the session is over, so it is the
            // side that closes; this is what releases the responder's `conn.closed()`.
            conn.close(0u32.into(), b"session complete");
            outcome
        })
        .await
        .expect("the handshake completes well inside the hang budget");

        let (responder_succeeded, responder_state) =
            tokio::time::timeout(SESSION_TIMEOUT, responder_task)
                .await
                .expect("responder finishes inside the hang budget")
                .expect("responder task does not panic");

        listener.close().await;
        connector.close().await;

        // `is_succeeded`, not `is_terminal`: `Failed(_)` and `ResetRequired` are both
        // terminal, and either would mean the port does not work.
        assert!(
            initiator_succeeded,
            "initiator did not reach a SUCCESSFUL terminal state over QUIC; ended in {initiator_state:?}"
        );
        assert!(
            responder_succeeded,
            "responder did not reach a SUCCESSFUL terminal state over QUIC; ended in {responder_state:?}"
        );
        assert_eq!(initiator_state, SyncState::Complete);
        assert_eq!(responder_state, SyncState::Complete);
    }

    /// Standing evidence that the assertion above discriminates. If `is_succeeded`
    /// ever starts accepting `Failed`, the handshake test silently stops proving
    /// anything and this one goes red in its place.
    #[tokio::test]
    async fn handshake_assertion_rejects_a_failed_terminal_state() {
        let (pool, _dir) = test_pool().await;
        let host = Arc::new(RecordingApplyHost::new());
        let mut orch = orchestrator(&pool, "device-a", "device-b", &host);

        // A `SyncComplete` in `Idle` is a protocol violation; the FSM faults the
        // session rather than completing it.
        let err = orch
            .handle_message(SyncMessage::SyncComplete {
                last_hash: String::new(),
            })
            .await
            .expect_err("SyncComplete in Idle is rejected");

        assert!(orch.is_terminal(), "a faulted session is terminal: {err}");
        assert!(
            !orch.is_succeeded(),
            "is_succeeded must NOT accept {:?}; the handshake test's assertion would be vacuous",
            orch.state
        );
    }

    // -- Framing ------------------------------------------------------------

    /// Round-trip over a real QUIC stream, not an in-memory duplex: the framing has to
    /// survive the transport it is written for.
    #[tokio::test(flavor = "multi_thread")]
    async fn framing_round_trips_a_sync_message_over_quic() {
        let listener = lan_builder()
            .alpns(vec![SYNC_ALPN.to_vec()])
            .bind()
            .await
            .expect("listener binds");
        let listener_addr = listener.addr();
        let connector = lan_builder().bind().await.expect("connector binds");

        let echo = tokio::spawn({
            let listener = listener.clone();
            async move {
                let conn = listener
                    .accept()
                    .await
                    .expect("inbound connection")
                    .await
                    .expect("handshake completes");
                let (mut send, mut recv) = conn.accept_bi().await.expect("bi-stream");
                let got = recv_sync_message(&mut recv).await.expect("frame decodes");
                send_sync_message(&mut send, &got)
                    .await
                    .expect("echo writes");
                send.finish().expect("echo stream finishes");
                // Hold the connection open until the peer has read the echo.
                conn.closed().await;
            }
        });

        let sent = SyncMessage::Error {
            message: "round-trip probe".to_owned(),
        };
        let conn = connector
            .connect(listener_addr, SYNC_ALPN)
            .await
            .expect("connects");
        let (mut send, mut recv) = conn.open_bi().await.expect("bi-stream");
        send_sync_message(&mut send, &sent)
            .await
            .expect("frame writes");
        let got = recv_sync_message(&mut recv).await.expect("echo decodes");
        assert_eq!(got, sent, "the message did not survive the QUIC round trip");

        conn.close(0u32.into(), b"done");
        // Bounded like every other network await here: a regression in the echo task
        // should fail this test, not wedge the suite until the harness timeout.
        tokio::time::timeout(SESSION_TIMEOUT, echo)
            .await
            .expect("echo task finishes within the session budget")
            .expect("echo task does not panic");
        listener.close().await;
        connector.close().await;
    }

    /// A truncated frame must surface as an error, not as a hang or a partial decode —
    /// the receiver has to distinguish "stream ended" from "message ended".
    #[tokio::test(flavor = "multi_thread")]
    async fn a_truncated_frame_is_an_error_not_a_partial_message() {
        let listener = lan_builder()
            .alpns(vec![SYNC_ALPN.to_vec()])
            .bind()
            .await
            .expect("listener binds");
        let listener_addr = listener.addr();
        let connector = lan_builder().bind().await.expect("connector binds");

        let reader = tokio::spawn({
            let listener = listener.clone();
            async move {
                let conn = listener
                    .accept()
                    .await
                    .expect("inbound connection")
                    .await
                    .expect("handshake completes");
                let (_send, mut recv) = conn.accept_bi().await.expect("bi-stream");
                recv_sync_message(&mut recv).await
            }
        });

        let conn = connector
            .connect(listener_addr, SYNC_ALPN)
            .await
            .expect("connects");
        let (mut send, _recv) = conn.open_bi().await.expect("bi-stream");
        // Announce 64 bytes, deliver 4, then close: exactly the shape a crash or a
        // mismatched framing version produces.
        send.write_all(&64u32.to_be_bytes())
            .await
            .expect("prefix writes");
        send.write_all(b"\x00\x01\x02\x03")
            .await
            .expect("stub payload writes");
        send.finish().expect("stream finishes");
        conn.closed().await;

        let err = reader
            .await
            .expect("reader task does not panic")
            .expect_err("a truncated frame must not decode");
        let text = err.to_string();
        assert!(
            text.contains("read payload"),
            "expected a payload-read failure, got: {text}"
        );

        listener.close().await;
        connector.close().await;
    }

    /// The cap has to be enforced against the *announced* length, before the buffer
    /// exists. Reading the body first and checking afterwards is exactly the bug.
    #[tokio::test(flavor = "multi_thread")]
    async fn an_oversized_length_prefix_is_refused_before_allocating() {
        let listener = lan_builder()
            .alpns(vec![SYNC_ALPN.to_vec()])
            .bind()
            .await
            .expect("listener binds");
        let listener_addr = listener.addr();
        let connector = lan_builder().bind().await.expect("connector binds");

        let reader = tokio::spawn({
            let listener = listener.clone();
            async move {
                let conn = listener
                    .accept()
                    .await
                    .expect("inbound connection")
                    .await
                    .expect("handshake completes");
                let (_send, mut recv) = conn.accept_bi().await.expect("bi-stream");
                recv_sync_message(&mut recv).await
            }
        });

        let conn = connector
            .connect(listener_addr, SYNC_ALPN)
            .await
            .expect("connects");
        let (mut send, _recv) = conn.open_bi().await.expect("bi-stream");
        // `u32::MAX` is ~16× the cap. No body follows, deliberately: if the receiver
        // ever reads before it bounds, this test hangs instead of failing, which is
        // itself the signal.
        send.write_all(&u32::MAX.to_be_bytes())
            .await
            .expect("prefix writes");
        send.finish().expect("stream finishes");

        let err = tokio::time::timeout(SESSION_TIMEOUT, reader)
            .await
            .expect("the cap must reject without waiting for a body")
            .expect("reader task does not panic")
            .expect_err("an over-cap length must be refused");
        let text = err.to_string();
        assert!(
            text.contains("refusing to allocate"),
            "expected the pre-allocation cap to fire, got: {text}"
        );

        conn.close(0u32.into(), b"done");
        listener.close().await;
        connector.close().await;
    }

    /// `MAX_FRAME_SIZE` must stay the crate's existing payload bound. A local number
    /// here would drift away from the caps the protocol layer enforces.
    #[test]
    fn frame_cap_is_the_existing_payload_cap() {
        assert_eq!(MAX_FRAME_SIZE, MAX_LORO_SYNC_PAYLOAD_SIZE);
        assert!(
            MAX_FRAME_SIZE <= u64::from(u32::MAX),
            "the cap must fit the length prefix"
        );
    }
}
