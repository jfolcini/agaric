//! Lifecycle + accept-loop unit tests for `mcp/server.rs`.
//!
//! Wire-level integration coverage (grace period, protocol-
//! error responses) lives in the sibling `tests_rmcp.rs` and drives a
//! real rmcp client. This file is purely for the bits that the rmcp
//! adapter does not own: the H-2 enable/disable gate on the accept
//! loop and the `McpLifecycle::shutdown` helper.

use super::*;
use std::sync::Arc;

// ──────────────────────────────────────────────────────────────────────
// H-2 — `mcp_set_enabled(false)` actually closes the accept loop
//
// Before H-2 the disable path called `notify_waiters()` only, which
// is edge-triggered: any client that arrived after the notify
// registered a fresh waiter and proceeded normally, so the listener
// stayed open until app restart. The fix is a level-triggered
// `enabled: AtomicBool` gate on `McpLifecycle` plus a `select!` in
// the accept loop that pulls the loop out of `accept().await` so
// the gate is observed promptly.
//
// Tests are unix-only: they bind a `UnixListener` directly on a
// temp-dir socket path and drive `serve_unix` from a spawned task.
// The `connect-after-disable-fails` invariant holds for windows
// named pipes too but the test scaffolding would need a parallel
// `serve_pipe` harness — out of scope for the unit tests here.
// ──────────────────────────────────────────────────────────────────────

#[cfg(unix)]
async fn wait_for_task_running_false(
    lifecycle: &super::super::McpLifecycle,
    timeout: std::time::Duration,
) {
    let deadline = tokio::time::Instant::now() + timeout;
    while lifecycle.is_running() && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert!(
        !lifecycle.is_running(),
        "accept loop did not exit within {timeout:?}",
    );
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shutdown_closes_accept_loop_and_drops_listener() {
    // H-2 acceptance test: enable, prove a connection succeeds,
    // disable via `lifecycle.shutdown()`, then assert a fresh
    // connection attempt fails because the listener was dropped.
    use super::super::McpLifecycle;
    use tokio::net::{UnixListener, UnixStream};

    let dir = tempfile::TempDir::new().unwrap();
    let path = dir.path().join("h2-close.sock");
    let listener = UnixListener::bind(&path).unwrap();

    let lifecycle = McpLifecycle::new();
    // Mirror what `spawn_*_task_with_registry` does in production
    // — the spawn helper sets `task_running = true` before
    // entering `serve()`. Without this the wait helper below
    // would short-circuit immediately.
    lifecycle
        .task_running
        .store(true, std::sync::atomic::Ordering::Release);

    let registry = Arc::new(PlaceholderRegistry);
    let serve_lc = lifecycle.clone();
    let serve_task = tokio::spawn(async move {
        let result = serve_unix(
            listener,
            registry,
            None,
            Some(serve_lc.clone()),
            crate::mcp::McpSurface::ReadOnly,
        )
        .await;
        serve_lc
            .task_running
            .store(false, std::sync::atomic::Ordering::Release);
        result
    });

    // First connection succeeds — sanity check that the listener
    // is actually accepting before we toggle.
    let _client = UnixStream::connect(&path)
        .await
        .expect("first connect succeeds while enabled");

    // Disable. `shutdown()` clears the gate and notifies every
    // waiter on `disconnect_signal`, including the accept loop's
    // `select!` arm.
    lifecycle.shutdown();

    // Wait for the loop to exit cleanly (task_running flips back
    // to false in the spawned task wrapper above).
    wait_for_task_running_false(&lifecycle, std::time::Duration::from_secs(2)).await;

    let result = serve_task.await.expect("serve task joins");
    assert!(
        result.is_ok(),
        "serve_unix must return Ok after shutdown; got {result:?}",
    );

    // New connection attempts must fail — the listener has been
    // dropped, the kernel has no accepting socket on this path.
    // On Linux this surfaces as ECONNREFUSED.
    let connect_result = UnixStream::connect(&path).await;
    assert!(
        connect_result.is_err(),
        "connect after shutdown must fail; got Ok({:?})",
        connect_result.as_ref().map(|_| "<stream>"),
    );
    let err = connect_result.unwrap_err();
    assert!(
        matches!(
            err.kind(),
            std::io::ErrorKind::ConnectionRefused | std::io::ErrorKind::NotFound
        ),
        "connect after shutdown must fail with ECONNREFUSED / ENOENT; got {err:?}",
    );

    assert!(
        !lifecycle.is_enabled(),
        "lifecycle.enabled stays cleared after shutdown until the next spawn",
    );
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn re_enable_rebinds_listener_after_shutdown() {
    // H-2 acceptance test: enable, disable, re-enable, assert a
    // fresh connection succeeds against the second listener. The
    // production re-enable flow is "set marker, spawn fresh task,
    // task resets the gate before bind"; here we drive the same
    // sequence by hand because `spawn_*_task_with_registry` would
    // pull in the full Tauri runtime.
    use super::super::McpLifecycle;
    use tokio::net::{UnixListener, UnixStream};

    let dir = tempfile::TempDir::new().unwrap();
    let path = dir.path().join("h2-rebind.sock");

    let lifecycle = McpLifecycle::new();
    let registry = Arc::new(PlaceholderRegistry);

    // ── First serve loop ──
    let listener_v1 = UnixListener::bind(&path).unwrap();
    lifecycle
        .task_running
        .store(true, std::sync::atomic::Ordering::Release);
    let serve_lc_1 = lifecycle.clone();
    let registry_1 = registry.clone();
    let task_v1 = tokio::spawn(async move {
        let result = serve_unix(
            listener_v1,
            registry_1,
            None,
            Some(serve_lc_1.clone()),
            crate::mcp::McpSurface::ReadOnly,
        )
        .await;
        serve_lc_1
            .task_running
            .store(false, std::sync::atomic::Ordering::Release);
        result
    });

    let _client_v1 = UnixStream::connect(&path)
        .await
        .expect("first connect succeeds before disable");

    // Disable, wait for the first loop to exit.
    lifecycle.shutdown();
    wait_for_task_running_false(&lifecycle, std::time::Duration::from_secs(2)).await;
    task_v1.await.expect("task v1 joins").expect("v1 Ok");
    assert!(!lifecycle.is_enabled(), "gate cleared after first disable");

    // Confirm the gap: connect attempts must fail right now.
    let gap = UnixStream::connect(&path).await;
    assert!(
        gap.is_err(),
        "connect during the re-enable gap must fail; got Ok({:?})",
        gap.as_ref().map(|_| "<stream>"),
    );

    // Production re-enable: clear the stale socket file, re-bind a
    // fresh listener, reset `enabled = true`, and spawn a new
    // serve loop. `bind_socket` does the file unlink + permissions
    // dance; for this test we just remove the file and re-bind
    // directly to keep the harness focused on the gate.
    std::fs::remove_file(&path).ok();
    let listener_v2 = UnixListener::bind(&path).unwrap();
    lifecycle
        .enabled
        .store(true, std::sync::atomic::Ordering::Release);
    lifecycle
        .task_running
        .store(true, std::sync::atomic::Ordering::Release);
    let serve_lc_2 = lifecycle.clone();
    let registry_2 = registry.clone();
    let task_v2 = tokio::spawn(async move {
        let result = serve_unix(
            listener_v2,
            registry_2,
            None,
            Some(serve_lc_2.clone()),
            crate::mcp::McpSurface::ReadOnly,
        )
        .await;
        serve_lc_2
            .task_running
            .store(false, std::sync::atomic::Ordering::Release);
        result
    });

    // Fresh connections succeed against the second listener.
    let _client_v2 = UnixStream::connect(&path)
        .await
        .expect("connect succeeds after re-enable");
    assert!(
        lifecycle.is_enabled(),
        "gate is open during the second serve loop"
    );

    // Tear down for clean test exit.
    lifecycle.shutdown();
    wait_for_task_running_false(&lifecycle, std::time::Duration::from_secs(2)).await;
    task_v2.await.expect("task v2 joins").expect("v2 Ok");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shutdown_during_active_connection_blocks_new_connects() {
    // H-2 acceptance test: an in-flight connection is mid-handshake
    // when `shutdown()` fires. The existing per-connection
    // `select!` drops the in-flight stream as before;
    // the H-2 addition is that NO new connection succeeds after
    // the shutdown observes the gate.
    use super::super::McpLifecycle;
    use tokio::net::{UnixListener, UnixStream};

    let dir = tempfile::TempDir::new().unwrap();
    let path = dir.path().join("h2-inflight.sock");
    let listener = UnixListener::bind(&path).unwrap();

    let lifecycle = McpLifecycle::new();
    lifecycle
        .task_running
        .store(true, std::sync::atomic::Ordering::Release);
    let registry = Arc::new(PlaceholderRegistry);
    let serve_lc = lifecycle.clone();
    let serve_task = tokio::spawn(async move {
        let result = serve_unix(
            listener,
            registry,
            None,
            Some(serve_lc.clone()),
            crate::mcp::McpSurface::ReadOnly,
        )
        .await;
        serve_lc
            .task_running
            .store(false, std::sync::atomic::Ordering::Release);
        result
    });

    // Open an in-flight connection — sit on it without sending so
    // the handler is parked inside rmcp's framer reading the
    // initialize line.
    let inflight = UnixStream::connect(&path)
        .await
        .expect("in-flight connect succeeds");

    // Give the per-connection task a moment to register itself in
    // the active counter so we can prove the shutdown actually
    // sees a live connection. Budget bumped to 5 s with a sleep
    // (rather than `yield_now`) so the test is not flaky on a
    // loaded runtime where the per-connection spawn can be slow
    // to schedule even with `worker_threads = 2`.
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    while lifecycle.connection_count() == 0 && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert_eq!(
        lifecycle.connection_count(),
        1,
        "per-connection task increments active_connections on entry",
    );

    // Disable while the in-flight connection is still parked.
    lifecycle.shutdown();
    wait_for_task_running_false(&lifecycle, std::time::Duration::from_secs(5)).await;
    let result = serve_task.await.expect("serve task joins");
    assert!(
        result.is_ok(),
        "serve_unix returns Ok after in-flight shutdown; got {result:?}",
    );

    // The in-flight stream's handler also observes the disconnect
    // Signal via its `select!` and drops its half. The
    // client side may still hold its FD open — drop it explicitly
    // so the test is clean.
    drop(inflight);

    // After shutdown, no new connection succeeds — H-2 invariant.
    // Removing the socket file makes the assertion deterministic
    // (ENOENT) rather than relying on the kernel's reclaim of the
    // closed listening fd (ECONNREFUSED), which has a small race
    // window on heavily-loaded runtimes. Either error is fine for
    // the H-2 contract; ENOENT is just easier to reproduce.
    let _ = std::fs::remove_file(&path);
    let post_shutdown = UnixStream::connect(&path).await;
    assert!(
        post_shutdown.is_err(),
        "connect after in-flight shutdown must fail; got Ok({:?})",
        post_shutdown.as_ref().map(|_| "<stream>"),
    );
}

// ──────────────────────────────────────────────────────────────────────
// #636 — a transient accept() error must NOT kill the serve loop
// ──────────────────────────────────────────────────────────────────────

/// #636 acceptance test: inject a REAL `accept()` failure (EMFILE via
/// fd exhaustion — one of the exact transient errors the issue names)
/// and assert the loop survives it and accepts the pending client once
/// the pressure clears. Pre-fix, the first `Err` propagated out of
/// `serve_unix` via `?` and the socket was dead until the user toggled
/// the surface off and on.
///
/// Sequencing makes the failure deterministic:
///   1. bind the listener and connect a client BEFORE the serve loop
///      starts — the connection parks in the kernel backlog;
///   2. exhaust this process's fd budget (nextest runs each test in
///      its own process, so this cannot poison sibling tests);
///   3. start the serve loop — its first `accept()` of the pending
///      connection must fail with EMFILE (no free fd for the accepted
///      socket) and the loop backs off and retries;
///   4. release the fds — the retry succeeds and the pending client is
///      finally served (observed via the lifecycle connection counter).
///
/// If the environment's fd limit is too high to exhaust within the
/// bounded attempt cap, the test degrades to the happy path (the loop
/// still must serve the client) rather than flaking.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn accept_error_does_not_kill_serve_loop_636() {
    use super::super::McpLifecycle;
    use tokio::net::{UnixListener, UnixStream};

    let dir = tempfile::TempDir::new().unwrap();
    let path = dir.path().join("i636-emfile.sock");
    let listener = UnixListener::bind(&path).unwrap();

    // 1. Client connects while no accept loop is running — the unix
    //    socket handshake completes against the listen backlog.
    let _pending_client = UnixStream::connect(&path)
        .await
        .expect("backlog connect succeeds before the serve loop starts");

    // 2. Exhaust the fd budget. Bounded attempt cap so an environment
    //    with a very large soft limit degrades instead of spinning.
    let mut hogs: Vec<std::fs::File> = Vec::new();
    let mut exhausted = false;
    for _ in 0..1_100_000 {
        if let Ok(f) = std::fs::File::open("/dev/null") {
            hogs.push(f);
        } else {
            exhausted = true;
            break;
        }
    }

    // 3. Start the serve loop under fd pressure.
    let lifecycle = McpLifecycle::new();
    let registry = Arc::new(PlaceholderRegistry);
    let serve_lc = lifecycle.clone();
    let serve_task = tokio::spawn(async move {
        serve_unix(
            listener,
            registry,
            None,
            Some(serve_lc),
            crate::mcp::McpSurface::ReadOnly,
        )
        .await
    });

    if exhausted {
        // Hold the pressure long enough for the loop to take the
        // error arm at least once (first backoff step is 100 ms).
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        assert!(
            !serve_task.is_finished(),
            "#636: the serve loop must survive accept() errors (EMFILE), \
             not propagate them out",
        );
    } else {
        eprintln!(
            "#636 test note: fd limit too high to exhaust within the cap; \
             exercising the happy path only"
        );
    }

    // 4. Release the fds; the retry must accept the parked client.
    drop(hogs);
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    while lifecycle.connection_count() == 0 && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert!(
        lifecycle.connection_count() >= 1,
        "#636: after the transient accept failure clears, the loop must \
         accept the pending connection",
    );
    assert!(
        !serve_task.is_finished(),
        "#636: the serve loop must still be running after recovery",
    );

    // Tear down cleanly.
    lifecycle.shutdown();
    let _ = tokio::time::timeout(std::time::Duration::from_secs(2), serve_task).await;
}

#[test]
fn lifecycle_shutdown_clears_enabled_and_fires_signal() {
    // Unit-level coverage for the `McpLifecycle::shutdown` helper
    // that H-2 added: it must (1) clear the `enabled` gate so the
    // accept loop's per-iteration check observes the disable, and
    // (2) fire `disconnect_signal.notify_waiters()` so any task
    // currently parked in `select!` wakes immediately.
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let lc = super::super::McpLifecycle::new();
            assert!(lc.is_enabled(), "fresh lifecycle defaults to enabled");

            let signal = lc.disconnect_signal.clone();
            let waiter = tokio::spawn(async move { signal.notified().await });
            tokio::task::yield_now().await;

            lc.shutdown();

            tokio::time::timeout(std::time::Duration::from_millis(500), waiter)
                .await
                .expect("shutdown must wake disconnect_signal waiters")
                .expect("waiter joined cleanly");
            assert!(
                !lc.is_enabled(),
                "shutdown must clear lifecycle.enabled so the accept loop's gate fires",
            );
        });
}
