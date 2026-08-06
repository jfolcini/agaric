//! Driving a [`SyncOrchestrator`] to completion over a QUIC bi-stream (#78, plan
//! #3464 slice 1).
//!
//! # One loop, where there were two
//!
//! Today the same loop is written twice: `sync_daemon::server::handle_incoming_sync`
//! drives the responder, `sync_daemon::session_supervisor::run_sync_session` drives the
//! initiator, and both hand-roll `while !is_terminal { recv → handle_message → send +
//! drain }`. The only thing they share is `dispatch_with_handshake_timeout`, whose own
//! doc calls itself "the ONE guard shared by all three dispatch sites" — an admission
//! that the sites had already drifted far enough to need a named remedy.
//!
//! They are two copies because the old transport made them asymmetric for a reason
//! that no longer applies. The responder could not know who it was talking to until it
//! had read `HeadExchange` and inspected the TLS certificate behind it, so its first
//! message was an identity event, not a protocol event, and its loop had to start one
//! step later than the initiator's. Under QUIC the peer is authenticated by the
//! handshake itself, before a single application byte moves: `EndpointId` is known at
//! accept time (plan #3464 D3). The asymmetry that forced two loops is gone, and what
//! is left is genuinely symmetric — one side speaks first, and that is the whole
//! difference.
//!
//! # Both bounds are inherited, not invented
//!
//! A session loop needs two clocks, and the old stack had both. Losing either in the
//! port would be silent:
//!
//! * **Per-dispatch**, [`SessionLimits::dispatch`] — `sync_constants::HANDSHAKE_TIMEOUT`
//!   (120 s), already applied at all three of the old dispatch sites.
//! * **Per-receive**, [`SessionLimits::recv`] — 180 s, carried from
//!   `SyncConnection::RECV_TIMEOUT`, which bounded *every* `recv` on the WebSocket
//!   stream (`sync_net::connection`). This one is easy to drop on the way across,
//!   because QUIC has no equivalent built in: `RecvStream::read_exact` on a peer that
//!   simply stops talking waits forever. The old value moves with the responsibility
//!   rather than being re-derived, and it is the number the responder's permit
//!   accounting is already written against ("the permit is held for the entire
//!   responder session … which can live up to `RECV_TIMEOUT` = 180 s").
//!
//! # Shutdown is a protocol step, not cleanup
//!
//! The responder reaches its terminal state the moment it *queues* `SyncComplete` —
//! one round trip before the initiator has read it. Dropping the connection there
//! discards the in-flight frame, and the initiator fails with "connection lost" having
//! done everything right. This is not hypothetical: it is how the first run of
//! `session::tests::two_lan_only_endpoints_complete_a_real_sync_handshake` failed.
//!
//! So [`finish_session`] is role-aware. The responder finishes its stream and then
//! waits for the initiator to close the connection, which is the only evidence
//! available that the last frame landed. The initiator, having read everything it
//! needs, closes. WebSocket's close handshake used to supply this for free, which is
//! why nothing in the old code looks like it.

use std::time::Duration;

use iroh::endpoint::{Connection, RecvStream, SendStream};

use agaric_core::error::AppError;

use crate::sync_constants::HANDSHAKE_TIMEOUT;
use crate::sync_protocol::{SyncOrchestrator, SyncState};
use crate::transport::session::{recv_sync_message, send_sync_message};

/// Which end of a session this side drives.
///
/// The only behavioural difference is who speaks first and who waits at the end. It is
/// deliberately not a capability or a permission — authorization happens at the QUIC
/// handshake, above this module.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    /// Opens the bi-stream and sends the opening `HeadExchange`.
    Initiator,
    /// Accepts the bi-stream and answers.
    Responder,
}

/// The two clocks a session runs on.
///
/// A struct rather than two constants so tests can drive the bounds directly. A
/// timeout that only fires after 180 s is a timeout no test asserts, and an unasserted
/// bound is how the receive clock would go missing in the first place.
#[derive(Debug, Clone, Copy)]
pub struct SessionLimits {
    /// Longest wait for the peer's next message. See the module docs: carried from
    /// `SyncConnection::RECV_TIMEOUT`, because QUIC supplies no equivalent.
    pub recv: Duration,
    /// Longest single `handle_message` dispatch, from `HANDSHAKE_TIMEOUT`.
    pub dispatch: Duration,
}

/// Carried from `SyncConnection::RECV_TIMEOUT` (`sync_net::connection`), the bound the
/// old transport applied to every receive. Restated here rather than imported because
/// `sync_net` is retired by this port; the value is the one that shipped, not a new
/// guess.
const RECV_TIMEOUT: Duration = Duration::from_secs(180);

impl Default for SessionLimits {
    fn default() -> Self {
        Self {
            recv: RECV_TIMEOUT,
            dispatch: HANDSHAKE_TIMEOUT,
        }
    }
}

/// How a session's stream was shut down.
///
/// `PeerDidNotClose` is reported rather than raised: by the time we are waiting, every
/// byte we owed has been written and finished. A peer that vanishes without closing
/// politely has not cost us correctness, and failing the whole sync for it would turn
/// a clean session into a spurious error the scheduler would then back off on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Shutdown {
    /// The peer closed the connection, so the final frame was certainly read.
    Clean,
    /// The wait elapsed. Our data was sent and finished; the peer never closed.
    PeerDidNotClose,
}

/// Drive `orch` until it reaches a terminal state.
///
/// Returns the terminal [`SyncState`] — which may be `Failed`. A caller that needs
/// success must ask for it; "terminal" and "succeeded" are different questions and
/// conflating them is how a handshake test comes to accept a failure.
///
/// # Errors
/// If a frame fails to send or receive, a dispatch exceeds
/// [`SessionLimits::dispatch`], or the peer goes quiet for longer than
/// [`SessionLimits::recv`].
pub async fn run_session(
    role: Role,
    orch: &mut SyncOrchestrator,
    send: &mut SendStream,
    recv: &mut RecvStream,
    limits: SessionLimits,
) -> Result<SyncState, AppError> {
    if role == Role::Initiator {
        let opening = orch.start().await?;
        send_sync_message(send, &opening).await?;
    }

    while !orch.is_terminal() {
        let incoming = tokio::time::timeout(limits.recv, recv_sync_message(recv))
            .await
            .map_err(|_| {
                AppError::InvalidOperation(format!(
                    "[transport::driver] peer sent nothing for {}s",
                    limits.recv.as_secs()
                ))
            })??;

        let reply = tokio::time::timeout(limits.dispatch, orch.handle_message(incoming))
            .await
            .map_err(|_| {
                AppError::InvalidOperation(format!(
                    "handle_message timed out after {}s",
                    limits.dispatch.as_secs()
                ))
            })??;

        if let Some(reply) = reply {
            send_sync_message(send, &reply).await?;
        }
        // The FSM queues follow-up batches rather than returning them, so a dispatch
        // that produced no direct reply may still owe the peer messages.
        while let Some(queued) = orch.next_message() {
            send_sync_message(send, &queued).await?;
        }
    }

    Ok(orch.state.clone())
}

/// Close down this side's stream, waiting for the peer where that is what proves the
/// last frame landed. See the module docs for why this is protocol, not cleanup.
///
/// # Errors
/// If the stream cannot be finished. A peer that never closes is reported as
/// [`Shutdown::PeerDidNotClose`], not an error.
pub async fn finish_session(
    role: Role,
    send: &mut SendStream,
    conn: &Connection,
    limits: SessionLimits,
) -> Result<Shutdown, AppError> {
    send.finish().map_err(|e| {
        AppError::InvalidOperation(format!("[transport::driver] finish send stream: {e}"))
    })?;

    match role {
        Role::Responder => {
            // Our terminal state ran one round trip ahead of the peer's read. Waiting
            // for its close is the only evidence the final frame was consumed.
            match tokio::time::timeout(limits.recv, conn.closed()).await {
                Ok(_) => Ok(Shutdown::Clean),
                Err(_) => Ok(Shutdown::PeerDidNotClose),
            }
        }
        Role::Initiator => {
            // The initiator has read everything it is owed, so closing here is what
            // releases the responder from the wait above.
            conn.close(0u32.into(), b"sync complete");
            Ok(Shutdown::Clean)
        }
    }
}

#[cfg(test)]
mod tests {
    //! # What these prove
    //!
    //! [`tests::one_driver_carries_a_whole_session_for_both_roles`] is the claim of the
    //! module: the same function drives both ends. It runs two real iroh endpoints and
    //! two real `SyncOrchestrator`s and asserts `is_succeeded` on both — never
    //! `is_terminal`, which `Failed` also satisfies.
    //!
    //! The two bound tests exist because [`SessionLimits`] exists. A 180 s timeout that
    //! no test drives is indistinguishable from a missing one, and the receive bound is
    //! precisely the thing this port could have dropped without any symptom until a
    //! peer went quiet in production.

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
    use crate::transport::endpoint::{RecordingResolver, lan_only};

    const SYNC_ALPN: &[u8] = b"agaric/sync/0";

    /// Hang detector, not a performance bound — a LAN handshake was measured at 0.07 s
    /// in the #3462 spike.
    const TEST_TIMEOUT: Duration = Duration::from_secs(30);

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

    /// See `session::tests::orchestrator` for why `with_expected_remote_id` is
    /// modelling production rather than bypassing it: in production the daemon supplies
    /// it from the QUIC-authenticated `EndpointId` (plan #3464 D3).
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

    /// The module's whole claim: one function, both ends, a real session between them.
    #[tokio::test(flavor = "multi_thread")]
    async fn one_driver_carries_a_whole_session_for_both_roles() {
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
                let conn = listener
                    .accept()
                    .await
                    .expect("an inbound connection")
                    .await
                    .expect("QUIC handshake completes");
                let (mut send, mut recv) = conn.accept_bi().await.expect("peer opens a bi-stream");

                let state = run_session(
                    Role::Responder,
                    &mut orch,
                    &mut send,
                    &mut recv,
                    SessionLimits::default(),
                )
                .await
                .expect("responder drives to a terminal state");

                let shutdown =
                    finish_session(Role::Responder, &mut send, &conn, SessionLimits::default())
                        .await
                        .expect("responder shuts its stream down");

                (orch.is_succeeded(), state, shutdown)
            }
        });

        let (initiator_succeeded, initiator_state) = tokio::time::timeout(TEST_TIMEOUT, async {
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

            let state = run_session(
                Role::Initiator,
                &mut orch,
                &mut send,
                &mut recv,
                SessionLimits::default(),
            )
            .await
            .expect("initiator drives to a terminal state");

            finish_session(Role::Initiator, &mut send, &conn, SessionLimits::default())
                .await
                .expect("initiator shuts its stream down");

            (orch.is_succeeded(), state)
        })
        .await
        .expect("the session must not hang");

        let (responder_succeeded, responder_state, responder_shutdown) =
            tokio::time::timeout(TEST_TIMEOUT, responder_task)
                .await
                .expect("the responder must not hang")
                .expect("responder task does not panic");

        assert!(
            initiator_succeeded,
            "initiator must SUCCEED, not merely reach a terminal state; got {initiator_state:?}"
        );
        assert!(
            responder_succeeded,
            "responder must SUCCEED, not merely reach a terminal state; got {responder_state:?}"
        );
        assert_eq!(
            responder_shutdown,
            Shutdown::Clean,
            "the initiator closes after reading the final frame, so the responder's \
             wait must observe it"
        );

        listener.close().await;
        connector.close().await;
    }

    /// A peer that connects and then says nothing must fail on the receive clock.
    ///
    /// Without [`SessionLimits::recv`] this hangs forever holding whatever the caller
    /// holds — in production, a responder permit and a per-peer lock. QUIC supplies no
    /// such bound of its own, which is exactly why the old
    /// `SyncConnection::RECV_TIMEOUT` had to be carried across rather than assumed.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_silent_peer_trips_the_receive_bound_instead_of_hanging() {
        let (pool, _dir) = test_pool().await;
        let host = Arc::new(RecordingApplyHost::new());

        let listener = lan_builder()
            .alpns(vec![SYNC_ALPN.to_vec()])
            .bind()
            .await
            .expect("listener binds");
        let listener_addr = listener.addr();
        let connector = lan_builder().bind().await.expect("connector binds");

        // Accept the stream and then never speak.
        let mute = tokio::spawn({
            let listener = listener.clone();
            async move {
                let conn = listener
                    .accept()
                    .await
                    .expect("inbound connection")
                    .await
                    .expect("handshake completes");
                let (_send, _recv) = conn.accept_bi().await.expect("bi-stream");
                tokio::time::sleep(TEST_TIMEOUT).await;
            }
        });

        let conn = connector
            .connect(listener_addr, SYNC_ALPN)
            .await
            .expect("connects");
        let (mut send, mut recv) = conn.open_bi().await.expect("bi-stream");
        let mut orch = orchestrator(&pool, "device-initiator", "device-responder", &host);

        let limits = SessionLimits {
            recv: Duration::from_millis(150),
            ..SessionLimits::default()
        };
        let err = tokio::time::timeout(
            TEST_TIMEOUT,
            run_session(Role::Initiator, &mut orch, &mut send, &mut recv, limits),
        )
        .await
        .expect("the receive bound must fire long before the test timeout")
        .expect_err("a silent peer must fail the session");

        assert!(
            err.to_string().contains("sent nothing"),
            "expected the receive bound to fire, got: {err}"
        );

        mute.abort();
        conn.close(0u32.into(), b"done");
        listener.close().await;
        connector.close().await;
    }

    /// The dispatch clock must bound `handle_message` itself, not just the wait for a
    /// message. A zero budget makes any dispatch elapse, which is the cheapest way to
    /// prove the guard is wired at all.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_dispatch_that_exceeds_its_budget_fails_the_session() {
        let (responder_pool, _responder_dir) = test_pool().await;
        let (initiator_pool, _initiator_dir) = test_pool().await;
        let responder_host = Arc::new(RecordingApplyHost::new());
        let initiator_host = Arc::new(RecordingApplyHost::new());

        let listener = lan_builder()
            .alpns(vec![SYNC_ALPN.to_vec()])
            .bind()
            .await
            .expect("listener binds");
        let listener_addr = listener.addr();
        let connector = lan_builder().bind().await.expect("connector binds");

        // A well-behaved initiator, so the responder definitely has a message to
        // dispatch and the failure can only come from the dispatch clock.
        let initiator = tokio::spawn({
            let initiator_pool = initiator_pool.clone();
            let host = initiator_host.clone();
            async move {
                let mut orch = orchestrator(
                    &initiator_pool,
                    "device-initiator",
                    "device-responder",
                    &host,
                );
                let conn = connector
                    .connect(listener_addr, SYNC_ALPN)
                    .await
                    .expect("connects");
                let (mut send, mut recv) = conn.open_bi().await.expect("bi-stream");
                let _ = run_session(
                    Role::Initiator,
                    &mut orch,
                    &mut send,
                    &mut recv,
                    SessionLimits::default(),
                )
                .await;
                conn.close(0u32.into(), b"done");
            }
        });

        let conn = listener
            .accept()
            .await
            .expect("inbound connection")
            .await
            .expect("handshake completes");
        let (mut send, mut recv) = conn.accept_bi().await.expect("bi-stream");
        let mut orch = orchestrator(
            &responder_pool,
            "device-responder",
            "device-initiator",
            &responder_host,
        );

        let limits = SessionLimits {
            dispatch: Duration::ZERO,
            ..SessionLimits::default()
        };
        let err = tokio::time::timeout(
            TEST_TIMEOUT,
            run_session(Role::Responder, &mut orch, &mut send, &mut recv, limits),
        )
        .await
        .expect("the dispatch bound must fire long before the test timeout")
        .expect_err("a dispatch over budget must fail the session");

        assert!(
            err.to_string().contains("handle_message timed out"),
            "expected the dispatch bound to fire, got: {err}"
        );

        initiator.abort();
        listener.close().await;
    }

    /// The bounds must be the ones the old transport shipped. A future edit that
    /// "rounds" either of them is a behaviour change to the session loop, and should
    /// have to say so here.
    #[test]
    fn default_limits_are_the_values_carried_from_the_old_transport() {
        let limits = SessionLimits::default();
        assert_eq!(
            limits.recv,
            Duration::from_secs(180),
            "carried from SyncConnection::RECV_TIMEOUT"
        );
        assert_eq!(
            limits.dispatch, HANDSHAKE_TIMEOUT,
            "the dispatch bound is the crate's existing HANDSHAKE_TIMEOUT"
        );
    }
}
