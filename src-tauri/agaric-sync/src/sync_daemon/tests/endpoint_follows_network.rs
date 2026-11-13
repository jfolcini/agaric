//! #6526: the daemon binds its endpoint again when the bind decision moves or the
//! endpoint stops, and retries a bring-up that failed.
//!
//! Each `/24` of the loopback `/8` stands in for one network: an endpoint bound in one
//! has no socket to leave by for another. Linux answers on the whole `/8`; other
//! systems configure only `127.0.0.1`, so these tests are Linux-only.
//!
//! An address the host loses cannot be staged here: it needs an interface to take
//! away. Run by hand with an address alias added and removed, iroh 1.4.1 stops the
//! endpoint within seconds of its address going: `accept` returns `None`, every dial
//! fails with "endpoint stopping", `is_closed` stays `false`, and the same address
//! coming back revives nothing. `MovableBind::stop_endpoint` reproduces the part the
//! daemon can see, the accept loop ending.
#![cfg(target_os = "linux")]

use super::*;
use crate::foreground::LifecycleHooks;
use crate::sync_daemon::lan_interface::{BindDecision, Level};
use crate::sync_daemon::session_supervisor::BindPolicy;
use crate::sync_scheduler::LocalEndpointAdvert;
use crate::transport::SyncService;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Mutex;
use std::time::Duration;

const OLD_NETWORK: Ipv4Addr = Ipv4Addr::new(127, 77, 1, 2);
const NEW_NETWORK: Ipv4Addr = Ipv4Addr::new(127, 77, 2, 2);
const PEER_ON_NEW_NETWORK: Ipv4Addr = Ipv4Addr::new(127, 77, 2, 3);
const EDIT_ON_PEER: &str = "01HZ6526EDITXXXXXXXXXXXXXX";

fn bind_on(ip: Ipv4Addr) -> BindDecision {
    BindDecision {
        bind: SocketAddr::from((ip, 0)),
        prefix_len: 24,
        lan_ip: Some(ip),
        verdicts: Vec::new(),
        internet_facing: false,
        level: Level::Info,
        default_route_source: None,
    }
}

/// A bind policy the test moves while the daemon runs, holding every endpoint the
/// daemon bound under it.
struct MovableBind {
    decision: Mutex<BindDecision>,
    endpoints: Mutex<Vec<Arc<SyncService>>>,
}

impl MovableBind {
    fn at(decision: BindDecision) -> Arc<Self> {
        Arc::new(Self {
            decision: Mutex::new(decision),
            endpoints: Mutex::new(Vec::new()),
        })
    }

    fn move_to(&self, decision: BindDecision) {
        *self.decision.lock().unwrap() = decision;
    }

    fn endpoints(&self) -> Vec<Arc<SyncService>> {
        self.endpoints.lock().unwrap().clone()
    }

    /// End the newest endpoint's accept loop, as iroh does when its address goes.
    async fn stop_endpoint(&self) {
        let newest = self.endpoints().pop().expect("an endpoint is bound");
        newest.close().await;
    }
}

impl BindPolicy for MovableBind {
    fn target(&self) -> BindDecision {
        self.decision.lock().unwrap().clone()
    }

    fn bound(&self, service: &Arc<SyncService>) {
        self.endpoints.lock().unwrap().push(Arc::clone(service));
    }
}

/// A scheduler whose dial that cannot leave fails quickly.
fn impatient_scheduler() -> Arc<SyncScheduler> {
    Arc::new(SyncScheduler::new().with_connect_timeout(Duration::from_millis(500)))
}

async fn start_daemon(
    device: &Device2141,
    secret: &SecretKey,
    scheduler: &Arc<SyncScheduler>,
    lifecycle: &LifecycleHooks,
    bind_policy: Arc<dyn BindPolicy>,
) -> SyncDaemon {
    SyncDaemon::start_with_bind_policy(
        SyncDaemonContext {
            pool: device.pool.clone(),
            device_id: device.id.clone(),
            materializer: Arc::new(device.mat.clone()),
            scheduler: Arc::clone(scheduler),
            endpoint_secret: secret.clone(),
            event_sink: Arc::new(RecordingEventSink::new()),
            cancel: Arc::new(AtomicBool::new(false)),
            lifecycle: lifecycle.clone(),
            internet_relay: false,
        },
        bind_policy,
    )
    .await
    .expect("the daemon starts")
}

async fn bound_now(scheduler: &SyncScheduler) -> Option<LocalEndpointAdvert> {
    scheduler.await_local_endpoint(Duration::ZERO).await
}

fn bound_ip(advert: &LocalEndpointAdvert) -> IpAddr {
    assert_eq!(
        advert.addrs.len(),
        1,
        "one bound socket: {:?}",
        advert.addrs
    );
    advert.addrs[0].ip()
}

/// Fire the daemon's resync tick now, without changing whether it is backgrounded.
async fn tick(lifecycle: &LifecycleHooks) {
    lifecycle.wake.notify_waiters();
    tokio::time::sleep(Duration::from_millis(20)).await;
}

async fn tick_until(lifecycle: &LifecycleHooks, mut done: impl AsyncFnMut() -> bool, label: &str) {
    let deadline = tokio::time::Instant::now() + BRANCH_DISPATCH_DEADLINE;
    while !done().await {
        assert!(tokio::time::Instant::now() < deadline, "timed out: {label}");
        tick(lifecycle).await;
    }
}

async fn stop(daemons: &[&SyncDaemon]) {
    for daemon in daemons {
        daemon.shutdown();
    }
    wait_for(
        || {
            daemons.iter().all(|daemon| {
                daemon
                    .handle
                    .as_ref()
                    .is_none_or(tokio::task::JoinHandle::is_finished)
            })
        },
        BRANCH_SHUTDOWN_DEADLINE,
        "the daemons stopped",
    )
    .await;
}

/// Two paired devices. B, whose daemon runs on the new network and dials nobody,
/// holds an edit A lacks; A knows B's key and address, and is due to pull from it.
struct PairAcrossNetworks {
    a: Device2141,
    b: Device2141,
    secret_a: SecretKey,
    daemon_b: SyncDaemon,
}

async fn pair_across_networks() -> PairAcrossNetworks {
    let space = agaric_store::space::SpaceId::from_trusted(SPACE_6551);
    let (a, b) = converged_pair_6551().await;
    make_local_edit_602(
        &b.pool,
        &b.mat,
        &b.state,
        &b.id,
        &space,
        EDIT_ON_PEER,
        "typed on B",
        1_736_942_500_000,
    )
    .await;
    let (secret_a, secret_b) = (SecretKey::generate(), SecretKey::generate());

    let scheduler_b = Arc::new(SyncScheduler::new());
    let lifecycle_b = LifecycleHooks::new();
    lifecycle_b.mark_backgrounded();
    let daemon_b = start_daemon(
        &b,
        &secret_b,
        &scheduler_b,
        &lifecycle_b,
        MovableBind::at(bind_on(PEER_ON_NEW_NETWORK)),
    )
    .await;
    let advert_b = scheduler_b
        .await_local_endpoint(BRANCH_DISPATCH_DEADLINE)
        .await
        .expect("B's daemon binds its endpoint");

    peer_refs::bind_endpoint_id(&a.pool, &b.id, &secret_b.public().to_string())
        .await
        .unwrap();
    peer_refs::update_last_address(&a.pool, &b.id, &advert_b.addrs[0].to_string())
        .await
        .unwrap();
    peer_refs::bind_endpoint_id(&b.pool, &a.id, &secret_a.public().to_string())
        .await
        .unwrap();
    sqlx::query("UPDATE peer_refs SET synced_at = NULL WHERE peer_id = ?")
        .bind(&b.id)
        .execute(&a.pool)
        .await
        .unwrap();

    PairAcrossNetworks {
        a,
        b,
        secret_a,
        daemon_b,
    }
}

/// A device with one paired peer that is nowhere, bound on the old network.
async fn lone_device() -> (
    Device2141,
    Arc<MovableBind>,
    Arc<SyncScheduler>,
    LifecycleHooks,
) {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let device = Device2141 {
        id: "DEV6526".into(),
        state: Arc::clone(mat.loro_state()),
        pool,
        mat,
        _dir,
    };
    peer_refs::upsert_peer_ref(&device.pool, "DEV6526PEER")
        .await
        .unwrap();
    (
        device,
        MovableBind::at(bind_on(OLD_NETWORK)),
        impatient_scheduler(),
        LifecycleHooks::new(),
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_endpoint_follows_the_bind_decision_and_then_syncs_6526() {
    let PairAcrossNetworks {
        a,
        b,
        secret_a,
        daemon_b,
    } = pair_across_networks().await;
    let bind = MovableBind::at(bind_on(OLD_NETWORK));
    let scheduler = impatient_scheduler();
    let lifecycle = LifecycleHooks::new();
    let daemon_a = start_daemon(&a, &secret_a, &scheduler, &lifecycle, bind.clone()).await;

    let first = scheduler
        .await_local_endpoint(BRANCH_DISPATCH_DEADLINE)
        .await
        .expect("A binds on the old network");
    assert_eq!(bound_ip(&first), IpAddr::V4(OLD_NETWORK));
    tick_until(
        &lifecycle,
        async || scheduler.failure_count(&b.id) > 0,
        "the dial from the old network fails",
    )
    .await;
    assert!(
        !holds_block_6551(&a, EDIT_ON_PEER).await,
        "precondition: B is out of reach from the old network"
    );
    // Deep in backoff, as after a long stay on a network without the peer.
    for _failure in 0..8 {
        scheduler.record_failure(&b.id);
    }

    bind.move_to(bind_on(NEW_NETWORK));
    tick_until(
        &lifecycle,
        async || bound_now(&scheduler).await.is_some_and(|now| now != first),
        "A binds a second endpoint",
    )
    .await;

    let second = bound_now(&scheduler).await.unwrap();
    assert_eq!(bound_ip(&second), IpAddr::V4(NEW_NETWORK));
    assert_eq!(
        second.endpoint_id, first.endpoint_id,
        "the identity peers pinned survives the rebind"
    );
    tick_until(
        &lifecycle,
        async || holds_block_6551(&a, EDIT_ON_PEER).await,
        "a session completes from the new network",
    )
    .await;
    let endpoints = bind.endpoints();
    assert_eq!(endpoints.len(), 2);
    assert!(
        endpoints[0].endpoint().is_closed(),
        "the first endpoint is closed, not left beside the second"
    );
    drop(endpoints);

    stop(&[&daemon_a, &daemon_b]).await;
    a.flush_and_shutdown().await;
    b.flush_and_shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_endpoint_that_stops_is_bound_again_and_then_syncs_6526() {
    let PairAcrossNetworks {
        a,
        b,
        secret_a,
        daemon_b,
    } = pair_across_networks().await;
    let bind = MovableBind::at(bind_on(NEW_NETWORK));
    let scheduler = impatient_scheduler();
    // Backgrounded: no resync tick runs, so only the stopped endpoint can prompt a bind.
    let lifecycle = LifecycleHooks::new();
    lifecycle.mark_backgrounded();
    let daemon_a = start_daemon(&a, &secret_a, &scheduler, &lifecycle, bind.clone()).await;
    scheduler
        .await_local_endpoint(BRANCH_DISPATCH_DEADLINE)
        .await
        .expect("A binds");

    bind.stop_endpoint().await;
    wait_for(
        || bind.endpoints().len() == 2,
        BRANCH_DISPATCH_DEADLINE,
        "A binds a second endpoint",
    )
    .await;

    lifecycle.mark_foreground();
    tick_until(
        &lifecycle,
        async || holds_block_6551(&a, EDIT_ON_PEER).await,
        "a session completes on the second endpoint",
    )
    .await;

    stop(&[&daemon_a, &daemon_b]).await;
    a.flush_and_shutdown().await;
    b.flush_and_shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn endpoints_that_stop_at_once_are_bound_again_at_a_pace_6526() {
    let (device, bind, scheduler, lifecycle) = lone_device().await;
    let daemon = start_daemon(
        &device,
        &SecretKey::generate(),
        &scheduler,
        &lifecycle,
        bind.clone(),
    )
    .await;

    let stopping_each_endpoint = tokio::spawn({
        let bind = Arc::clone(&bind);
        async move {
            loop {
                if let Some(newest) = bind.endpoints().pop() {
                    newest.close().await;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        }
    });
    wait_for(
        || !bind.endpoints().is_empty(),
        BRANCH_DISPATCH_DEADLINE,
        "the daemon binds",
    )
    .await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        bind.endpoints().len(),
        1,
        "a stopped endpoint is not bound again within the pause"
    );
    wait_for(
        || bind.endpoints().len() > 1,
        BRANCH_DISPATCH_DEADLINE,
        "the daemon binds again after the pause",
    )
    .await;

    stopping_each_endpoint.abort();
    stop(&[&daemon]).await;
    device.flush_and_shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_decision_with_no_lan_leaves_a_working_endpoint_bound_6526() {
    let (device, bind, scheduler, lifecycle) = lone_device().await;
    let daemon = start_daemon(
        &device,
        &SecretKey::generate(),
        &scheduler,
        &lifecycle,
        bind.clone(),
    )
    .await;
    scheduler
        .await_local_endpoint(BRANCH_DISPATCH_DEADLINE)
        .await
        .expect("the daemon binds");

    // What `decide` answers while the interface reads as down: the loopback fallback.
    bind.move_to(BindDecision {
        lan_ip: None,
        ..bind_on(Ipv4Addr::LOCALHOST)
    });
    for _tick in 0..25 {
        tick(&lifecycle).await;
    }
    assert!(
        !bind.endpoints()[0].endpoint().is_closed(),
        "a working endpoint is not taken to loopback"
    );
    // The ticks did run: the same daemon follows a decision that names a LAN.
    bind.move_to(bind_on(NEW_NETWORK));
    tick_until(
        &lifecycle,
        async || bind.endpoints().len() == 2,
        "the daemon follows a LAN decision",
    )
    .await;

    stop(&[&daemon]).await;
    device.flush_and_shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_rebind_waits_for_the_session_in_flight_6526() {
    let (device, bind, scheduler, lifecycle) = lone_device().await;
    let daemon = start_daemon(
        &device,
        &SecretKey::generate(),
        &scheduler,
        &lifecycle,
        bind.clone(),
    )
    .await;
    let first = scheduler
        .await_local_endpoint(BRANCH_DISPATCH_DEADLINE)
        .await
        .expect("the daemon binds on the old network");

    // Minimized: the endpoint has to follow the network all the same.
    lifecycle.mark_backgrounded();
    let session_in_flight = scheduler.begin_session_activity();
    bind.move_to(bind_on(NEW_NETWORK));
    for _tick in 0..25 {
        tick(&lifecycle).await;
    }
    assert!(
        !bind.endpoints()[0].endpoint().is_closed(),
        "the endpoint a session runs on must stay up"
    );

    drop(session_in_flight);
    tick_until(
        &lifecycle,
        async || bound_now(&scheduler).await.is_some_and(|now| now != first),
        "the rebind follows the session's end",
    )
    .await;
    assert_eq!(
        bound_ip(&bound_now(&scheduler).await.unwrap()),
        IpAddr::V4(NEW_NETWORK)
    );

    stop(&[&daemon]).await;
    device.flush_and_shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_failed_first_bind_is_retried_and_then_serves_a_session_6526() {
    let PairAcrossNetworks {
        a,
        b,
        secret_a,
        daemon_b,
    } = pair_across_networks().await;
    // A prefix `lan_only` refuses, so the first bring-up fails before any socket.
    let bind = MovableBind::at(BindDecision {
        prefix_len: 0,
        ..bind_on(NEW_NETWORK)
    });
    let scheduler = impatient_scheduler();
    let lifecycle = LifecycleHooks::new();
    let daemon_a = start_daemon(&a, &secret_a, &scheduler, &lifecycle, bind.clone()).await;
    assert_eq!(
        scheduler
            .await_local_endpoint(Duration::from_millis(300))
            .await,
        None,
        "precondition: the first bring-up bound nothing"
    );

    bind.move_to(bind_on(NEW_NETWORK));
    let bound = scheduler
        .await_local_endpoint(BRANCH_DISPATCH_DEADLINE)
        .await
        .expect("the bring-up is retried once it can succeed");
    assert_eq!(bound_ip(&bound), IpAddr::V4(NEW_NETWORK));
    tick_until(
        &lifecycle,
        async || holds_block_6551(&a, EDIT_ON_PEER).await,
        "a session completes on the retried endpoint",
    )
    .await;

    stop(&[&daemon_a, &daemon_b]).await;
    a.flush_and_shutdown().await;
    b.flush_and_shutdown().await;
}

/// A launch: a daemon started on `device`, its bound address read, then stopped.
async fn launch_and_stop(device: &Device2141, secret: &SecretKey) -> SocketAddr {
    let scheduler = impatient_scheduler();
    let daemon = start_daemon(
        device,
        secret,
        &scheduler,
        &LifecycleHooks::new(),
        MovableBind::at(bind_on(OLD_NETWORK)),
    )
    .await;
    let bound = scheduler
        .await_local_endpoint(BRANCH_DISPATCH_DEADLINE)
        .await
        .expect("the daemon binds");
    stop(&[&daemon]).await;
    bound.addrs[0]
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_next_launch_binds_the_port_the_last_one_bound_6526() {
    let (device, ..) = lone_device().await;
    let secret = SecretKey::generate();

    let first = launch_and_stop(&device, &secret).await;
    assert_eq!(
        peer_refs::get_sync_port(&device.pool).await.unwrap(),
        Some(first.port())
    );
    let second = launch_and_stop(&device, &secret).await;
    assert_eq!(second, first);

    device.flush_and_shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_taken_port_falls_back_and_the_new_one_is_kept_6526() {
    let (device, ..) = lone_device().await;
    let secret = SecretKey::generate();
    let first = launch_and_stop(&device, &secret).await;

    let taken = std::net::UdpSocket::bind(first).expect("the test takes the kept port");
    let second = launch_and_stop(&device, &secret).await;
    assert_eq!(second.ip(), first.ip());
    assert_ne!(second.port(), first.port());
    assert_eq!(
        peer_refs::get_sync_port(&device.pool).await.unwrap(),
        Some(second.port())
    );
    drop(taken);

    device.flush_and_shutdown().await;
}
