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
//! The cap is
//! [`MAX_CONCURRENT_RESPONDER_SESSIONS`](crate::sync_constants::MAX_CONCURRENT_RESPONDER_SESSIONS)
//! (16), carried unchanged from the
//! WebSocket accept loop this replaces (`sync_net::websocket`, #1581). Its sizing
//! rationale is not about connections at all — it is about what those connections
//! contend for: "16 leaves generous headroom over any realistic paired-device count
//! **and over the 6-connection DB pool** (2 writers + 4 readers) those sessions
//! ultimately draw on".
//!
//! That is why the over-capacity connection is **refused** rather than queued, and why
//! [`Semaphore::try_acquire_owned`](tokio::sync::Semaphore::try_acquire_owned) rather
//! than `acquire_owned().await` is the
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
//! [`InboundSession::remote`] is
//! [`Connection::remote_id`](iroh::endpoint::Connection::remote_id) — the
//! [`EndpointId`](iroh::EndpointId) in the
//! peer's TLS certificate, established by the QUIC handshake before a single
//! application byte moves. This is plan #3464's D3, and it is the reason
//! [`driver`](crate::transport::driver) needs only one session loop where the old stack
//! needed two: the responder no longer has to read `HeadExchange` to find out who it is
//! talking to.
//!
//! Mapping that [`EndpointId`](iroh::EndpointId) onto an Agaric `DeviceId` is a later
//! slice and
//! deliberately absent here. An identity this module invented would be an identity the
//! transport did not authenticate.
//!
//! # Connection setup is bounded, and it is no longer serialized
//!
//! Setup is two waits with two legitimate durations:
//! `CONNECTION_SETUP_TIMEOUT` for
//! the handshake, and
//! `FIRST_FRAME_TIMEOUT` for the
//! peer's first frame, which it
//! cannot send until it has read its own heads out of the database. See that second
//! constant for why budgeting them together understated the first-message window by an
//! order of magnitude.
//!
//! Bounding them was not enough, and what was left over is worth stating because the
//! fix (#3485) is the shape this API now has. Driving both waits *inline* in the accept
//! loop made the bound a **per-queue** one rather than a per-peer one: N stalled peers
//! ahead of you cost N budgets, not one, and while the loop sat in them the other 15
//! slots were unreachable. Splitting the single 10 s budget into 10 s + 180 s — the
//! right change for the *durations* — made that blast radius 18x worse, because the
//! queue then stalls for the longer of the two.
//!
//! So [`SyncService::accept`] no longer performs setup. It returns an
//! [`AdmittedConnection`] as soon as a peer has been admitted (a permit taken *before*
//! the handshake, exactly where the old accept loop took it), and the caller spawns
//! [`AdmittedConnection::establish`] to do the waiting. One stalled peer now costs one
//! task and one slot, which is what the 16-slot cap has always claimed to bound.
//!
//! The permit rides in the [`AdmittedConnection`] and moves into the [`InboundSession`]
//! on success, so the slot is released by a `Drop` on every path — including a caller
//! that never calls `establish` at all, and a spawned task aborted or unwound
//! mid-handshake.

use std::{
    net::{IpAddr, SocketAddr},
    sync::Arc,
    time::Duration,
};

use iroh::{
    Endpoint, EndpointAddr, EndpointId, SecretKey,
    endpoint::{BindError, Connection, Incoming, RecvStream, SendStream},
};
use iroh_dns::dns::DnsResolver;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use agaric_core::error::AppError;

use crate::sync_constants::MAX_CONCURRENT_RESPONDER_SESSIONS;
use crate::transport::endpoint::{LanBindError, lan_only_with_host_addrs};

/// The ALPN every Agaric sync connection negotiates.
///
/// Both ends must agree on this byte string or the QUIC handshake fails before any
/// application data moves, which makes it the first line of defence against a
/// connection from something that is not Agaric — and, when the protocol changes
/// incompatibly, the place to say so.
pub const SYNC_ALPN: &[u8] = b"agaric/sync/0";

/// Wall-clock budget for the QUIC handshake alone.
///
/// Without it the cap this module exists to enforce is defeated by one peer. The permit
/// is taken before the handshake, so a peer that opens a connection and then stalls
/// mid-handshake holds a slot for as long as the stall lasts. The old stack described
/// the same failure in TLS terms: "16 such stalls wedge every responder slot".
///
/// **Its scope is now one peer's handshake, not the accept loop's.** Since #3485 the
/// wait happens inside [`AdmittedConnection::establish`], which the caller spawns, so
/// this bounds how long *that peer* holds *its* slot. Before the split the same number
/// also bounded how long every peer queued behind it waited to be admitted at all —
/// a second, unstated scope, and the one that made 16 slots reachable only in theory.
///
/// # Why the number is restated here rather than imported
///
/// The value is the old stack's `TLS_HANDSHAKE_TIMEOUT`, whose sizing rationale
/// describes this situation exactly — a handshake between two LAN devices completes in
/// well under a second; 10 s is generous headroom for a slow/loaded device or a brief
/// network hiccup while still failing a genuinely stalled peer fast enough to keep the
/// 16-slot pool flowing.
///
/// But its documented *scope* was `TlsAcceptor::accept` plus the WebSocket upgrade,
/// machinery this port deleted. Carrying the constant forward would have left an orphan
/// whose only consumer is this bound, and tuning it for the TLS story it was named after
/// would silently retune QUIC connection setup — so it went with the transport and the
/// number is stated here. Same reasoning as `driver`'s `RECV_TIMEOUT` and `CLOSE_WAIT`:
/// the number moves with the responsibility, not with the name.
const CONNECTION_SETUP_TIMEOUT: Duration = Duration::from_secs(10);

/// Wall-clock budget for the peer's *first frame*, which is what makes `accept_bi`
/// resolve.
///
/// # Why this is not [`CONNECTION_SETUP_TIMEOUT`]
///
/// It was, and that was wrong. A locally-opened QUIC stream is invisible to the peer
/// until something is sent on it — this module's own `dial` test helper has to write a
/// byte for exactly that reason — so `accept_bi` does not resolve when the initiator
/// *opens* its stream, it resolves when the initiator *speaks*. And the initiator's
/// first message is produced by `orch.start()`, which reads the local heads, collects
/// the Loro version vectors, and looks up the pending pairing proof. That is database
/// work on a device that may hold a large vault.
///
/// So this window covers peer-side application work, and the handshake window does not.
/// Budgeting them together at 10 s silently tightened the first-message budget from the
/// **180 s** the old stack gave it — `SyncConnection::RECV_TIMEOUT`, which bounded the
/// responder's first `recv` — down to a handshake's budget. `TLS_HANDSHAKE_TIMEOUT`
/// covered TLS plus the WebSocket upgrade, neither of which required the initiator to
/// touch the database, so it was never the right analogy for this half.
///
/// The value is therefore `RECV_TIMEOUT`'s, restated for the same reason `driver`
/// restates it: it is the budget a first message has always had, and it should not move
/// because the transport underneath it changed.
///
/// This is the same defect as #3481 in the opposite direction — there a constant kept
/// its value while its scope *widened*; here one was applied to a scope it never
/// covered. Both come of carrying a number across a transport swap by its name rather
/// than by what it bounds.
///
/// # What this does not weaken
///
/// The slot is still released on elapse, and a stalled peer is still bounded. What it
/// costs is that a peer stalled *after* the handshake now holds its slot for up to
/// 180 s rather than 10 s — which is precisely what the old responder did, so it is not
/// a regression this port introduces.
///
/// **The scope that made this expensive is gone.** When the wait ran in the accept loop
/// it was charged to every peer behind it, so raising 10 s to 180 s multiplied the queue
/// stall by 18. Since #3485 it runs in [`AdmittedConnection::establish`], off the accept
/// loop, so it bounds one peer's hold on one slot and nothing else — which is what the
/// per-connection spawn was the real fix for, rather than under-budgeting a wait that
/// legitimately needs the time.
const FIRST_FRAME_TIMEOUT: Duration = Duration::from_secs(180);

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
    /// Always [`FIRST_FRAME_TIMEOUT`] in production; drivable for the same reason as
    /// [`Self::setup_timeout`], and more urgently — at 180 s, no test could wait it out.
    first_frame_timeout: Duration,
}

/// One admitted inbound session: an authenticated peer, its bi-stream, and the
/// concurrency slot it occupies.
///
/// The permit is a private field with no accessor, so the only way to release the slot
/// is to drop the session. That is the point: a caller cannot return early, `?` out of
/// a failed handshake, or panic without also freeing the slot.
///
/// # Why this type implements [`Drop`] when it has nothing to clean up
///
/// `Self::_permit` releases itself when the struct's fields are dropped, so the
/// `Drop` impl below frees nothing that would otherwise leak. It is here for what the
/// *compiler* does in its presence, not for what its body does.
///
/// Rust forbids moving a field out of a type that implements [`Drop`]. Without the
/// impl, this compiles:
///
/// ```ignore
/// let InboundSession { conn, send, recv, remote, .. } = admitted.establish().await?;
/// ```
///
/// — and it is a slot leak in the shape most likely to be written, because it reads
/// like ordinary destructuring and the thing it discards is the field named to look
/// discardable. The permit drops *there*, at the top of the handler, while the session
/// it was accounting for runs on for up to `RECV_TIMEOUT`. The cap would still be
/// enforced; it would simply stop measuring anything, and nothing would fail.
///
/// With the impl, that line does not compile (E0509), so the streams cannot be
/// separated from the permit that paid for them. This is the difference the cutover
/// asked for between a permit released *because callers remember to hold the session*
/// and one released because there is no way not to.
///
/// The guard for that is this example, which must keep failing to compile. It needs no
/// [`SyncService`] and no network — naming the type is enough, which is why it can be a
/// doctest rather than a fixture:
///
/// ```compile_fail,E0509
/// use agaric_sync::transport::InboundSession;
///
/// // Taking the stream and letting the "unused" permit field go is the whole hazard:
/// // it returns a live stream whose concurrency slot has already been handed back.
/// fn unbundle(session: InboundSession) -> iroh::endpoint::RecvStream {
///     let InboundSession { recv, .. } = session;
///     recv
/// }
/// ```
///
/// Dropping the `impl Drop` below makes that example compile, which makes this doctest
/// fail — the falsification is the deletion of the thing it guards.
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

impl Drop for InboundSession {
    fn drop(&mut self) {
        // Intentionally empty of cleanup — see the type's docs. The permit is released
        // by its own `Drop` immediately after this returns; the value of this impl is
        // that its mere existence makes `InboundSession` non-destructurable, so the
        // permit cannot be separated from the streams whose slot it accounts for.
        //
        // The trace is the one thing worth doing here, and only because it is the
        // moment the slot actually comes back: `available_permits` rising has no other
        // observable cause, so a slot-accounting question ("did that session ever give
        // its permit back?") is answerable from a log rather than from a debugger.
        tracing::trace!(
            remote = %self.remote,
            "transport.service.session_dropped: releasing the concurrency slot"
        );
    }
}

/// A peer that has been admitted but not yet set up: it holds a slot, and nothing has
/// been waited on.
///
/// This is the whole of #3485's fix. Admission is cheap and must stay in the accept
/// loop, because refusing an over-capacity peer *before* the handshake is what stops
/// excess peers from costing CPU and file descriptors. Setup is not cheap and must not:
/// a peer that completes the handshake and then says nothing legitimately holds its
/// budget for `FIRST_FRAME_TIMEOUT`, and doing that in the accept loop charges every
/// peer behind it for the wait.
///
/// Splitting the two makes the caller's `spawn` the thing that separates them, which is
/// why this type exists rather than an internal task: what supervises a spawned session
/// is a call-site decision (the daemon already has a supervisor, a cancel flag and a
/// per-peer lock), and a service that spawned its own would have to reinvent all three.
///
/// # The permit is not lost by not calling [`Self::establish`]
///
/// Dropping an `AdmittedConnection` drops `Self::permit`, releasing the slot, and
/// drops `incoming`, which `noq` turns into an implicit reject so the peer is told. So
/// a caller that admits and then decides not to proceed — a shutdown between the two
/// steps, a spawn that is aborted — costs nothing and leaks nothing.
#[derive(Debug)]
pub struct AdmittedConnection {
    /// The un-handshaken connection. Consumed by [`Self::establish`].
    incoming: Incoming,
    /// The slot this peer occupies, taken before the handshake and released by
    /// whichever of this type or [`InboundSession`] is dropped last.
    permit: OwnedSemaphorePermit,
    /// Copied from the service at admission so setup can be spawned without borrowing
    /// it. See [`CONNECTION_SETUP_TIMEOUT`].
    setup_timeout: Duration,
    /// Copied from the service at admission. See [`FIRST_FRAME_TIMEOUT`].
    first_frame_timeout: Duration,
}

impl AdmittedConnection {
    /// Complete the QUIC handshake, then take the bi-stream the peer speaks on.
    ///
    /// Each phase carries its own budget, and they are not the same number. The first is
    /// a handshake and nothing else; the second waits on the peer's first frame, which
    /// it cannot send until `orch.start()` has read its heads and version vectors out of
    /// the database. `FIRST_FRAME_TIMEOUT` documents why collapsing the two was wrong.
    ///
    /// Returns `None` when the connection failed for a reason already logged here — the
    /// caller only needs to know it did not become a session. The slot is released on
    /// every one of those paths, by `self` being consumed.
    pub async fn establish(self) -> Option<InboundSession> {
        let Self {
            incoming,
            permit,
            setup_timeout,
            first_frame_timeout,
        } = self;

        let conn = match tokio::time::timeout(setup_timeout, incoming).await {
            Ok(Ok(conn)) => conn,
            Ok(Err(e)) => {
                tracing::debug!(error = %e, "inbound QUIC handshake failed");
                return None;
            }
            Err(_elapsed) => {
                // The half-built `Connection` is dropped inside the cancelled future,
                // and `noq`'s implicit close means the peer is told rather than left
                // hanging.
                tracing::warn!(
                    timeout_ms = setup_timeout.as_millis(),
                    "transport.service.handshake_timeout: peer did not complete the QUIC \
                     handshake; dropping it and releasing its slot"
                );
                return None;
            }
        };

        // From the peer's TLS certificate, established by the handshake above.
        let remote = conn.remote_id();

        match tokio::time::timeout(first_frame_timeout, conn.accept_bi()).await {
            Ok(Ok((send, recv))) => Some(InboundSession {
                conn,
                send,
                recv,
                remote,
                _permit: permit,
            }),
            Ok(Err(e)) => {
                tracing::debug!(
                    %remote,
                    error = %e,
                    "peer connected but opened no sync bi-stream"
                );
                conn.close(0u32.into(), b"no sync stream");
                None
            }
            Err(_elapsed) => {
                tracing::warn!(
                    %remote,
                    timeout_ms = first_frame_timeout.as_millis(),
                    "transport.service.first_frame_timeout: peer completed the handshake \
                     but never sent its first frame; dropping it and releasing its slot"
                );
                conn.close(0u32.into(), b"no first frame");
                None
            }
        }
    }
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
    /// [`lan_only`](crate::transport::endpoint::lan_only) rejected the bind address or
    /// prefix. No socket was opened.
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
    /// The endpoint is built by [`lan_only`](crate::transport::endpoint::lan_only), not
    /// configured here — the posture that
    /// module proves is the posture this service gets, and re-deriving any part of it
    /// would mean re-deriving the guard too.
    ///
    /// # `host_addrs` (#3869)
    ///
    /// The addresses this host holds, as the caller enumerated them, for the locality gate
    /// that decides whether a publicly-routable `bind` may be claimed. It is a parameter
    /// rather than a `getifaddrs(3)` call inside
    /// [`lan_only`](crate::transport::endpoint::lan_only) because the daemon's caller
    /// has **already** enumerated the host to pick `bind` in the first place: sweeping
    /// again here opens a window in which an address can disappear between the two reads,
    /// and the bind then fails as `BindAddressNotPrivate` rather than falling back to
    /// loopback. Pass the list the bind address came from; `&[]` vouches for nothing,
    /// which refuses a publicly-routable bind and admits any other.
    ///
    /// # Errors
    /// [`ServiceBindError::Configuration`] if the address or prefix cannot support the
    /// LAN-only posture; [`ServiceBindError::Socket`] if iroh cannot bind.
    pub async fn bind(
        bind: SocketAddr,
        prefix_len: u8,
        host_addrs: &[IpAddr],
        resolver: DnsResolver,
        secret: SecretKey,
    ) -> Result<Self, ServiceBindError> {
        let endpoint = lan_only_with_host_addrs(bind, prefix_len, resolver, host_addrs)?
            // Without this the endpoint mints a fresh identity on every bind, which is
            // harmless for a test that dials itself and fatal for anything that stores
            // an `EndpointId` — see [`identity`](super::identity).
            .secret_key(secret)
            .alpns(vec![SYNC_ALPN.to_vec()])
            .bind()
            .await?;

        Ok(Self {
            endpoint,
            limiter: Arc::new(Semaphore::new(MAX_CONCURRENT_RESPONDER_SESSIONS)),
            setup_timeout: CONNECTION_SETUP_TIMEOUT,
            first_frame_timeout: FIRST_FRAME_TIMEOUT,
        })
    }

    /// Drive *both* setup bounds at a value a test can wait for.
    ///
    /// Collapses them deliberately. A test stalls its peer in one phase or the other and
    /// should not have to know which — the stalled-peer test, for instance, reads as
    /// "never opens a stream" but actually trips the first-frame bound, because a
    /// locally-opened QUIC stream is invisible until written to. Setting one budget
    /// would make that test's outcome depend on a distinction it is not making.
    ///
    /// Test-only for the same reason `available_permits` is: production has exactly one
    /// correct value for each, and both are pinned by their own tests. Those tests are
    /// not linked from here — they live behind `cfg(test)`, so an intra-doc link to them
    /// breaks a `--features test-util` docs build.
    #[cfg(any(test, feature = "test-util"))]
    #[doc(hidden)]
    pub fn set_setup_budgets(&mut self, budget: Duration) {
        self.setup_timeout = budget;
        self.first_frame_timeout = budget;
    }

    /// This endpoint's address, which a peer needs in order to dial us.
    #[must_use]
    pub fn addr(&self) -> EndpointAddr {
        self.endpoint.addr()
    }

    /// This endpoint's identity: the key a peer dials, and the key mDNS announces.
    ///
    /// The announcing caller must take it from **here** rather than from anywhere it
    /// derived a key of its own. A record advertising a key nobody is listening on is
    /// worse than no record: peers spend a dial budget on it and learn nothing, and
    /// they cannot tell that outcome from a peer that is merely asleep.
    #[must_use]
    pub fn endpoint_id(&self) -> EndpointId {
        self.endpoint.id()
    }

    /// The endpoint itself, so an initiator dials from the same socket we accept on.
    ///
    /// Sharing one endpoint between the two roles is not a shortcut: iroh keeps per-peer
    /// path state on the endpoint, and a second endpoint would hold a second identity —
    /// which is precisely the thing `peer_refs.endpoint_id` pins. Two identities for one
    /// device would make an inbound connection unrecognisable to the peer that just
    /// synced with us outbound.
    #[must_use]
    pub fn endpoint(&self) -> &Endpoint {
        &self.endpoint
    }

    /// Admit the next inbound peer, refusing anything past the cap.
    ///
    /// Returns as soon as a peer has been *admitted* — a permit taken, nothing waited
    /// on. The handshake and the first-frame wait belong to
    /// [`AdmittedConnection::establish`], which the caller is expected to spawn; see the
    /// module docs for why doing them here made the cap's own bound a per-queue one.
    ///
    /// Returns `None` — and only `None` — when the endpoint has been closed. An
    /// over-capacity peer is refused and the loop continues, so a caller's accept loop
    /// is not torn down by one bad connection. iroh's own `Incoming::accept` docs make
    /// the case: a QUIC endpoint "listens on a normal UDP socket" and errors there are
    /// "likely not caused by the application or remote".
    ///
    /// # Errors
    /// Currently never returns `Err`; the fallible signature is the caller-facing
    /// contract, since the recoverable-vs-fatal line moves once this has a supervisor.
    pub async fn accept(&self) -> Result<Option<AdmittedConnection>, AppError> {
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

            // The budgets are copied out now rather than read at `establish` time, so a
            // spawned setup cannot outlive a borrow of the service.
            return Ok(Some(AdmittedConnection {
                incoming,
                permit,
                setup_timeout: self.setup_timeout,
                first_frame_timeout: self.first_frame_timeout,
            }));
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
        error::Error as _,
        net::{Ipv4Addr, SocketAddrV4},
        time::Duration,
    };

    use super::*;
    use crate::transport::endpoint::{RecordingResolver, lan_only};

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
    /// **This bounds the well-behaved peer too**, not just the stalled one, and that is
    /// what sizes it. If a loaded runner ever pushed a healthy peer's setup past this,
    /// the healthy peer would be dropped during its *own* setup and the test would fail
    /// announcing that the accept loop was parked on the stalled peer — a confidently
    /// wrong diagnosis, which is worse than a plain failure.
    ///
    /// So it is sized against the measurement, not against convenience: a LAN handshake
    /// was measured at **0.07 s** in the #3462 spike, and 1 s is ~14x that. The
    /// production [`CONNECTION_SETUP_TIMEOUT`] is 10 s, or ~143x the same measurement;
    /// this trades some of that margin for a test that costs ~1 s instead of ~10 s, and
    /// keeps enough that the healthy peer is not the thing under time pressure.
    const TEST_SETUP_TIMEOUT: Duration = Duration::from_secs(1);

    /// How long a well-behaved peer gets to be admitted past a stalled one.
    ///
    /// Sits between the two clocks it has to separate. With the bound in place the
    /// admission costs one [`TEST_SETUP_TIMEOUT`] plus a handshake (~1.07 s by the
    /// measurement above), so 5 s leaves ~4.7x margin; without the bound the admission
    /// never happens at all, so any finite value discriminates. Well below
    /// [`TEST_TIMEOUT`] so a missing bound fails as *this* assertion, with its diagnosis,
    /// rather than as the bare hang detector.
    const ADMISSION_DEADLINE: Duration = Duration::from_secs(5);

    /// How long a closed endpoint gets to report itself closed.
    ///
    /// `accept` on a closed endpoint does no I/O — it observes an already-closed
    /// endpoint and returns — so this is generous by orders of magnitude. It catches an
    /// `accept` that *parks* on a closed endpoint, i.e. awaits something that will never
    /// resolve.
    ///
    /// It deliberately does **not** claim to catch a `continue` in that branch, and
    /// forcing that swap proved it cannot: `Endpoint::accept` returns `None` immediately
    /// once closed, so the loop never yields, `tokio::time::timeout` never gets to
    /// observe its own deadline, and the failure surfaces as the harness's hard timeout
    /// instead. No in-process deadline can preempt a non-yielding loop. Recorded here
    /// rather than left looking like coverage.
    const CLOSED_ACCEPT_DEADLINE: Duration = Duration::from_secs(5);

    fn lan_bind() -> SocketAddr {
        SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))
    }

    const LAN_PREFIX: u8 = 8;

    async fn service_with(recorder: &RecordingResolver) -> SyncService {
        SyncService::bind(
            lan_bind(),
            LAN_PREFIX,
            &[],
            DnsResolver::custom(recorder.clone()),
            SecretKey::generate(),
        )
        .await
        .expect("a loopback /8 sync service binds")
    }

    /// Admit **and** set up the next inbound peer, the way the daemon does minus the
    /// spawn.
    ///
    /// Every test below that wants a session wants both halves; keeping the two calls
    /// together here is what stops each test from having to decide whether it is
    /// testing admission or setup.
    async fn accept_session(service: &SyncService) -> InboundSession {
        service
            .accept()
            .await
            .expect("accept does not fail")
            .expect("the endpoint is open, so accept must yield an admitted connection")
            .establish()
            .await
            .expect("a well-behaved peer completes setup")
    }

    async fn service() -> SyncService {
        service_with(&RecordingResolver::new()).await
    }

    /// The loopback port a bound service actually landed on, so a second bind can
    /// collide with it deliberately. Port 0 everywhere else means these tests never
    /// depend on a hard-coded port being free.
    fn bound_port(service: &SyncService) -> u16 {
        service
            .addr()
            .ip_addrs()
            .copied()
            .find(|sa| sa.ip().is_loopback())
            .map(|sa| sa.port())
            .expect("a loopback-bound service publishes its loopback socket address")
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
            let session = tokio::time::timeout(TEST_TIMEOUT, accept_session(service))
                .await
                .unwrap_or_else(|_| {
                    panic!(
                        "session {i} is inside the cap of {MAX_CONCURRENT_RESPONDER_SESSIONS} \
                         and must be admitted, not made to wait"
                    )
                });
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
        let session = tokio::time::timeout(TEST_TIMEOUT, accept_session(&service))
            .await
            .expect("the accept must not hang");

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

    // -- 5: a stalled peer costs one slot, and nobody else's admission ----------

    /// A peer stalled mid-setup must not delay the *next* peer's admission at all.
    ///
    /// # Why this is driven at the production budgets
    ///
    /// The previous version of this test set both setup bounds to
    /// [`TEST_SETUP_TIMEOUT`] (1 s) and asserted the next peer got in afterwards. That
    /// asserted the bound, not the fix: it passed while setup was still inline, because
    /// with a 1 s budget "parked on the stalled peer" and "admitted promptly" are a
    /// second apart. The real cost of inline setup is the *production* budget —
    /// [`FIRST_FRAME_TIMEOUT`], 180 s — charged to everyone queued behind.
    ///
    /// So this one leaves the budgets alone. With setup off the accept loop the second
    /// peer is admitted in milliseconds; with setup inline it waits 180 s, and
    /// [`ADMISSION_DEADLINE`] fails long before that. That gap is what makes the
    /// assertion about #3485's fix rather than about the constant.
    ///
    /// The load-bearing assertion is that the *second* peer is admitted. Asserting only
    /// that the stalled peer is dropped would be satisfiable by a service that had
    /// stopped accepting entirely, which is the very thing this is about.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_stalled_peers_setup_does_not_delay_the_next_peers_admission() {
        let service = Arc::new(service().await);
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

        // The daemon's shape, all of it inside one task and one deadline: admit the
        // stalled peer, spawn its setup, then admit the next peer.
        //
        // Timing the *whole* sequence rather than only the second `accept` is what makes
        // the assertion about the fix. A deadline around the second accept alone cannot
        // see inline setup at all: the stall would elapse before the timeout was even
        // armed, and the accept it wraps would then return promptly. Forcing that
        // version red proved it — it passed with the spawn removed.
        let service_for_loop = Arc::clone(&service);
        let peer_for_loop = peer.clone();
        let sequence = tokio::spawn(async move {
            let first = service_for_loop
                .accept()
                .await
                .expect("accept does not fail")
                .expect("the endpoint is open, so accept must yield an admitted connection");
            let stalled_setup = tokio::spawn(async move { first.establish().await });

            let dialing = dial(&peer_for_loop, service_for_loop.addr());
            let session = accept_session(&service_for_loop).await;
            let held = dialing.await.expect("the dialing task does not panic");
            (session, held, stalled_setup)
        });

        tokio::time::timeout(TEST_TIMEOUT, handshaked_rx)
            .await
            .expect("the stalled peer's handshake must complete")
            .expect("the handshake signal is not dropped");

        let (session, held, stalled_setup) = tokio::time::timeout(ADMISSION_DEADLINE, sequence)
            .await
            .expect(
                "a well-behaved peer must be admitted while a stalled one is still in \
                 setup: the accept loop was parked on the stalled peer past the \
                 admission deadline, so one connection has made every remaining slot \
                 unreachable for as long as its first-frame budget lasts",
            )
            .expect("the responder sequence does not panic");

        assert_eq!(
            session.remote,
            peer.id(),
            "the admitted session must be the well-behaved peer's"
        );

        stalled_setup.abort();
        stalled.abort();
        drop(held);
        drop(session);
        service.close().await;
        peer.close().await;
    }

    /// A stalled peer's slot comes back when its setup budget elapses.
    ///
    /// The companion to the test above, and separate from it on purpose: that one runs
    /// at the production budgets so the *queue* claim is honest, and no test can wait
    /// out 180 s to see the release. This one drives the bound short and asserts only
    /// the release. Both halves are needed — a service that never releases passes the
    /// first, and a service that never accepts passes the second.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_stalled_peers_slot_comes_back_when_its_setup_budget_elapses() {
        let mut service = service().await;
        service.set_setup_budgets(TEST_SETUP_TIMEOUT);
        let service = Arc::new(service);
        let peer = peer_endpoint().await;

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
                tokio::time::sleep(TEST_TIMEOUT).await;
                drop(conn);
            }
        });

        let admitted = service
            .accept()
            .await
            .expect("accept does not fail")
            .expect("the endpoint is open, so accept must yield an admitted connection");
        assert_eq!(
            service.available_permits(),
            MAX_CONCURRENT_RESPONDER_SESSIONS - 1,
            "admission takes the permit before the handshake, so the slot must already \
             be spoken for here"
        );

        let setup = tokio::spawn(async move { admitted.establish().await });

        tokio::time::timeout(TEST_TIMEOUT, handshaked_rx)
            .await
            .expect("the stalled peer's handshake must complete")
            .expect("the handshake signal is not dropped");

        let outcome = tokio::time::timeout(TEST_TIMEOUT, setup)
            .await
            .expect("the stalled setup must give up on its own budget, not hang")
            .expect("the setup task does not panic");
        assert!(
            outcome.is_none(),
            "a peer that never opens a stream must not become a session"
        );

        // Read synchronously, right after the task that held the permit resolved. If the
        // elapsed path leaked it this reads one lower, and no timeout would say so.
        assert_eq!(
            service.available_permits(),
            MAX_CONCURRENT_RESPONDER_SESSIONS,
            "the stalled peer's permit must be released when its setup budget elapses, \
             not held until the connection eventually dies"
        );

        stalled.abort();
        service.close().await;
        peer.close().await;
    }

    // -- 6: the two constants that are contracts, not tuning --------------------

    /// The ALPN on the wire must not change by accident.
    ///
    /// `driver`'s limits test pins its timeouts as literals for the same reason, and
    /// here the stakes are wire compatibility: two peers that disagree on this byte
    /// string fail the QUIC handshake outright, so a bump strands every device that has
    /// not upgraded. `SYNC_ALPN`'s own doc names it as the place to say so on an
    /// incompatible protocol change — this test is what makes saying so deliberate.
    ///
    /// It is also the only assertion that can see such a bump at all. Every other test
    /// in this crate builds *both* ends from this one constant, so they agree with each
    /// other whatever its value is. That is exactly why the copies that used to live in
    /// `driver`'s and `session`'s test modules were deleted rather than left in sync by
    /// hand: with a single definition, tests and production cannot drift apart, and with
    /// this test, the definition cannot move silently.
    #[test]
    fn the_sync_alpn_is_the_value_on_the_wire_today() {
        assert_eq!(
            SYNC_ALPN, b"agaric/sync/0",
            "changing the sync ALPN is a wire-compatibility break: peers that disagree \
             on it fail the QUIC handshake before any application byte moves. Bump it \
             deliberately, with a migration story, not as a side effect"
        );
    }

    /// Each setup bound must be the value the old transport gave *that phase*.
    ///
    /// Asserted as literals rather than as equality with the old constants, for the
    /// reason `driver`'s own limits test gives about `CLOSE_WAIT`: their documented
    /// scopes are WebSocket machinery this port deletes, so a tune made for *their*
    /// story would otherwise silently retune QUIC setup with every test still green.
    ///
    /// The pairing is the point. The first review of this module asserted only the
    /// handshake bound, against `HANDSHAKE_TIMEOUT`, on the rationale that the two
    /// "cover disjoint phases" — and that rationale was wrong, because one budget was
    /// covering both the handshake *and* the wait for a first frame that requires
    /// peer-side database work. Pinning them separately is what makes the two phases
    /// visibly two.
    #[test]
    fn each_setup_bound_is_the_value_carried_from_the_old_transport() {
        assert_eq!(
            CONNECTION_SETUP_TIMEOUT,
            Duration::from_secs(10),
            "carried from TLS_HANDSHAKE_TIMEOUT, whose sizing rationale — LAN handshakes \
             in well under a second, headroom for a loaded device, still fast enough to \
             keep the 16-slot pool flowing — describes the handshake exactly"
        );
        assert_eq!(
            FIRST_FRAME_TIMEOUT,
            Duration::from_secs(180),
            "carried from SyncConnection::RECV_TIMEOUT, which is what bounded the \
             responder's first recv on the old stack. The initiator cannot send its \
             first frame until orch.start() has read its heads and version vectors out \
             of the database, so this window covers peer-side work and a handshake \
             budget does not fit it"
        );
        // The old TLS constant's own doc draws this line: connection setup is "distinct
        // from (and far below) the 120 s per-message HANDSHAKE_TIMEOUT and 180 s
        // RECV_TIMEOUT, which cover the established session, not connection setup". That
        // remains true of the handshake half — and it is precisely why the first-frame
        // half belongs with RECV_TIMEOUT instead.
        assert!(
            CONNECTION_SETUP_TIMEOUT < FIRST_FRAME_TIMEOUT,
            "a handshake that is allowed as long as a first message has collapsed the \
             distinction this split exists to draw"
        );
    }

    // -- 7: the endpoint-closed contract ----------------------------------------

    /// A closed endpoint is the one and only `None`.
    ///
    /// This is the signal a caller's accept loop terminates on, so getting it wrong has
    /// no quiet failure mode: raising an error instead turns an ordinary shutdown into a
    /// logged fault, and looping instead spins forever on an endpoint that will never
    /// produce another connection.
    ///
    /// The error case is the one this test discriminates — see
    /// [`CLOSED_ACCEPT_DEADLINE`] for why the spin case necessarily surfaces as the
    /// harness timeout instead, which forcing it confirmed.
    #[tokio::test(flavor = "multi_thread")]
    async fn accept_returns_none_once_the_endpoint_is_closed() {
        let service = service().await;
        service.close().await;

        let outcome = tokio::time::timeout(CLOSED_ACCEPT_DEADLINE, service.accept())
            .await
            .expect(
                "accept on a closed endpoint must return promptly: it is still inside \
                 the accept loop, which is what spinning on a closed endpoint looks like",
            )
            .expect("a closed endpoint is an ordinary shutdown, not an accept failure");

        assert!(
            outcome.is_none(),
            "a closed endpoint is the ONE case that yields None — it is how a caller's \
             accept loop learns to stop; got {outcome:?}"
        );
    }

    // -- 8: the two bind failures -----------------------------------------------

    /// A prefix that cannot confine egress must surface as a *configuration* error.
    ///
    /// The variant carries meaning beyond "bind failed": `Configuration` says no socket
    /// was ever opened and the LAN-only posture was rejected up front. A `bind` that
    /// quietly repaired the prefix would be the worst outcome — a service that looks
    /// bound and confines nothing — so the test asserts the rejection, not just an error.
    #[tokio::test]
    async fn a_prefix_that_cannot_confine_egress_fails_as_a_configuration_error() {
        // `map(|_| ())` before `expect_err`: on the failing path the Ok value is a whole
        // bound `SyncService`, whose Debug dump is ~30 KB of iroh internals and buries
        // the message. Discarding it keeps the diagnosis readable.
        let err = SyncService::bind(
            lan_bind(),
            0,
            &[],
            DnsResolver::custom(RecordingResolver::new()),
            SecretKey::generate(),
        )
        .await
        .map(|_| ())
        .expect_err("a /0 prefix confines nothing and must be rejected");

        assert!(
            matches!(
                err,
                ServiceBindError::Configuration(LanBindError::PrefixTooBroad { .. })
            ),
            "a prefix too broad to confine egress must be rejected before any socket is \
             opened, and say so; got {err:?}"
        );
        assert!(
            err.source().is_some(),
            "the underlying LanBindError must stay reachable through the error chain, \
             since Display deliberately does not restate it"
        );
    }

    /// The locality gate reads the caller's list, not a fresh `getifaddrs(3)` (#3869).
    ///
    /// This is the wiring the bind-policy race fix rests on: the daemon enumerates the
    /// host once to pick an address, and the gate that decides whether that address may
    /// be claimed must answer from the *same* enumeration. Reverting the call inside
    /// [`SyncService::bind`] to `lan_only` compiles and leaves every other test in this
    /// file green, because they all bind loopback — which the gate waves through whatever
    /// list it is given.
    ///
    /// A pair, because either half alone is satisfiable by the wrong code. `&[]` vouching
    /// for nothing gives `Configuration`, and a list naming the bind address gives
    /// `Socket` — the *operating system* refusing, which is proof the configuration layer
    /// was passed. With a fresh sweep inside `lan_only` both calls answer `Configuration`
    /// and the second assertion goes red.
    ///
    /// `8.8.8.8` is *genuinely* public — allocated, routed, and reachable — and no host
    /// running this suite has it on an interface, so the OS refusal is deterministic
    /// rather than a fact about the machine. A held address would bind for real, and one
    /// this host lacks would fail identically under both shapes, which is why the address
    /// has to be one no runner can hold.
    ///
    /// It was `240.0.0.1` (class E, RFC 1112 § 4), which is the more obviously
    /// unassignable address and the wrong choice: whether the gate treats class E as
    /// public is exactly what **#4106** says is a defect and will change. The moment it
    /// does, `bind_locality_ok` short-circuits `true` for `240.0.0.1`, the `unvouched`
    /// half below stops reaching `BindAddressNotPrivate` and gets `Socket` instead, and
    /// this test goes red for a reason that has nothing to do with the wiring it covers.
    /// `8.8.8.8` is public under every reading of the range table, so no fix to
    /// [`is_publicly_routable`] can move it — and it is the same address `lan_only`'s own
    /// docs use for "not on anyone's interface".
    ///
    /// Known flake shape, cannot pass falsely: the `vouched_for` half needs the kernel to
    /// REFUSE a bind to an address this host does not hold. `net.ipv4.ip_nonlocal_bind=1`
    /// (keepalived/HA images, some container hosts) disables that refusal, the bind
    /// succeeds, and the `expect_err` panics. Ruling out a runner that *holds* `8.8.8.8`
    /// is not enough on its own.
    #[tokio::test]
    async fn the_locality_gate_reads_the_host_addresses_the_caller_passed() {
        let unheld: SocketAddr = "8.8.8.8:0".parse().expect("literal parses");
        // A /24, not the shared `LAN_PREFIX` (/8). Nothing here depends on the
        // width — the bind fails before a route is installed — but asking for
        // `8.0.0.0/8` is the exact shape `lan_only`'s docs cite as WHY the
        // locality check exists, so the fixture would read as contradicting the
        // doc it sits under.
        const UNHELD_PREFIX: u8 = 24;

        let vouched_for = SyncService::bind(
            unheld,
            UNHELD_PREFIX,
            &[unheld.ip()],
            DnsResolver::custom(RecordingResolver::new()),
            SecretKey::generate(),
        )
        .await
        .map(|_| ())
        .expect_err("this host does not hold 8.8.8.8, so the socket bind must fail");
        assert!(
            matches!(vouched_for, ServiceBindError::Socket(_)),
            "the caller's list vouched for this address, so the LAN-only configuration \
             was accepted and only the OS could refuse; got {vouched_for:?}"
        );

        let unvouched = SyncService::bind(
            unheld,
            UNHELD_PREFIX,
            &[],
            DnsResolver::custom(RecordingResolver::new()),
            SecretKey::generate(),
        )
        .await
        .map(|_| ())
        .expect_err("an empty list vouches for nothing publicly routable");
        assert!(
            matches!(
                unvouched,
                ServiceBindError::Configuration(LanBindError::BindAddressNotPrivate { .. })
            ),
            "control: with nothing to vouch for it, the same address must be refused at \
             the configuration layer; got {unvouched:?}"
        );
    }

    /// A port already in use must surface as a *socket* error.
    ///
    /// The complement of the test above, and the reason [`ServiceBindError`] has two
    /// variants at all: here the configuration was perfectly valid and the operating
    /// system refused. Collapsing the two would tell an operator to check their LAN
    /// settings when the real answer is that the port is taken.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_port_already_in_use_fails_as_a_socket_error() {
        let first = service().await;
        let taken = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, bound_port(&first)));

        let err = SyncService::bind(
            taken,
            LAN_PREFIX,
            &[],
            DnsResolver::custom(RecordingResolver::new()),
            SecretKey::generate(),
        )
        .await
        .map(|_| ())
        .expect_err("binding a port that is already in use must fail");

        assert!(
            matches!(err, ServiceBindError::Socket(_)),
            "a port collision is the operating system refusing, not a rejected \
             configuration — the LAN-only posture was valid; got {err:?}"
        );

        first.close().await;
    }

    // -- 9: the service's endpoint is the LAN-only one --------------------------

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
        let session = tokio::time::timeout(TEST_TIMEOUT, accept_session(&service))
            .await
            .expect("the accept must not hang");
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
