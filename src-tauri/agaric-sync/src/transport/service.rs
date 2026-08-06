//! The endpoint service: owns the LAN-only iroh endpoint, admits inbound peers, and
//! hands out accepted sessions (#78, plan #3464 slice 2).
//!
//! # What this owns, and what it deliberately does not
//!
//! [`endpoint::lan_only`](crate::transport::endpoint::lan_only) builds a hardened
//! endpoint; [`driver::run_session`](crate::transport::driver::run_session) drives one
//! session to a terminal state. Neither owns the thing between them — the loop that
//! turns "a peer dialled us" into "here is a bi-stream and the identity behind it".
//! That is this module, and it stops there. It does **not** drive sessions, look up
//! `DeviceId`s, or touch the orchestrator: it yields an [`InboundSession`] and the
//! caller decides what to do with it.
//!
//! The split matters for the permit accounting below. A service that also drove
//! sessions would have to decide when a session is over; a service that only hands
//! them out lets `Drop` decide, which is the one mechanism that cannot be forgotten on
//! an error path.
//!
//! # Admission control is a refusal, not a queue
//!
//! The cap is [`MAX_CONCURRENT_RESPONDER_SESSIONS`] (16), carried unchanged from the
//! WebSocket accept loop this replaces (`sync_net::websocket`, #1581). Its sizing
//! rationale is not about connections at all — it is about what those connections
//! contend for: "16 leaves generous headroom over any realistic paired-device count
//! **and over the 6-connection DB pool** (2 writers + 4 readers) those sessions
//! ultimately draw on".
//!
//! That is why the over-capacity connection is **refused** rather than queued, and why
//! [`Semaphore::try_acquire_owned`] rather than `acquire_owned().await` is the
//! load-bearing choice here. Queueing would look kinder and be worse: a cap sized
//! against a downstream pool exists to keep contention bounded, and a waiter parked on
//! that cap is a session that has already been admitted in every sense except the one
//! the number was chosen for. The old loop said the same thing in TCP terms — at
//! capacity "we drop `tcp_stream` (closing the connection) and move on, so excess peers
//! cannot force a handshake or a long-lived session task".
//!
//! `Incoming::refuse` answers with a CONNECTION_CLOSE before the handshake runs, so
//! the peer learns immediately that it was turned away. That is what makes the refusal
//! testable at all: a queueing regression shows up as a dial that never returns,
//! against a refusal that returns in milliseconds.
//!
//! The call is written out rather than left to `drop(incoming)`, which is **the same
//! behaviour** — `noq`'s `Drop for Incoming` performs "an implicit reject, similar to
//! Connection's implicit close". So no test can tell the two apart, and the explicit
//! call earns its place by saying what happens rather than by changing it.
//!
//! **The permit is acquired before the handshake**, exactly where the old loop put it
//! ("a permit is acquired *before* the TLS handshake … without spending handshake
//! CPU/FDs"), and it lives in the returned [`InboundSession`]. So the slot is released
//! when the caller drops the session — on the success path, on the error path, and on a
//! panic unwinding through the caller, without any of them having to say so.
//!
//! # Identity comes from the handshake, never from the wire
//!
//! [`InboundSession::remote`] is [`Connection::remote_id`] — the [`EndpointId`] in the
//! peer's TLS certificate, established by the QUIC handshake before a single
//! application byte moves. This is plan #3464's D3, and it is the reason
//! [`driver`](crate::transport::driver) needs only one session loop where the old stack
//! needed two: the responder no longer has to read `HeadExchange` to find out who it is
//! talking to.
//!
//! Mapping that [`EndpointId`] onto an Agaric `DeviceId` is a later slice and
//! deliberately absent here. An identity this module invented would be an identity the
//! transport did not authenticate.
//!
//! # Connection setup is bounded; concurrency of setup is not
//!
//! [`SyncService::accept`] awaits the handshake and `Connection::accept_bi` *inline*,
//! so a peer that stalls between the two would park the accept loop and make the other
//! 15 slots unreachable — defeating the cap above with a single connection.
//! [`CONNECTION_SETUP_TIMEOUT`] bounds that window and releases the slot on elapse; see
//! that constant for why the number is restated here rather than imported.
//!
//! What remains is narrower, and stays out of scope deliberately: **accepts are
//! serialized**. This service admits one connection at a time and spawns nothing, so
//! two peers arriving together are set up one after the other rather than
//! concurrently — each waiting at most [`CONNECTION_SETUP_TIMEOUT`], not forever. The
//! old stack spawned a task per connection instead. Whether to do that here, and what
//! supervises the spawned task, is a call-site shape rather than a property of
//! admission control, so it belongs to the cutover and not to this slice.

use std::{net::SocketAddr, sync::Arc, time::Duration};

use iroh::{
    Endpoint, EndpointAddr, EndpointId,
    endpoint::{BindError, Connection, Incoming, RecvStream, SendStream},
};
use iroh_dns::dns::DnsResolver;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use agaric_core::error::AppError;

use crate::sync_constants::MAX_CONCURRENT_RESPONDER_SESSIONS;
use crate::transport::endpoint::{LanBindError, lan_only};

/// The ALPN every Agaric sync connection negotiates.
///
/// Both ends must agree on this byte string or the QUIC handshake fails before any
/// application data moves, which makes it the first line of defence against a
/// connection from something that is not Agaric — and, when the protocol changes
/// incompatibly, the place to say so.
pub const SYNC_ALPN: &[u8] = b"agaric/sync/0";

/// Wall-clock budget for turning an accepted connection into a usable session: the QUIC
/// handshake, plus the peer opening its bi-stream.
///
/// Without it the cap this module exists to enforce is defeated by one peer. The permit
/// is taken before the handshake, so a peer that completes the handshake and then never
/// opens a stream holds a slot *and*, because [`SyncService::accept`] awaits the setup
/// inline, parks the accept loop — the remaining 15 slots are unreachable no matter how
/// well-behaved the peers waiting behind it are. The old stack described the same
/// failure in TLS terms: "16 such stalls wedge every responder slot".
///
/// # Why the number is restated here rather than imported
///
/// The value is `TLS_HANDSHAKE_TIMEOUT`'s, and that constant's sizing rationale
/// describes this situation exactly — "a handshake between two LAN devices completes in
/// well under a second; 10 s is generous headroom for a slow/loaded device or a brief
/// network hiccup while still failing a genuinely stalled peer fast enough to keep the
/// 16-slot pool flowing".
///
/// But its documented *scope* is `TlsAcceptor::accept` plus the WebSocket upgrade,
/// machinery this port deletes. After the cutover it would be an orphan whose only
/// consumer is this bound, and tuning it for the TLS story it is named after would
/// silently retune QUIC connection setup. Same reasoning as `driver`'s `RECV_TIMEOUT`
/// and `CLOSE_WAIT`: the number moves with the responsibility, not with the name.
const CONNECTION_SETUP_TIMEOUT: Duration = Duration::from_secs(10);

/// A bound LAN-only endpoint plus the admission control in front of it.
///
/// Clone-free by design: the endpoint is shared by wrapping the service in an `Arc`,
/// not by handing out copies whose limiters could diverge.
#[derive(Debug)]
pub struct SyncService {
    endpoint: Endpoint,
    /// Sized [`MAX_CONCURRENT_RESPONDER_SESSIONS`]. `Arc` because the permits outlive
    /// [`SyncService::accept`] — they travel into [`InboundSession`] and are released
    /// by its `Drop`.
    limiter: Arc<Semaphore>,
    /// Always [`CONNECTION_SETUP_TIMEOUT`] in production; a field rather than a direct
    /// use of the constant so tests can drive it.
    ///
    /// `driver`'s [`SessionLimits`](crate::transport::driver::SessionLimits) exists for
    /// the same reason and says it best: "A timeout that only fires after 180 s is a
    /// timeout no test asserts, and an unasserted bound is how the receive clock would
    /// go missing in the first place." A 10 s bound is no more assertable than a 180 s
    /// one, so the production value is pinned by its own test and the *mechanism* is
    /// driven at a short one.
    setup_timeout: Duration,
}

/// One admitted inbound session: an authenticated peer, its bi-stream, and the
/// concurrency slot it occupies.
///
/// The permit is a private field with no accessor, so the only way to release the slot
/// is to drop the session. That is the point: a caller cannot return early, `?` out of
/// a failed handshake, or panic without also freeing the slot.
#[derive(Debug)]
pub struct InboundSession {
    /// The live connection. Needed for shutdown —
    /// [`finish_session`](crate::transport::driver::finish_session) takes it.
    pub conn: Connection,
    /// This side's half of the bi-stream the peer opened.
    pub send: SendStream,
    /// The peer's half of the bi-stream.
    pub recv: RecvStream,
    /// The peer's identity, from the QUIC handshake — see the module docs. This is
    /// authenticated by the transport, not claimed by the peer in a message.
    pub remote: EndpointId,
    /// Held for the session's whole life. Never read; dropping it is the entire
    /// contract.
    _permit: OwnedSemaphorePermit,
}

/// A [`SyncService`] could not be brought up.
///
/// Two variants rather than one string because they fail at different layers and a
/// caller may reasonably treat them differently: [`Self::Configuration`] means the
/// LAN-only posture was rejected before a socket was ever opened — a programming or
/// deployment error — while [`Self::Socket`] is the ordinary "this address is already
/// in use" class. Hand-written for the same reason [`LanBindError`] is: `agaric-sync`
/// does not depend on `thiserror`.
#[derive(Debug)]
pub enum ServiceBindError {
    /// [`lan_only`] rejected the bind address or prefix. No socket was opened.
    Configuration(LanBindError),
    /// iroh could not bind the socket.
    Socket(BindError),
}

impl std::fmt::Display for ServiceBindError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Deliberately does NOT interpolate the inner error: `source()` returns it, so a
        // chain-walking reporter would print it twice. Same rule as `LanBindError`.
        match self {
            Self::Configuration(_) => {
                write!(f, "the LAN-only sync endpoint configuration was rejected")
            }
            Self::Socket(_) => write!(f, "the sync endpoint could not bind its socket"),
        }
    }
}

impl std::error::Error for ServiceBindError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Configuration(e) => Some(e),
            Self::Socket(e) => Some(e),
        }
    }
}

impl From<LanBindError> for ServiceBindError {
    fn from(e: LanBindError) -> Self {
        Self::Configuration(e)
    }
}

impl From<BindError> for ServiceBindError {
    fn from(e: BindError) -> Self {
        Self::Socket(e)
    }
}

impl SyncService {
    /// Bind a LAN-only sync endpoint on `bind`, confined to `prefix_len`.
    ///
    /// The endpoint is built by [`lan_only`], not configured here — the posture that
    /// module proves is the posture this service gets, and re-deriving any part of it
    /// would mean re-deriving the guard too.
    ///
    /// # Errors
    /// [`ServiceBindError::Configuration`] if the address or prefix cannot support the
    /// LAN-only posture; [`ServiceBindError::Socket`] if iroh cannot bind.
    pub async fn bind(
        bind: SocketAddr,
        prefix_len: u8,
        resolver: DnsResolver,
    ) -> Result<Self, ServiceBindError> {
        let endpoint = lan_only(bind, prefix_len, resolver)?
            .alpns(vec![SYNC_ALPN.to_vec()])
            .bind()
            .await?;

        Ok(Self {
            endpoint,
            limiter: Arc::new(Semaphore::new(MAX_CONCURRENT_RESPONDER_SESSIONS)),
            setup_timeout: CONNECTION_SETUP_TIMEOUT,
        })
    }

    /// Drive the connection-setup bound at a value a test can wait for.
    ///
    /// Test-only for the same reason `available_permits` is: production has exactly one
    /// correct value for this and it is [`CONNECTION_SETUP_TIMEOUT`], pinned by
    /// [`tests::the_connection_setup_bound_is_the_value_carried_from_the_old_transport`].
    #[cfg(any(test, feature = "test-util"))]
    #[doc(hidden)]
    pub fn set_connection_setup_timeout(&mut self, budget: Duration) {
        self.setup_timeout = budget;
    }

    /// This endpoint's address, which a peer needs in order to dial us.
    #[must_use]
    pub fn addr(&self) -> EndpointAddr {
        self.endpoint.addr()
    }

    /// Accept the next inbound session, refusing anything past the cap.
    ///
    /// Returns `None` — and only `None` — when the endpoint has been closed. Every
    /// other non-session outcome (an over-capacity peer, a failed handshake, a peer
    /// that never opened a stream) is handled internally and the loop continues, so a
    /// caller's accept loop is not torn down by one bad connection. iroh's own
    /// `Incoming::accept` docs make the case for the handshake half: a QUIC endpoint
    /// "listens on a normal UDP socket" and errors there are "likely not caused by the
    /// application or remote".
    ///
    /// See the module docs for why the permit is taken *before* the handshake and why
    /// an over-capacity peer is refused rather than made to wait.
    ///
    /// # Errors
    /// Currently never returns `Err`; the fallible signature is the caller-facing
    /// contract, since the recoverable-vs-fatal line moves once this has a supervisor.
    pub async fn accept(&self) -> Result<Option<InboundSession>, AppError> {
        loop {
            let Some(incoming) = self.endpoint.accept().await else {
                // The endpoint was closed. This is the only `None`.
                return Ok(None);
            };

            // Before the handshake, exactly as the old accept loop did it: an
            // over-capacity peer must not cost us handshake CPU or a file descriptor.
            let Ok(permit) = Arc::clone(&self.limiter).try_acquire_owned() else {
                tracing::warn!(
                    cap = MAX_CONCURRENT_RESPONDER_SESSIONS,
                    "transport.service.at_capacity: refusing a connection before the QUIC \
                     handshake"
                );
                // Explicit, though `drop(incoming)` is the same thing: `noq`'s
                // `Drop for Incoming` performs an implicit reject.
                incoming.refuse();
                continue;
            };

            // Bounded: see `CONNECTION_SETUP_TIMEOUT`. A peer that completes the
            // handshake and then never opens a stream must not park the accept loop,
            // because that would make the other 15 slots unreachable.
            let setup = tokio::time::timeout(self.setup_timeout, Self::set_up(incoming));

            // Every non-session arm below drops `permit` on the way out, freeing the
            // slot — which is the half that makes the bound worth having.
            let (conn, send, recv, remote) = match setup.await {
                Ok(Some(parts)) => parts,
                // `set_up` has already logged the specific failure.
                Ok(None) => continue,
                Err(_elapsed) => {
                    // The half-built `Connection` is dropped inside the cancelled
                    // future, and `noq`'s implicit close means the peer is told rather
                    // than left hanging.
                    tracing::warn!(
                        timeout_ms = self.setup_timeout.as_millis(),
                        "transport.service.setup_timeout: peer did not complete \
                         connection setup; dropping it and releasing its slot"
                    );
                    continue;
                }
            };

            return Ok(Some(InboundSession {
                conn,
                send,
                recv,
                remote,
                _permit: permit,
            }));
        }
    }

    /// Complete the QUIC handshake and take the bi-stream the peer opens.
    ///
    /// Split out as its own future so [`CONNECTION_SETUP_TIMEOUT`] can wrap the whole
    /// setup rather than either half: a peer can stall in the handshake *or* after it,
    /// and one budget over both is what the old `TLS_HANDSHAKE_TIMEOUT` covered
    /// (handshake plus upgrade). Returns `None` when the connection failed for a reason
    /// already logged here — the caller only needs to know it did not become a session.
    async fn set_up(
        incoming: Incoming,
    ) -> Option<(Connection, SendStream, RecvStream, EndpointId)> {
        let conn = match incoming.await {
            Ok(conn) => conn,
            Err(e) => {
                tracing::debug!(error = %e, "inbound QUIC handshake failed");
                return None;
            }
        };

        // From the peer's TLS certificate, established by the handshake above.
        let remote = conn.remote_id();

        match conn.accept_bi().await {
            Ok((send, recv)) => Some((conn, send, recv, remote)),
            Err(e) => {
                tracing::debug!(
                    %remote,
                    error = %e,
                    "peer connected but opened no sync bi-stream"
                );
                conn.close(0u32.into(), b"no sync stream");
                None
            }
        }
    }

    /// How many session slots are currently free.
    ///
    /// Test-only, and gated rather than public for the same reason
    /// `SyncServer::responder_session_limiter_for_test` is: the number is an
    /// implementation detail of admission control, and a production caller that branched
    /// on it would be racing the very thing the semaphore exists to serialize. Tests
    /// read it *synchronously* — after `accept` has returned, or after a session has
    /// been dropped — which is exactly when it is not a race.
    #[cfg(any(test, feature = "test-util"))]
    #[doc(hidden)]
    #[must_use]
    pub fn available_permits(&self) -> usize {
        self.limiter.available_permits()
    }

    /// Close the endpoint. Any [`SyncService::accept`] parked on it returns `None`.
    pub async fn close(&self) {
        self.endpoint.close().await;
    }
}

#[cfg(test)]
mod tests {
    //! # What these prove, and how each was forced red
    //!
    //! Admission control is the kind of thing that passes its tests while doing
    //! nothing: a cap that is never applied looks exactly like a cap that is never
    //! reached, and a permit that is never taken is released just as promptly as one
    //! that is. So the two permit-count assertions here are written to be *impossible*
    //! to satisfy vacuously:
    //!
    //! * [`sessions_up_to_the_cap_are_admitted_and_exhaust_the_permits`] asserts the
    //!   count is **0**, which a never-acquired permit cannot produce, and it asserts it
    //!   with no polling and no sleeping — `accept` has already returned, so the value
    //!   is settled and the enclosing timeout cannot be what makes the assertion true.
    //! * [`dropping_a_session_returns_its_permit`] asserts 0 **before** the drop and the
    //!   full cap **after** it, in the same test. Either assertion alone is satisfiable
    //!   by a permit that was never taken; together they are not.

    use std::{
        net::{Ipv4Addr, SocketAddrV4},
        time::Duration,
    };

    use super::*;
    use crate::transport::endpoint::RecordingResolver;

    /// Hang detector, not a performance bound — a LAN handshake was measured at 0.07 s
    /// in the #3462 spike.
    const TEST_TIMEOUT: Duration = Duration::from_secs(30);

    /// How long the endpoint is given to phone home before the LAN-only guard concludes
    /// it did not. Carried from `endpoint`'s own guard, where the measurement behind it
    /// lives: a fully leaking endpoint makes ~220 queries in the first 5 s, and all 5
    /// distinct hostnames appear inside the first 5 s.
    const SETTLE: Duration = Duration::from_secs(3);

    /// How long the over-capacity peer gets to observe its refusal.
    ///
    /// Deliberately far below [`TEST_TIMEOUT`]: the two outcomes this separates are a
    /// CONNECTION_CLOSE on loopback (milliseconds) and a dial parked behind a permit
    /// that will not be released until a session ends (unbounded). Any value in between
    /// works, and a tight one means a queueing regression fails as *this* assertion
    /// rather than as the hang detector.
    const REFUSAL_DEADLINE: Duration = Duration::from_secs(5);

    /// The connection-setup bound these tests drive, in place of the production 10 s.
    ///
    /// Short enough that the stalled-peer test costs milliseconds, and far above a
    /// loopback handshake (measured at 0.07 s in the #3462 spike) so the *well-behaved*
    /// peers in every other test are never caught by it.
    const TEST_SETUP_TIMEOUT: Duration = Duration::from_millis(300);

    /// How long a well-behaved peer gets to be admitted past a stalled one.
    ///
    /// Deliberately far below [`TEST_TIMEOUT`] and far above [`TEST_SETUP_TIMEOUT`]:
    /// with the bound in place the admission costs one [`TEST_SETUP_TIMEOUT`], and
    /// without it the admission never happens at all. A tight value means a missing
    /// bound fails as *this* assertion rather than as the hang detector.
    const ADMISSION_DEADLINE: Duration = Duration::from_secs(5);

    fn lan_bind() -> SocketAddr {
        SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))
    }

    const LAN_PREFIX: u8 = 8;

    async fn service_with(recorder: &RecordingResolver) -> SyncService {
        SyncService::bind(
            lan_bind(),
            LAN_PREFIX,
            DnsResolver::custom(recorder.clone()),
        )
        .await
        .expect("a loopback /8 sync service binds")
    }

    async fn service() -> SyncService {
        service_with(&RecordingResolver::new()).await
    }

    /// A peer endpoint built the same way, so nothing in these tests reaches the
    /// network even when a guard fails.
    async fn peer_endpoint() -> Endpoint {
        lan_only(
            lan_bind(),
            LAN_PREFIX,
            DnsResolver::custom(RecordingResolver::new()),
        )
        .expect("loopback /8 is a valid LAN bind")
        .bind()
        .await
        .expect("a peer endpoint binds")
    }

    /// The peer's side of a connection. Held for the whole test: dropping it closes the
    /// connection, which would end the session under the service and make a permit
    /// assertion measure the wrong thing.
    type PeerSide = (Connection, SendStream, RecvStream);

    /// Dial the service and open a bi-stream, writing a byte so the service's
    /// `accept_bi` actually resolves — a locally-opened QUIC stream is invisible to the
    /// peer until something is sent on it.
    ///
    /// Spawned rather than awaited inline because `connect` does not complete until the
    /// service drives the handshake, and the service only does that inside `accept`.
    fn dial(peer: &Endpoint, addr: EndpointAddr) -> tokio::task::JoinHandle<PeerSide> {
        let peer = peer.clone();
        tokio::spawn(async move {
            let conn = peer
                .connect(addr, SYNC_ALPN)
                .await
                .expect("the peer connects to the sync service");
            let (mut send, recv) = conn.open_bi().await.expect("the peer opens a bi-stream");
            send.write_all(b"hello").await.expect("the peer writes");
            (conn, send, recv)
        })
    }

    /// Fill the service to exactly [`MAX_CONCURRENT_RESPONDER_SESSIONS`] live sessions.
    ///
    /// One at a time, each `accept` awaited before the next dial, so the returned state
    /// is settled rather than merely likely: when this returns, every permit has been
    /// taken and no accept is in flight.
    async fn fill_to_capacity(
        service: &SyncService,
        peer: &Endpoint,
    ) -> (Vec<InboundSession>, Vec<PeerSide>) {
        let mut sessions = Vec::with_capacity(MAX_CONCURRENT_RESPONDER_SESSIONS);
        let mut peers = Vec::with_capacity(MAX_CONCURRENT_RESPONDER_SESSIONS);

        for i in 0..MAX_CONCURRENT_RESPONDER_SESSIONS {
            let dialing = dial(peer, service.addr());
            let session = tokio::time::timeout(TEST_TIMEOUT, service.accept())
                .await
                .unwrap_or_else(|_| {
                    panic!(
                        "session {i} is inside the cap of {MAX_CONCURRENT_RESPONDER_SESSIONS} \
                         and must be admitted, not made to wait"
                    )
                })
                .expect("accept does not fail")
                .expect("the endpoint is open, so accept must yield a session");
            sessions.push(session);
            peers.push(
                tokio::time::timeout(TEST_TIMEOUT, dialing)
                    .await
                    .expect("the peer's dial must complete once the session is admitted")
                    .expect("the dialing task does not panic"),
            );
        }

        (sessions, peers)
    }

    // -- 1: the identity is the handshake's, not the wire's ---------------------

    /// [`InboundSession::remote`] must be the dialling endpoint's own id.
    ///
    /// This is plan #3464's D3 in one assertion. The failure it catches is not
    /// "no id" — it is a *plausible* id: our own, the connection's local id, or
    /// something later read out of a `HeadExchange`. Comparing against the peer's
    /// `Endpoint::id()`, obtained before the dial, is what makes those distinguishable.
    #[tokio::test(flavor = "multi_thread")]
    async fn an_accepted_session_carries_the_peers_handshake_authenticated_id() {
        let service = service().await;
        let peer = peer_endpoint().await;
        let expected = peer.id();
        assert_ne!(
            expected,
            service.addr().id,
            "the two endpoints must have distinct ids, or this test cannot tell the \
             peer's identity from our own"
        );

        let dialing = dial(&peer, service.addr());
        let session = tokio::time::timeout(TEST_TIMEOUT, service.accept())
            .await
            .expect("the accept must not hang")
            .expect("accept does not fail")
            .expect("the endpoint is open, so accept must yield a session");

        assert_eq!(
            session.remote, expected,
            "the session's remote must be the QUIC-authenticated id of the endpoint \
             that dialled us, not our own and not anything read off the wire"
        );

        let held = tokio::time::timeout(TEST_TIMEOUT, dialing)
            .await
            .expect("the dial completes")
            .expect("the dialing task does not panic");
        drop(held);
        drop(session);
        service.close().await;
        peer.close().await;
    }

    // -- 2: the cap admits everything up to it ----------------------------------

    /// Every session inside the cap is admitted, and together they exhaust the permits.
    ///
    /// The `0` is the load-bearing number. A version that never acquires a permit
    /// leaves the count at the full cap; a version whose cap is not
    /// [`MAX_CONCURRENT_RESPONDER_SESSIONS`] leaves it non-zero in the other direction.
    /// Nothing here polls or sleeps: `fill_to_capacity` awaits each `accept` before
    /// dialling the next, so the count is settled by the time it is read and the
    /// enclosing timeout is not what makes the assertion true.
    #[tokio::test(flavor = "multi_thread")]
    async fn sessions_up_to_the_cap_are_admitted_and_exhaust_the_permits() {
        let service = service().await;
        let peer = peer_endpoint().await;

        assert_eq!(
            service.available_permits(),
            MAX_CONCURRENT_RESPONDER_SESSIONS,
            "a fresh service must start with the whole cap free"
        );

        let (sessions, peers) = fill_to_capacity(&service, &peer).await;

        assert_eq!(
            sessions.len(),
            MAX_CONCURRENT_RESPONDER_SESSIONS,
            "every session inside the cap must be admitted"
        );
        assert_eq!(
            service.available_permits(),
            0,
            "holding {MAX_CONCURRENT_RESPONDER_SESSIONS} live sessions must leave no \
             free slot; a non-zero count here means the permits were never taken or the \
             cap is not the one the DB pool was sized against"
        );

        drop(sessions);
        drop(peers);
        service.close().await;
        peer.close().await;
    }

    // -- 3: past the cap, refused rather than queued ----------------------------

    /// The connection past the cap must be turned away, and told so.
    ///
    /// Two regressions land on this one assertion, which is why it is written as
    /// "returns, and returns an error" rather than as a string match:
    ///
    /// * `acquire_owned().await` instead of `try_acquire_owned()` — the dial parks
    ///   until a session ends, and the [`REFUSAL_DEADLINE`] fires instead of the hang
    ///   detector. Verified red.
    /// * admitting it anyway — the dial succeeds and `expect_err` fires.
    ///
    /// What it deliberately does **not** claim to catch is `drop(incoming)` in place of
    /// `Incoming::refuse`: `noq`'s `Drop for Incoming` performs an implicit reject, so
    /// the peer sees the same CONNECTION_CLOSE either way. Forcing that swap leaves this
    /// test green, and it is recorded here rather than left to look like coverage.
    #[tokio::test(flavor = "multi_thread")]
    async fn the_connection_past_the_cap_is_refused_rather_than_queued() {
        let service = Arc::new(service().await);
        let peer = peer_endpoint().await;

        let (sessions, peers) = fill_to_capacity(&service, &peer).await;
        assert_eq!(
            service.available_permits(),
            0,
            "the cap must actually be full, or the refusal below proves nothing"
        );

        // Park the service in `accept` so the over-capacity connection is genuinely
        // processed rather than merely never looked at.
        let pump = tokio::spawn({
            let service = Arc::clone(&service);
            async move { service.accept().await }
        });

        let addr = service.addr();
        let outcome = tokio::time::timeout(REFUSAL_DEADLINE, peer.connect(addr, SYNC_ALPN))
            .await
            .expect(
                "an over-capacity connection must be REFUSED, not queued: the dial was \
                 still waiting when the refusal deadline expired, which is what a \
                 blocking `acquire_owned` (or a silently dropped `Incoming`) looks like \
                 from the peer",
            );

        let err = outcome.expect_err("a connection past the cap must fail rather than be admitted");
        tracing::debug!(%err, "over-capacity dial was refused");

        assert_eq!(
            service.available_permits(),
            0,
            "a refusal must not have consumed or leaked a slot"
        );

        pump.abort();
        drop(sessions);
        drop(peers);
        service.close().await;
        peer.close().await;
    }

    // -- 4: the permit is released by the session's drop ------------------------

    /// Dropping the sessions returns every permit, synchronously.
    ///
    /// Both halves are needed. "Returns to the full cap" alone is satisfied by a permit
    /// that was never acquired, so the count is pinned at 0 first, in the same test.
    /// And the release is asserted with no `await` between the drop and the read:
    /// `OwnedSemaphorePermit::drop` adds the permit back inline, which is precisely the
    /// property that makes an error path — a `?`, an early `return`, a panic — unable to
    /// leak a slot.
    #[tokio::test(flavor = "multi_thread")]
    async fn dropping_a_session_returns_its_permit() {
        let service = service().await;
        let peer = peer_endpoint().await;

        let (sessions, peers) = fill_to_capacity(&service, &peer).await;
        assert_eq!(
            service.available_permits(),
            0,
            "the permits must actually be held, or their release cannot be observed"
        );

        drop(sessions);

        assert_eq!(
            service.available_permits(),
            MAX_CONCURRENT_RESPONDER_SESSIONS,
            "dropping the sessions must return every permit, with no await in between: \
             the session's `Drop` is the only release mechanism, and it is what makes an \
             error path unable to leak a slot"
        );

        drop(peers);
        service.close().await;
        peer.close().await;
    }

    // -- 6: a stalled peer cannot park the accept loop --------------------------

    /// A peer that completes the handshake and never opens a stream must not stop the
    /// next peer being admitted.
    ///
    /// This is the failure that defeats the cap with a *single* connection: the permit
    /// is taken before the handshake and the setup is awaited inline, so without
    /// [`CONNECTION_SETUP_TIMEOUT`] one stalled peer holds a slot *and* parks the loop,
    /// making the other 15 slots unreachable no matter how well-behaved the peers
    /// waiting behind it are. The old stack said the same thing in TLS terms: "16 such
    /// stalls wedge every responder slot" — except here one suffices.
    ///
    /// The load-bearing assertion is that the *second* peer is admitted. Asserting only
    /// that the stalled peer is dropped would be satisfiable by a service that had
    /// stopped accepting entirely, which is the very thing this is about.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_peer_that_stalls_before_opening_a_stream_does_not_park_the_accept_loop() {
        let mut service = service().await;
        service.set_connection_setup_timeout(TEST_SETUP_TIMEOUT);
        let service = Arc::new(service);
        let peer = peer_endpoint().await;

        // The stalled peer: completes the handshake, opens no stream, and holds the
        // connection so the service's `accept_bi` genuinely waits rather than erroring
        // out on a closed connection.
        let (handshaked_tx, handshaked_rx) = tokio::sync::oneshot::channel();
        let stalled = tokio::spawn({
            let peer = peer.clone();
            let addr = service.addr();
            async move {
                let conn = peer
                    .connect(addr, SYNC_ALPN)
                    .await
                    .expect("the stalled peer completes its handshake");
                let _ = handshaked_tx.send(());
                // Never opens a bi-stream.
                tokio::time::sleep(TEST_TIMEOUT).await;
                drop(conn);
            }
        });

        // The service has to be pumping for the stalled peer's handshake to complete at
        // all — which is what puts the accept loop inside the window under test.
        let accepting = tokio::spawn({
            let service = Arc::clone(&service);
            async move { service.accept().await }
        });

        tokio::time::timeout(TEST_TIMEOUT, handshaked_rx)
            .await
            .expect("the stalled peer's handshake must complete")
            .expect("the handshake signal is not dropped");

        // Only now dial the well-behaved peer, so it is unambiguously behind the
        // stalled one in the single serialized accept loop.
        let dialing = dial(&peer, service.addr());

        let session = tokio::time::timeout(ADMISSION_DEADLINE, accepting)
            .await
            .expect(
                "a well-behaved peer must be admitted while a stalled one is timed out: \
                 the accept loop was still parked on the stalled peer after the \
                 admission deadline, so one connection has made every remaining slot \
                 unreachable",
            )
            .expect("the accept task does not panic")
            .expect("accept does not fail")
            .expect("the endpoint is open, so accept must yield a session");

        let held = tokio::time::timeout(TEST_TIMEOUT, dialing)
            .await
            .expect("the well-behaved peer's dial completes")
            .expect("the dialing task does not panic");

        assert_eq!(
            session.remote,
            peer.id(),
            "the admitted session must be the well-behaved peer's"
        );
        // The stalled peer's slot must have come back. If the elapsed path leaked its
        // permit this reads one lower, and no timeout in this test would say so.
        assert_eq!(
            service.available_permits(),
            MAX_CONCURRENT_RESPONDER_SESSIONS - 1,
            "only the one live session may hold a slot: the stalled peer's permit must \
             be released when its setup times out, not leaked"
        );

        stalled.abort();
        drop(held);
        drop(session);
        service.close().await;
        peer.close().await;
    }

    /// The setup bound must be the value the old transport shipped.
    ///
    /// Asserted as a literal rather than as equality with `TLS_HANDSHAKE_TIMEOUT`, for
    /// the reason `driver`'s own limits test gives about `CLOSE_WAIT`: that constant's
    /// documented scope is the TLS handshake plus the WebSocket upgrade, machinery this
    /// port deletes, so a tune made for *its* story would otherwise silently retune QUIC
    /// connection setup with every test still green.
    #[test]
    fn the_connection_setup_bound_is_the_value_carried_from_the_old_transport() {
        assert_eq!(
            CONNECTION_SETUP_TIMEOUT,
            Duration::from_secs(10),
            "carried from TLS_HANDSHAKE_TIMEOUT, whose sizing rationale — LAN handshakes \
             in well under a second, headroom for a loaded device, still fast enough to \
             keep the 16-slot pool flowing — describes this window exactly"
        );
        // The old constant's own doc draws this line: connection setup is "distinct from
        // (and far below) the 120 s per-message HANDSHAKE_TIMEOUT and 180 s RECV_TIMEOUT,
        // which cover the established session, not connection setup".
        assert!(
            CONNECTION_SETUP_TIMEOUT < crate::sync_constants::HANDSHAKE_TIMEOUT,
            "a setup bound at or above the per-message session bound would let one peer \
             hold a slot for a whole session's worth of time without ever starting one"
        );
    }

    // -- 5: the service's endpoint is the LAN-only one --------------------------

    /// The service must be built on [`lan_only`], not on a plain iroh endpoint.
    ///
    /// The guard is `endpoint`'s: a resolver that answers nothing and records every
    /// question. If [`SyncService::bind`] ever reaches for a preset instead —
    /// `presets::N0DisableRelay` is the one whose *name* reads like our requirement —
    /// the n0 address-lookup services come back and this records the hostnames.
    ///
    /// A session is completed first so the silence is not the silence of a dead
    /// endpoint. "Resolved nothing" is trivially true of an endpoint that cannot accept
    /// a connection, and that is the shape this half rules out.
    #[tokio::test(flavor = "multi_thread")]
    async fn the_services_endpoint_resolves_no_hostnames() {
        let recorder = RecordingResolver::new();
        let service = service_with(&recorder).await;
        let peer = peer_endpoint().await;

        let dialing = dial(&peer, service.addr());
        let session = tokio::time::timeout(TEST_TIMEOUT, service.accept())
            .await
            .expect("the accept must not hang")
            .expect("accept does not fail")
            .expect("the endpoint is open, so accept must yield a session");
        let held = tokio::time::timeout(TEST_TIMEOUT, dialing)
            .await
            .expect("the dial completes")
            .expect("the dialing task does not panic");

        // Proving an absence means giving the endpoint time to act.
        tokio::time::sleep(SETTLE).await;
        let queries = recorder.queries();

        drop(held);
        drop(session);
        service.close().await;
        peer.close().await;

        assert!(
            queries.is_empty(),
            "the sync service accepted a session but attempted {} DNS lookup(s) to do \
             it, so its endpoint is not the LAN-only one: {queries:?}",
            queries.len()
        );
    }
}
