//! A live QUIC bi-stream between two loopback endpoints, for tests (#78, plan #3464).
//!
//! # Why this replaces `sync_net::test_connection_pair`, and why it is not in-memory
//!
//! The old helper handed back two `SyncConnection`s over an in-memory duplex. Nothing
//! equivalent exists here, and inventing one would defeat the point: `session`, `bulk`
//! and `driver` are written against a *byte stream with no message boundaries*, and
//! every property this port had to re-supply by hand — the length prefix, the exact
//! byte count, the fact that a zero-byte payload has no wire representation — is
//! invisible to a fake that preserves message boundaries. Two real loopback endpoints
//! cost about 70 ms of handshake (measured in the #3462 spike) and test the thing that
//! actually ships.
//!
//! # The one-byte handshake, and why the stream is still clean
//!
//! A locally-opened QUIC stream is invisible to the peer until something is written on
//! it: `accept_bi` resolves when the initiator *speaks*, not when it opens. So a helper
//! that returns both sides ready-to-use cannot exist without somebody writing first —
//! and the helper cannot know which side the test's protocol has speaking first
//! (`sync_files` starts with the initiator, `snapshot_transfer`'s offer path starts with
//! the responder).
//!
//! So the client writes exactly one byte and the server reads exactly one byte. Both
//! are consumed inside this function, so what the caller receives is a stream at offset
//! zero from the protocol's point of view. The alternative — returning the server half
//! as a `JoinHandle` for the caller to await after its first write — would push that
//! ordering into every test, which is precisely the sort of per-call-site subtlety that
//! makes a fixture wrong in ways nothing asserts.
//!
//! # The endpoints are owned here on purpose
//!
//! Dropping an `Endpoint` closes its connections. A helper that returned only the four
//! stream halves would work in tests that finish quickly and fail, mysteriously and
//! intermittently, in ones that do not. [`QuicPair`] holds both endpoints for its own
//! lifetime, so the connection outlives the fixture exactly as long as the test holds
//! the pair.

use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};

use iroh::endpoint::{Connection, RecvStream, SendStream};
use iroh::{Endpoint, SecretKey};
use iroh_dns::dns::DnsResolver;

use crate::transport::endpoint::{RecordingResolver, lan_only};
use crate::transport::service::SYNC_ALPN;

/// The `/8` the loopback bind sits in. `lan_only`'s own tests use the same pair, and
/// [`MIN_IPV4_PREFIX_LEN`](crate::transport::endpoint::MIN_IPV4_PREFIX_LEN) is why 8 is
/// the broadest value it accepts.
const LOOPBACK_PREFIX: u8 = 8;

/// One side of a test connection: the live connection and both stream halves.
///
/// The three are separate fields rather than a bundle so a caller can hand
/// `&mut side.send` and `&mut side.recv` to a function that takes both — disjoint field
/// borrows, which a getter pair would not allow.
#[derive(Debug)]
pub struct TestSide {
    /// The live connection, for `finish_session` and for asserting on close.
    pub conn: Connection,
    /// This side's write half.
    pub send: SendStream,
    /// This side's read half.
    pub recv: RecvStream,
}

/// Two ends of one real QUIC bi-stream, plus the endpoints keeping them alive.
#[derive(Debug)]
pub struct QuicPair {
    /// The side that dialled — the sync *initiator* in every protocol here.
    pub client: TestSide,
    /// The side that accepted — the sync *responder*.
    pub server: TestSide,
    /// Held so the connection is not closed out from under the test. Never read.
    _client_endpoint: Endpoint,
    /// Held for the same reason.
    _server_endpoint: Endpoint,
}

async fn loopback_endpoint(alpns: bool) -> Endpoint {
    let builder = lan_only(
        SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)),
        LOOPBACK_PREFIX,
        // The recording resolver answers nothing, which is what the LAN-only posture
        // guarantees anyway. Using it here means a test endpoint that started phoning
        // home would hang rather than succeed quietly.
        DnsResolver::custom(RecordingResolver::new()),
    )
    .expect("a loopback /8 is a valid LAN bind")
    // A fresh identity per endpoint. Tests that care about a *stable* identity across
    // restarts drive `transport::identity` directly; here a random key is right, since
    // two endpoints in one test must not collide.
    .secret_key(SecretKey::generate());
    let builder = if alpns {
        builder.alpns(vec![SYNC_ALPN.to_vec()])
    } else {
        builder
    };
    builder.bind().await.expect("a loopback endpoint binds")
}

/// Build a connected pair with both stream halves ready to carry protocol messages.
///
/// # Panics
/// If either endpoint fails to bind, the dial fails, or the one-byte handshake does not
/// complete. All of these are fixture failures, not assertions about the code under
/// test, which is why they panic rather than returning a `Result` the caller would `?`.
pub async fn quic_pair() -> QuicPair {
    let server_endpoint = loopback_endpoint(true).await;
    let client_endpoint = loopback_endpoint(false).await;
    let server_addr = server_endpoint.addr();

    let accepting = tokio::spawn({
        let endpoint = server_endpoint.clone();
        async move {
            let conn = endpoint
                .accept()
                .await
                .expect("an inbound connection")
                .await
                .expect("the QUIC handshake completes");
            let (send, mut recv) = conn.accept_bi().await.expect("the peer opens a bi-stream");
            // Consume the one-byte opener. Reading it here is what leaves the stream at
            // protocol offset zero for the caller.
            let mut opener = [0u8; 1];
            recv.read_exact(&mut opener)
                .await
                .expect("the fixture's opening byte arrives");
            TestSide { conn, send, recv }
        }
    });

    let client_conn = client_endpoint
        .connect(server_addr, SYNC_ALPN)
        .await
        .expect("the client dials the server");
    let (mut client_send, client_recv) = client_conn
        .open_bi()
        .await
        .expect("the client opens a bi-stream");
    // See the module docs: without this the server's `accept_bi` never resolves.
    client_send
        .write_all(&[0u8])
        .await
        .expect("the fixture's opening byte is sent");

    let server = accepting.await.expect("the accepting task does not panic");

    QuicPair {
        client: TestSide {
            conn: client_conn,
            send: client_send,
            recv: client_recv,
        },
        server,
        _client_endpoint: client_endpoint,
        _server_endpoint: server_endpoint,
    }
}

/// A bound [`SyncService`] plus a client endpoint to dial it with.
///
/// [`quic_pair`] is the fixture for testing a *phase* (file transfer, snapshot
/// catch-up) in isolation, where both sides are raw streams. This is the fixture for
/// testing the *responder*, which takes an
/// [`InboundSession`](crate::transport::service::InboundSession) and therefore cannot be
/// handed a stream pair at all: the type has no public constructor, which is the
/// property that makes "a handler cannot name an unauthenticated peer" hold.
///
/// So a responder test runs the real admission path — bind, accept, establish — and the
/// ordering falls out of the protocol rather than being arranged: `establish` waits for
/// the peer's first frame, so the client's opening `HeadExchange` is what completes it.
/// There is no fixture handshake here for that reason, and none is needed.
#[derive(Debug)]
pub struct ServiceHarness {
    /// The service under test. `Arc` so an accept loop can be spawned against it.
    pub service: std::sync::Arc<crate::transport::service::SyncService>,
    /// A separate endpoint to dial from. Never given the sync ALPN: it only dials.
    pub client_endpoint: Endpoint,
}

impl ServiceHarness {
    /// Bind a loopback service and a client endpoint to dial it with.
    ///
    /// # Panics
    /// If either bind fails — a fixture failure, not an assertion.
    pub async fn new() -> Self {
        let service = crate::transport::service::SyncService::bind(
            SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)),
            LOOPBACK_PREFIX,
            DnsResolver::custom(RecordingResolver::new()),
            SecretKey::generate(),
        )
        .await
        .expect("a loopback /8 sync service binds");
        Self {
            service: std::sync::Arc::new(service),
            client_endpoint: loopback_endpoint(false).await,
        }
    }

    /// Dial the service and open a bi-stream, writing nothing.
    ///
    /// The caller's first `send_sync_message` is what makes the service's `establish`
    /// resolve — deliberately, because that is what production does and because a
    /// fixture byte here would be dispatched as a protocol frame.
    ///
    /// # Panics
    /// If the dial or the stream open fails.
    pub async fn dial(&self) -> TestSide {
        let conn = self
            .client_endpoint
            .connect(self.service.addr(), SYNC_ALPN)
            .await
            .expect("the client dials the service");
        let (send, recv) = conn.open_bi().await.expect("the client opens a bi-stream");
        TestSide { conn, send, recv }
    }
}

#[cfg(test)]
mod tests {
    //! The fixture is itself a thing that can be silently wrong, and in one specific
    //! way: if the one-byte opener were not consumed on both sides, every test built on
    //! it would read a stray `0x00` as the first byte of its first length prefix. That
    //! is a misalignment, so it would fail loudly — but only in the *callers*, and the
    //! diagnosis would land on the protocol rather than on the fixture. Asserting it
    //! here puts the failure where the cause is.

    use super::*;
    use crate::sync_protocol::SyncMessage;
    use crate::transport::session::{recv_sync_message, send_sync_message};

    /// A message written by one side is the *first* thing the other side reads.
    ///
    /// Forced red by removing the server-side `read_exact` of the opening byte: the
    /// receive then fails with a deserialize error, because the length prefix it read
    /// began one byte early.
    #[tokio::test(flavor = "multi_thread")]
    async fn the_pair_leaves_the_stream_at_protocol_offset_zero() {
        let mut pair = quic_pair().await;

        send_sync_message(
            &mut pair.client.send,
            &SyncMessage::Error {
                message: "first protocol byte".to_owned(),
            },
        )
        .await
        .expect("the client sends");

        let got = recv_sync_message(&mut pair.server.recv)
            .await
            .expect("the server receives the client's first message and nothing before it");
        assert_eq!(
            got,
            SyncMessage::Error {
                message: "first protocol byte".to_owned()
            },
            "the fixture's opening byte must be consumed on both sides, or every caller \
             reads it as the first byte of its first length prefix"
        );
    }

    /// The other direction, which the opening handshake does not exercise.
    #[tokio::test(flavor = "multi_thread")]
    async fn the_pair_carries_messages_from_the_server_too() {
        let mut pair = quic_pair().await;

        send_sync_message(&mut pair.server.send, &SyncMessage::SnapshotAccept)
            .await
            .expect("the server sends");
        let got = recv_sync_message(&mut pair.client.recv)
            .await
            .expect("the client receives");
        assert_eq!(got, SyncMessage::SnapshotAccept);
    }

    /// The two endpoints must have distinct identities, or a fixture built on them
    /// cannot tell "the peer" from "us" — which is exactly what several callers assert.
    #[tokio::test(flavor = "multi_thread")]
    async fn the_two_sides_have_distinct_identities() {
        let pair = quic_pair().await;
        assert_ne!(
            pair.client.conn.remote_id(),
            pair.server.conn.remote_id(),
            "each side's view of its peer must be the other endpoint's key"
        );
    }
}
