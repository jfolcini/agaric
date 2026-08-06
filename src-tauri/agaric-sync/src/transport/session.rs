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

use crate::sync_constants::{BINARY_FRAME_CHUNK_SIZE, MAX_LORO_SYNC_PAYLOAD_SIZE};
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

/// How much of an announced frame is reserved before those bytes have arrived.
///
/// [`MAX_FRAME_SIZE`] bounds what a frame may cost in total; it does not bound what a
/// four-byte prefix may reserve up front. Those are different levers, and only the
/// second one turns a wrong number into an allocation: a prefix announcing exactly
/// [`MAX_FRAME_SIZE`] is *within* the cap, so a single eager `vec![0; capacity]`
/// committed 256 MB before reading a single body byte. Once a session driver holds
/// several connections at once that multiplies — N peers × 256 MB, from 4N bytes.
///
/// So the buffer grows in steps as bytes actually land. The step is
/// [`BINARY_FRAME_CHUNK_SIZE`] rather than a number chosen here: that is the crate's
/// existing, shipped answer to "how much binary do we move at once", used by the
/// snapshot, attachment and chunked-LoroSync flows alike. Reusing it keeps one tunable
/// instead of two, and means this value has already run in production.
///
/// A delivered frame is then sized in one exact step rather than grown, which matters
/// more than it looks. Letting the buffer keep growing geometrically would end at a
/// capacity ~1.25x the frame and hold both halves live across the final reallocation —
/// for a 256 MB frame, a transient peak *above* the eager form it replaces, on exactly
/// the memory-tight targets that motivated the change. Chunking is there to stop an
/// unpaid claim from allocating; it is not something to keep doing once the peer has
/// paid.
///
/// What that leaves is an amplification of this constant against `MAX_FRAME_SIZE` — a
/// peer must actually deliver 5 MB to have 256 MB reserved, rather than 4 bytes. The
/// threat model is the user's own paired devices, so the aim is that corruption or a
/// version skew cannot turn a wrong number into an allocation; a peer willing to send
/// 5 MB per frame is one that has already been authenticated by the QUIC handshake.
const READ_CHUNK_BYTES: usize = BINARY_FRAME_CHUNK_SIZE;

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

/// The one thing [`read_body`] needs from a receive stream.
///
/// It exists so the growth policy can be driven by a reader that *refuses* to deliver.
/// "The buffer does not reserve what has not arrived" is a claim about capacity, and no
/// observable behaviour distinguishes the eager form from the incremental one — same
/// error, same timing. Against a real [`RecvStream`] the property is therefore
/// untestable; against this trait it is one assertion.
trait BodyReader {
    /// Fill `buf` completely, or fail.
    ///
    /// `Send` is spelled out because the returned future is opaque: without it a
    /// caller that spawns a session over a generic `R` fails to compile, and the
    /// concrete [`RecvStream`] impl only works today by auto-trait leakage.
    fn fill_exact(&mut self, buf: &mut [u8]) -> impl Future<Output = Result<(), AppError>> + Send;
}

impl BodyReader for RecvStream {
    async fn fill_exact(&mut self, buf: &mut [u8]) -> Result<(), AppError> {
        RecvStream::read_exact(self, buf)
            .await
            .map_err(|e| wire_err(format!("read payload: {e}")))
    }
}

/// Read exactly `capacity` bytes into `payload`, growing it as they arrive.
///
/// `payload` is a caller-supplied `&mut Vec` rather than a return value so that a
/// failed read leaves the partially-grown buffer observable — which is what makes the
/// reservation policy assertable.
///
/// The limit of that guard is worth knowing: it binds *this* function, so a
/// `Vec::with_capacity(capacity)` reintroduced at the [`recv_sync_message`] call site
/// would restore the amplification with every test still green. The buffer is created
/// empty there for that reason, and this is the only thing that should ever size it.
///
/// # Why a scratch buffer instead of `resize`
///
/// `payload.resize(capacity, 0)` would write zeros across the whole frame — for a
/// 256 MB frame, a ~251 MB memset of bytes the very next line overwrites, and worse,
/// it *touches* every page, committing the resident set up front. That is the cost the
/// incremental growth exists to avoid, so paying it in the growth itself would defeat
/// the point on precisely the memory-tight targets that motivated this. The zeroing
/// cannot simply be skipped: the crate denies `unsafe_code`, so `spare_capacity_mut`
/// is not available and a `&mut [u8]` to hand the reader must be initialised memory.
///
/// So one chunk-sized scratch buffer is initialised once (`vec![0u8; n]` takes the
/// `alloc_zeroed` path — lazily-mapped zero pages, not a memset), and `payload` is
/// grown with `extend_from_slice` from the bytes that actually arrive. `payload`'s
/// *capacity* is reserved ahead in exactly two steps, but its *length* — and so its
/// resident footprint — only ever advances by delivered bytes. That is also what makes
/// under-reading detectable: `payload.len()` is now decided by the reader rather than
/// by this function's own sizing, so a dropped read is a short buffer, not a silently
/// zero-filled one.
async fn read_body<R: BodyReader>(
    recv: &mut R,
    capacity: usize,
    payload: &mut Vec<u8>,
) -> Result<(), AppError> {
    if capacity == 0 {
        // An empty frame is a legal frame (`SyncMessage` never serialises to one, but
        // the prefix can say zero). Returning here rather than falling through keeps
        // the reader untouched: a zero-length `fill_exact` is a request for nothing.
        return Ok(());
    }

    // Reserve one chunk at most, whatever was announced. Until a byte arrives the
    // length is a claim, and this is the only allocation a claim can buy.
    let first = READ_CHUNK_BYTES.min(capacity);
    let mut scratch = vec![0u8; first];
    payload.reserve_exact(first);

    recv.fill_exact(&mut scratch).await?;
    payload.extend_from_slice(&scratch);

    if capacity > first {
        // A full chunk arrived, so the peer has now paid for the length rather than
        // merely asserting it. Reserve the remainder in ONE exact step: letting the
        // capacity grow geometrically from here would end at ~1.25x the frame and hold
        // both halves live across the final realloc — worse than the eager form it
        // replaced. Only the address space is reserved; the pages are dirtied as the
        // `extend_from_slice`s below actually fill them.
        payload.reserve_exact(capacity - first);
        while payload.len() < capacity {
            let want = (capacity - payload.len()).min(scratch.len());
            recv.fill_exact(&mut scratch[..want]).await?;
            payload.extend_from_slice(&scratch[..want]);
        }
    }
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
    let mut payload: Vec<u8> = Vec::new();
    read_body(recv, capacity, &mut payload).await?;
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

    /// The byte the synthetic peer sends at `offset` into a frame.
    ///
    /// The period is 251 — the largest prime below 256 — and not 256, because
    /// [`READ_CHUNK_BYTES`] is 5,000,000, a multiple of 256: with a period of 256 every
    /// chunk would be byte-identical and a skipped, repeated or reordered read would be
    /// indistinguishable from the right one. A period coprime to the chunk length gives
    /// every offset in a multi-chunk frame its own phase.
    fn stream_byte(offset: usize) -> u8 {
        u8::try_from(offset % 251).expect("a value below 251 fits in a u8")
    }

    /// Assert `payload` is exactly the first `capacity` bytes of the synthetic stream,
    /// reporting the first divergence rather than dumping megabytes into the output.
    fn assert_is_the_delivered_stream(payload: &[u8], capacity: usize) {
        assert_eq!(
            payload.len(),
            capacity,
            "read_body must fill exactly the announced length"
        );
        let expected: Vec<u8> = (0..capacity).map(stream_byte).collect();
        let divergence = payload
            .iter()
            .zip(&expected)
            .position(|(got, want)| got != want);
        assert!(
            divergence.is_none(),
            "payload diverges from the bytes the peer delivered at offset {:?}: got {:?}, want {:?}",
            divergence,
            divergence.map(|i| payload[i]),
            divergence.map(|i| expected[i]),
        );
    }

    /// A reader that delivers a bounded number of chunks and then refuses, so
    /// [`read_body`] is driven exactly as a stalled or truncated peer would drive it.
    ///
    /// It does two things a bare `Ok(())` did not, both load-bearing. It **writes** a
    /// position-dependent pattern into `buf`, so the bytes a caller ends up with encode
    /// where in the stream they came from; and it **records** the length of every
    /// request. Without those, `payload`'s length and contents were decided entirely by
    /// `read_body`'s own sizing, and deleting one of its reads left the suite green —
    /// which is exactly the state
    /// [`read_body_fills_a_multi_chunk_frame_completely`] was in.
    struct StallingReader {
        chunks_before_failing: usize,
        /// How far into the synthetic stream the peer has already sent.
        delivered: usize,
        /// The length of every buffer `fill_exact` was handed, in order.
        requests: Vec<usize>,
    }

    impl StallingReader {
        fn new(chunks_before_failing: usize) -> Self {
            Self {
                chunks_before_failing,
                delivered: 0,
                requests: Vec::new(),
            }
        }
    }

    impl BodyReader for StallingReader {
        async fn fill_exact(&mut self, buf: &mut [u8]) -> Result<(), AppError> {
            // Recorded before the refusal so a request that should never have been
            // issued is still visible after the failure.
            self.requests.push(buf.len());
            if self.chunks_before_failing == 0 {
                return Err(wire_err("read payload: peer stopped sending"));
            }
            self.chunks_before_failing -= 1;
            for (i, slot) in buf.iter_mut().enumerate() {
                *slot = stream_byte(self.delivered + i);
            }
            self.delivered += buf.len();
            Ok(())
        }
    }

    /// A frame *at* the cap is accepted, and must still not be reserved up front.
    ///
    /// [`an_oversized_length_prefix_is_refused_before_allocating`] covers lengths
    /// **above** [`MAX_FRAME_SIZE`], which are rejected outright. It cannot catch this
    /// one: `MAX_FRAME_SIZE` itself *passes* the cap, so the eager
    /// `vec![0u8; capacity]` committed the full 256 MB from four bytes and no body.
    /// That is the lever a session driver multiplies by its connection count, and it
    /// bites hardest on 32-bit Android, where 16 such reservations exhaust the address
    /// space outright.
    ///
    /// Falsified by restoring the eager form: the observed capacity goes from
    /// 5,000,000 to 268,435,456.
    #[tokio::test]
    async fn a_frame_at_the_cap_is_not_reserved_before_it_arrives() {
        let capacity = usize::try_from(MAX_FRAME_SIZE).expect("cap fits usize");
        let mut reader = StallingReader::new(0);
        let mut payload = Vec::new();

        let err = read_body(&mut reader, capacity, &mut payload)
            .await
            .expect_err("a body that never arrives must fail");
        assert!(
            err.to_string().contains("read payload"),
            "expected a body-read failure, got: {err}"
        );

        assert!(
            payload.capacity() <= READ_CHUNK_BYTES * 2,
            "an unsent {MAX_FRAME_SIZE}-byte frame reserved {} bytes; a frame must not \
             be reserved before it arrives",
            payload.capacity()
        );
        assert_eq!(
            reader.requests,
            vec![READ_CHUNK_BYTES],
            "an unsent frame must be asked for one chunk at a time, not all at once"
        );
    }

    /// The growth policy must still deliver a complete large frame — a bound that only
    /// ever under-reads would satisfy the test above and break every real transfer.
    ///
    /// This is the test that could not fail before: the fake reader ignored its buffer
    /// and `payload.len()` was decided entirely by `read_body`'s own `resize`, so
    /// deleting the second read left it green. It now asserts over bytes the *reader*
    /// wrote, so `payload` can only reach `capacity` by being handed `capacity` bytes.
    ///
    /// Falsified four ways. Dropping the tail `fill_exact` while keeping the
    /// `extend_from_slice` fails on content — "payload diverges from the bytes the peer
    /// delivered at offset Some(5000000): got Some(0), want Some(80)". Dropping the
    /// whole `capacity > first` block fails on length — "left: 5000000, right:
    /// 10001234". Dropping the `reserve_exact` of the remainder fails on capacity —
    /// "left: 20000000, right: 10001234", the geometric 2× this exists to prevent.
    /// Halving the read step fails on the reader's budget, which is why that budget is
    /// exactly three.
    #[tokio::test]
    async fn read_body_fills_a_multi_chunk_frame_completely() {
        let capacity = READ_CHUNK_BYTES * 2 + 1234;
        // Exactly the number of reads a correct implementation needs: a fourth would
        // be refused, so over-reading fails here too.
        let mut reader = StallingReader::new(3);
        let mut payload = Vec::new();

        read_body(&mut reader, capacity, &mut payload)
            .await
            .expect("a delivered body must read");

        assert_is_the_delivered_stream(&payload, capacity);
        assert_eq!(
            reader.requests,
            vec![READ_CHUNK_BYTES, READ_CHUNK_BYTES, 1234],
            "the frame must be read as two full chunks and an exact tail"
        );
        assert_eq!(
            payload.capacity(),
            capacity,
            "a delivered frame must be sized in one exact step, not grown geometrically"
        );
    }

    /// A zero-length frame must not turn into a zero-length *read*. `fill_exact` with
    /// an empty buffer is a request for nothing, and against a reader that refuses —
    /// the shape a peer that has already stopped sending presents — issuing one turns
    /// an empty frame into a spurious error.
    #[tokio::test]
    async fn an_empty_frame_reads_without_issuing_a_request() {
        let mut reader = StallingReader::new(0);
        let mut payload = Vec::new();

        read_body(&mut reader, 0, &mut payload)
            .await
            .expect("a zero-length frame is not a read failure");

        assert!(
            payload.is_empty(),
            "a zero-length frame produced {} bytes",
            payload.len()
        );
        assert!(
            reader.requests.is_empty(),
            "a zero-length frame must issue no read at all; it asked for {:?}",
            reader.requests
        );
    }

    /// A frame smaller than one chunk is a single read of exactly its own length. The
    /// `min` is what stops a 1,234-byte frame from asking for — and reserving — 5 MB,
    /// which is the common case: every handshake message is far below one chunk.
    #[tokio::test]
    async fn a_sub_chunk_frame_is_read_in_one_exact_request() {
        let capacity = 1234;
        // Deliberately more chunks than needed: the reader's budget must not be what
        // makes this pass.
        let mut reader = StallingReader::new(4);
        let mut payload = Vec::new();

        read_body(&mut reader, capacity, &mut payload)
            .await
            .expect("a delivered body must read");

        assert_is_the_delivered_stream(&payload, capacity);
        assert_eq!(
            reader.requests,
            vec![capacity],
            "a sub-chunk frame must be one read of exactly its length"
        );
        assert_eq!(
            payload.capacity(),
            capacity,
            "a sub-chunk frame must not reserve a whole chunk"
        );
    }
}
