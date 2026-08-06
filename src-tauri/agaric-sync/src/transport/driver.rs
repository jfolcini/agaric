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
//! A side reaches its terminal state the moment it *queues* the final message — one
//! round trip before the peer has read it. Closing there discards the in-flight frame
//! (`Connection::close` lets the remote "drop any data it received but is as yet
//! undelivered to the application"), and the peer fails with "connection lost" having
//! done everything right. This is not hypothetical: it is how the first run of
//! `session::tests::two_lan_only_endpoints_complete_a_real_sync_handshake` failed.
//!
//! So the side that spoke last finishes its stream and waits for the peer's close,
//! which is the only available evidence the last frame landed. WebSocket's close
//! handshake supplied this for free, which is why nothing in the old code looks like it.
//!
//! **The wait is keyed on who spoke last, not on [`Role`].** Role looks like the right
//! key and is not. The protocol says `SyncComplete` is "sent once by the puller … in
//! the normal flow that is the initiator; in the empty-registry short-circuit the
//! responder sends it directly because it had nothing to stream". So the terminal
//! sender is the *responder* only for two empty vaults, and the *initiator* for every
//! session that actually transfers anything. A role-keyed wait is correct for the
//! degenerate shape and drops the final frame in the normal one — which costs more
//! than a retry: the initiator's `SyncComplete` is what runs `persist_peer_loro_vvs`,
//! so losing it re-ships a full snapshot next session and books a clean sync as a
//! failure the scheduler backs off on.

use std::time::Duration;

use iroh::endpoint::{Connection, RecvStream, SendStream};

use agaric_core::error::AppError;

use agaric_store::cancellation::CancellationToken;

use crate::sync_constants::{HANDSHAKE_TIMEOUT, TLS_HANDSHAKE_TIMEOUT};
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
    /// Longest wait for the peer to close after we have finished sending.
    ///
    /// Deliberately *not* [`Self::recv`]. The responder's permit accounting says a
    /// session "can live up to `RECV_TIMEOUT` = 180 s"; charging the close-wait to the
    /// same clock would let a peer that vanishes without closing cost session + 180 s
    /// and quietly double the budget that sentence promises. `TLS_HANDSHAKE_TIMEOUT`'s
    /// own rationale already describes this situation exactly — "generous headroom for
    /// a slow/loaded device or a brief network hiccup while still failing a genuinely
    /// stalled peer fast enough to keep the 16-slot pool flowing".
    pub close_wait: Duration,
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
            close_wait: TLS_HANDSHAKE_TIMEOUT,
        }
    }
}

/// How a session ended, and who owes the shutdown wait.
#[derive(Debug, Clone)]
pub struct SessionEnd {
    /// The terminal state. May be `Failed` — "terminal" and "succeeded" are different
    /// questions, and conflating them is how a handshake test comes to accept a failure.
    pub state: SyncState,
    /// True when this side wrote the final frame, so the peer has not read it yet.
    ///
    /// This, not [`Role`], is what decides who waits at shutdown. Role looks like the
    /// right key and is not: the protocol says `SyncComplete` is "sent once by the
    /// puller … in the normal flow that is the initiator; in the empty-registry
    /// short-circuit the responder sends it directly because it had nothing to
    /// stream". Both sides are the terminal sender in some sessions, so a role-keyed
    /// wait is correct for one shape and drops the last frame in the other.
    pub spoke_last: bool,
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
    cancel: Option<&CancellationToken>,
    limits: SessionLimits,
) -> Result<SessionEnd, AppError> {
    let mut spoke_last = false;

    if role == Role::Initiator {
        let opening = orch.start().await?;
        send_sync_message(send, &opening).await?;
        spoke_last = true;
    }

    while !orch.is_terminal() {
        // Checked before every receive, matching the guard both replaced loops had
        // (`server.rs:590`, `session_supervisor.rs:1054`, #1605). Without it a
        // shutdown does not land until the recv clock expires, pinning the responder
        // permit and the per-peer lock for up to 180 s instead of one recv cycle.
        if cancel.is_some_and(CancellationToken::is_cancelled) {
            return Err(AppError::InvalidOperation(
                "[transport::driver] session cancelled".to_owned(),
            ));
        }

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
        spoke_last = false;

        if let Some(reply) = reply {
            send_sync_message(send, &reply).await?;
            spoke_last = true;
        }
        // The FSM queues follow-up batches rather than returning them, so a dispatch
        // that produced no direct reply may still owe the peer messages.
        while let Some(queued) = orch.next_message() {
            send_sync_message(send, &queued).await?;
            spoke_last = true;
        }
    }

    Ok(SessionEnd {
        state: orch.state.clone(),
        spoke_last,
    })
}

/// Close down this side's stream, waiting for the peer where that is what proves the
/// last frame landed. See the module docs for why this is protocol, not cleanup.
///
/// # Errors
/// If the stream cannot be finished. A peer that never closes is reported as
/// [`Shutdown::PeerDidNotClose`], not an error.
pub async fn finish_session(
    spoke_last: bool,
    send: &mut SendStream,
    conn: &Connection,
    limits: SessionLimits,
) -> Result<Shutdown, AppError> {
    send.finish().map_err(|e| {
        AppError::InvalidOperation(format!("[transport::driver] finish send stream: {e}"))
    })?;

    if spoke_last {
        // We are a round trip ahead of the peer's read. `Connection::close` lets the
        // remote "drop any data it received but is as yet undelivered to the
        // application", so closing here is what discards our own final frame. The
        // peer's close is the only available evidence it was consumed.
        match tokio::time::timeout(limits.close_wait, conn.closed()).await {
            Ok(_) => Ok(Shutdown::Clean),
            Err(_) => Ok(Shutdown::PeerDidNotClose),
        }
    } else {
        // The peer spoke last, so everything we are owed has been read. Closing is
        // what releases the peer from the wait above.
        conn.close(0u32.into(), b"sync complete");
        Ok(Shutdown::Clean)
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
    use crate::sync_protocol::SyncMessage;
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

                let end = run_session(
                    Role::Responder,
                    &mut orch,
                    &mut send,
                    &mut recv,
                    None,
                    SessionLimits::default(),
                )
                .await
                .expect("responder drives to a terminal state");

                let shutdown =
                    finish_session(end.spoke_last, &mut send, &conn, SessionLimits::default())
                        .await
                        .expect("responder shuts its stream down");

                (orch.is_succeeded(), end, shutdown)
            }
        });

        let (initiator_succeeded, initiator_end) = tokio::time::timeout(TEST_TIMEOUT, async {
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

            let end = run_session(
                Role::Initiator,
                &mut orch,
                &mut send,
                &mut recv,
                None,
                SessionLimits::default(),
            )
            .await
            .expect("initiator drives to a terminal state");

            finish_session(end.spoke_last, &mut send, &conn, SessionLimits::default())
                .await
                .expect("initiator shuts its stream down");

            (orch.is_succeeded(), end)
        })
        .await
        .expect("the session must not hang");

        let (responder_succeeded, responder_end, responder_shutdown) =
            tokio::time::timeout(TEST_TIMEOUT, responder_task)
                .await
                .expect("the responder must not hang")
                .expect("responder task does not panic");

        assert!(
            initiator_succeeded,
            "initiator must SUCCEED, not merely reach a terminal state; got {:?}",
            initiator_end.state
        );
        assert!(
            responder_succeeded,
            "responder must SUCCEED, not merely reach a terminal state; got {:?}",
            responder_end.state
        );
        assert_eq!(
            responder_shutdown,
            Shutdown::Clean,
            "the initiator closes after reading the final frame, so the responder's \
             wait must observe it"
        );
        // Pins WHICH shape this test covers. Two empty vaults take the
        // empty-registry short-circuit, where the responder sends `SyncComplete`
        // directly — so this test can never exercise the normal flow, in which the
        // initiator is the terminal sender. That is what
        // `the_terminal_sender_waits_even_when_it_is_the_initiator` is for, and
        // asserting the roles here is what stops the two tests silently converging.
        assert!(
            responder_end.spoke_last,
            "empty-registry short-circuit: the responder sends SyncComplete directly"
        );
        assert!(
            !initiator_end.spoke_last,
            "in this shape the initiator's last action is a read, not a write"
        );

        listener.close().await;
        connector.close().await;
    }

    /// The regression test for the role-keyed shutdown.
    ///
    /// [`one_driver_carries_a_whole_session_for_both_roles`] runs two empty vaults, so
    /// it takes the empty-registry short-circuit where the *responder* sends
    /// `SyncComplete`. That is the one shape a role-keyed wait gets right. In the
    /// normal flow the responder streams and the **initiator** is the terminal
    /// sender — and a version that closes on `Role::Initiator` drops that frame.
    ///
    /// Rather than build a populated Loro vault, the peer is scripted: it plays the
    /// streaming responder by hand, so the initiator reaches `complete_pull_session`
    /// and emits the final `SyncComplete`. The load-bearing assertion is on the peer
    /// side — it must actually *receive* that frame.
    #[tokio::test(flavor = "multi_thread")]
    async fn the_terminal_sender_waits_even_when_it_is_the_initiator() {
        use agaric_store::test_support::{TEST_SPACE_ID, ensure_test_space};

        use crate::sync_protocol::loro_sync_types::{LORO_SYNC_PROTOCOL_VERSION, LoroSyncMessage};

        let (initiator_pool, _initiator_dir) = test_pool().await;
        ensure_test_space(&initiator_pool).await;
        let initiator_host = Arc::new(RecordingApplyHost::new());

        let listener = lan_builder()
            .alpns(vec![SYNC_ALPN.to_vec()])
            .bind()
            .await
            .expect("listener binds");
        let listener_addr = listener.addr();
        let connector = lan_builder().bind().await.expect("connector binds");

        // A hand-written responder: read the opening HeadExchange, stream one final
        // LoroSync, then read what the initiator sends back.
        let scripted_peer = tokio::spawn({
            let listener = listener.clone();
            async move {
                let conn = listener
                    .accept()
                    .await
                    .expect("inbound connection")
                    .await
                    .expect("handshake completes");
                let (mut send, mut recv) = conn.accept_bi().await.expect("bi-stream");

                let opening = recv_sync_message(&mut recv)
                    .await
                    .expect("the initiator opens with HeadExchange");
                assert!(
                    matches!(opening, SyncMessage::HeadExchange { .. }),
                    "expected HeadExchange, got {opening:?}"
                );

                let doc = loro::LoroDoc::new();
                let bytes = doc
                    .export(loro::ExportMode::Snapshot)
                    .expect("an empty Loro doc exports a snapshot");
                let space_id = agaric_store::space::SpaceId::from_string(TEST_SPACE_ID)
                    .expect("the test space id is a valid ULID");
                send_sync_message(
                    &mut send,
                    &SyncMessage::LoroSync {
                        msg: LoroSyncMessage::Snapshot {
                            protocol_version: LORO_SYNC_PROTOCOL_VERSION,
                            space_id,
                            bytes,
                        },
                        is_last: true,
                    },
                )
                .await
                .expect("the scripted responder streams its final LoroSync");

                // THE assertion. The initiator has just become the terminal sender; if
                // it closes instead of waiting, this read fails with "connection lost"
                // — the exact failure the module docs describe for the other role.
                let final_frame = recv_sync_message(&mut recv).await;
                let _ = send.finish();
                conn.close(0u32.into(), b"scripted peer done");
                final_frame
            }
        });

        let initiator_end = tokio::time::timeout(TEST_TIMEOUT, async {
            let mut orch = orchestrator(
                &initiator_pool,
                "device-initiator",
                "device-responder",
                &initiator_host,
            );
            let conn = connector
                .connect(listener_addr, SYNC_ALPN)
                .await
                .expect("initiator connects");
            let (mut send, mut recv) = conn.open_bi().await.expect("bi-stream");

            let end = run_session(
                Role::Initiator,
                &mut orch,
                &mut send,
                &mut recv,
                None,
                SessionLimits::default(),
            )
            .await
            .expect("initiator drives to a terminal state");

            finish_session(end.spoke_last, &mut send, &conn, SessionLimits::default())
                .await
                .expect("initiator shuts its stream down");
            end
        })
        .await
        .expect("the session must not hang");

        assert!(
            initiator_end.spoke_last,
            "in the streaming flow the initiator sends the final SyncComplete, so it \
             is the side that must wait"
        );

        let final_frame = tokio::time::timeout(TEST_TIMEOUT, scripted_peer)
            .await
            .expect("the scripted peer must not hang")
            .expect("scripted peer does not panic")
            .expect("the initiator's final frame must reach the peer, not be dropped");
        assert!(
            matches!(final_frame, SyncMessage::SyncComplete { .. }),
            "expected the initiator's SyncComplete, got {final_frame:?}"
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
            run_session(
                Role::Initiator,
                &mut orch,
                &mut send,
                &mut recv,
                None,
                limits,
            ),
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
                    None,
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
            run_session(
                Role::Responder,
                &mut orch,
                &mut send,
                &mut recv,
                None,
                limits,
            ),
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

    /// A cancelled session must stop at the next receive, not at the receive clock.
    ///
    /// Both replaced loops check a cancel flag before every recv (`server.rs:590`,
    /// `session_supervisor.rs:1054`, #1605). Without the hook a shutdown does not land
    /// until `limits.recv` expires, pinning the responder permit and the per-peer lock
    /// for up to 180 s. Same class of silent loss as the receive clock itself — a guard
    /// the old transport supplied that a port drops by simply not mentioning it.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_cancelled_session_stops_without_waiting_for_the_receive_clock() {
        let (pool, _dir) = test_pool().await;
        let host = Arc::new(RecordingApplyHost::new());

        let listener = lan_builder()
            .alpns(vec![SYNC_ALPN.to_vec()])
            .bind()
            .await
            .expect("listener binds");
        let listener_addr = listener.addr();
        let connector = lan_builder().bind().await.expect("connector binds");

        // Accepts, then never speaks — so the only way out is cancellation.
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

        let guard = agaric_store::cancellation::CancellationGuard::new();
        let token = guard.token();
        guard.cancel();

        // `recv` stays at its production 180 s. If cancellation is not consulted this
        // cannot finish inside the test budget, which is the point.
        let err = tokio::time::timeout(
            TEST_TIMEOUT,
            run_session(
                Role::Initiator,
                &mut orch,
                &mut send,
                &mut recv,
                Some(&token),
                SessionLimits::default(),
            ),
        )
        .await
        .expect("a cancelled session must not wait out the receive clock")
        .expect_err("a cancelled session must fail rather than proceed");

        assert!(
            err.to_string().contains("cancelled"),
            "expected the cancellation guard to fire, got: {err}"
        );

        mute.abort();
        conn.close(0u32.into(), b"done");
        listener.close().await;
        connector.close().await;
    }

    /// The close-wait must be its own, shorter clock.
    ///
    /// Charging it to `limits.recv` would let a peer that vanishes without closing cost
    /// session + 180 s, quietly doubling the budget the responder's permit accounting
    /// promises ("can live up to `RECV_TIMEOUT` = 180 s"). The assertion is on elapsed
    /// time because that is the property — the returned `PeerDidNotClose` is identical
    /// either way.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_peer_that_never_closes_costs_the_close_wait_not_the_receive_clock() {
        let listener = lan_builder()
            .alpns(vec![SYNC_ALPN.to_vec()])
            .bind()
            .await
            .expect("listener binds");
        let listener_addr = listener.addr();
        let connector = lan_builder().bind().await.expect("connector binds");

        // Holds the connection open and never closes it.
        let squatter = tokio::spawn({
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
        let (mut send, _recv) = conn.open_bi().await.expect("bi-stream");

        let limits = SessionLimits {
            close_wait: Duration::from_millis(150),
            ..SessionLimits::default()
        };
        let started = tokio::time::Instant::now();
        let shutdown =
            tokio::time::timeout(TEST_TIMEOUT, finish_session(true, &mut send, &conn, limits))
                .await
                .expect("the close-wait must bound this")
                .expect("finishing the stream succeeds even when the peer never closes");
        let elapsed = started.elapsed();

        assert_eq!(
            shutdown,
            Shutdown::PeerDidNotClose,
            "the peer never closed, and that must be reported rather than raised"
        );
        assert!(
            elapsed < limits.recv,
            "the close-wait must be its own clock: waited {elapsed:?}, which is not \
             clearly below the {:?} receive clock",
            limits.recv
        );

        squatter.abort();
        conn.close(0u32.into(), b"done");
        listener.close().await;
        connector.close().await;
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
        assert_eq!(
            limits.close_wait, TLS_HANDSHAKE_TIMEOUT,
            "the close-wait is its own, shorter clock"
        );
        assert!(
            limits.close_wait < limits.recv,
            "a close-wait at or above the receive clock doubles the session budget the \
             responder's permit accounting promises"
        );
    }
}
