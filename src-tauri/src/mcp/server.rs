//! MCP server lifecycle and accept-loop driver.
//!
//! As of MAINT-111 M3 the per-connection JSON-RPC framing and
//! `tools/call` dispatch live in [`super::rmcp_adapter::RmcpAdapter`]
//! (the rmcp adapter). This module owns the bits that the rmcp adapter
//! does not touch:
//!
//! - [`serve`] / [`serve_unix`] / [`serve_pipe`] — accept-loop with the
//!   H-2 enable/disable gate and the FEAT-4e disconnect signal.
//! - [`run_connection`] — per-connection lifecycle wrapper around the
//!   rmcp adapter, threading [`super::McpLifecycle`]'s connection
//!   counter and the L-113 disconnect grace period.
//! - [`handle_connection`] — the thin rmcp-adapter entry point that
//!   `run_connection` drives.
//!
//! Framing: handled by rmcp's `serve` (line-delimited JSON-RPC over
//! the Unix-domain socket / Windows named pipe).

use tokio::io::{AsyncRead, AsyncWrite};

use super::{ConnectionCounterGuard, McpLifecycle, McpSurface, SocketKind};
use crate::error::AppError;

// Re-export the registry types so external callers (tests, mod.rs's
// `spawn_mcp_ro_task` default path) that still refer to
// `server::ToolRegistry` / `server::PlaceholderRegistry` keep compiling
// after FEAT-4b moved the real trait into the `registry` submodule.
pub use super::registry::{PlaceholderRegistry, ToolDescription, ToolRegistry};

// ---------------------------------------------------------------------------
// Protocol constants
// ---------------------------------------------------------------------------

/// Application-level "not found" code, used by [`super::rmcp_adapter::app_error_to_rmcp`].
/// Distinct from JSON-RPC's `-32601 Method not found` — this code signals
/// "the *resource* named by the call arguments was not found" (unknown
/// tool name under `tools/call`, unknown block id inside a tool handler,
/// etc.). Picked from the JSON-RPC 2.0 "server-defined" error range
/// (−32000..=−32099) per the FEAT-4c decision. Agents that want to
/// surface a separate UX for "you asked for something that does not
/// exist" versus "you called an undefined method" rely on this split.
pub const JSONRPC_RESOURCE_NOT_FOUND: i64 = -32001;

/// Maximum length (in Unicode scalars / `char`s) of the clipped error
/// message stored in [`super::activity::ActivityResult::Err`] when a
/// `tools/call` dispatch fails. Keeps the activity feed entries short
/// while preserving enough context for "block not found" / "validation
/// failed: …" style diagnostics. Char-based clipping (via
/// `chars().take(ERROR_CLIP_CAP)`) always lands on a UTF-8 char
/// boundary so the output is safe to serialise as JSON even when the
/// underlying error message contains multi-byte codepoints.
pub(crate) const ERROR_CLIP_CAP: usize = 200;

/// L-113 grace period: when [`super::McpLifecycle::disconnect_all`]
/// fires while a `tools/call` is mid-dispatch, the per-connection task
/// waits up to this long for the in-flight future to finish before
/// dropping it. Without the grace period the agent received no
/// JSON-RPC reply and no `mcp:activity` event was emitted for the
/// dropped call. The DB-layer cancellation safety story (commits
/// happen before any further `.await`) is preserved either way — this
/// is purely about giving the reply + activity entry a chance to land.
pub(crate) const MCP_DISCONNECT_GRACE_PERIOD: std::time::Duration =
    std::time::Duration::from_secs(2);

/// #636 — maximum back-off for consecutive `accept()` failures.
/// Mirrors the sync daemon's M-53 accept-loop hardening
/// (`sync_net/websocket.rs::ACCEPT_BACKOFF_CAP`, 30 s) — that helper
/// lives in a private module, so the schedule is mirrored here rather
/// than imported.
const ACCEPT_BACKOFF_CAP: std::time::Duration = std::time::Duration::from_secs(30);

/// #636 — back-off duration before the *next* accept attempt after a
/// run of consecutive `accept()` failures.
///
/// Schedule mirrors the sync daemon's M-53 `compute_accept_backoff_duration`:
/// `100ms × 2^(n-1)` capped at [`ACCEPT_BACKOFF_CAP`], where `n` is the
/// 1-based count of consecutive failures; `0` means "no recent
/// failure" and yields zero so a healthy loop never sleeps.
///
/// Rationale: a transient `accept()` error (EMFILE / ENFILE /
/// ECONNABORTED) used to propagate out of the serve loop via `?`,
/// permanently killing the socket until the user toggled the setting
/// off and on. The loop now logs, backs off, and retries; the back-off
/// is CPU protection against a runaway error, never a DoS guard
/// (single-user local socket — see AGENTS.md threat model).
pub(crate) fn compute_accept_backoff_duration(failure_count: u32) -> std::time::Duration {
    if failure_count == 0 {
        return std::time::Duration::ZERO;
    }
    // Cap the exponent so a runaway counter cannot overflow the shift;
    // the 30 s ceiling is the real limit anyway.
    let exponent = failure_count.saturating_sub(1).min(32);
    let factor: u64 = 1u64.checked_shl(exponent).unwrap_or(u64::MAX);
    let millis: u64 = 100u64.saturating_mul(factor);
    std::time::Duration::from_millis(millis).min(ACCEPT_BACKOFF_CAP)
}

// ---------------------------------------------------------------------------
// Per-connection loop
// ---------------------------------------------------------------------------

/// Drive a single MCP connection to completion via the `rmcp` adapter.
///
/// `activity_ctx` is the FEAT-4d activity-emission seam. Pass `None`
/// when no activity tracking is desired (stub binary, tests); pass
/// `Some(ActivityContext::from_app_handle(...))` in production. When
/// `Some`, successful tool dispatches will emit `mcp:activity` events
/// via the bundled emitter.
pub async fn handle_connection<S, R>(
    stream: S,
    registry: std::sync::Arc<R>,
    activity_ctx: Option<super::activity::ActivityContext>,
    surface: McpSurface,
) -> Result<(), AppError>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
    R: ToolRegistry,
{
    use rmcp::service::ServiceExt;

    // #693 — the surface drives what `get_info` advertises so the RW
    // socket no longer introduces itself as the read-only server.
    let adapter = super::rmcp_adapter::RmcpAdapter::new(registry, activity_ctx, surface);
    let server = adapter
        .serve(stream)
        .await
        .map_err(|e| AppError::Validation(format!("rmcp serve handshake: {e}")))?;
    server
        .waiting()
        .await
        .map_err(|e| AppError::Validation(format!("rmcp serve loop: {e}")))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Accept loop
// ---------------------------------------------------------------------------

/// Accept connections on `socket` and spawn a per-connection task for each,
/// driving them through [`handle_connection`]. Runs until the underlying
/// listener errors or the task is aborted by the caller.
///
/// `activity_ctx` is threaded into each spawned connection task so tool
/// dispatches can emit activity events. Pass `None` in contexts that do
/// not care about activity (stub binary, tests); pass
/// `Some(ActivityContext::from_app_handle(...))` in production.
///
/// `lifecycle` is the FEAT-4e shared state. When `Some`, each per-
/// connection task bumps `active_connections` on entry (decrementing on
/// drop via [`ConnectionCounterGuard`]) and `select!`s on
/// `disconnect_signal.notified()` so the `mcp_disconnect_all` command
/// can kick every in-flight client at once. The accept loop itself
/// also consults `lifecycle.enabled` on every iteration and races
/// `accept().await` against `disconnect_signal.notified()` so a
/// `mcp_set_enabled(false)` (H-2) wakes the loop, observes the cleared
/// gate, and returns — releasing the listener so the OS port / socket
/// file is freed and a subsequent re-enable can re-bind cleanly.
pub async fn serve<R>(
    socket: SocketKind,
    registry: std::sync::Arc<R>,
    activity_ctx: Option<super::activity::ActivityContext>,
    lifecycle: Option<McpLifecycle>,
    surface: McpSurface,
) -> Result<(), AppError>
where
    R: ToolRegistry + Send + Sync + 'static,
{
    match socket {
        #[cfg(unix)]
        SocketKind::Unix(listener) => {
            serve_unix(listener, registry, activity_ctx, lifecycle, surface).await
        }
        #[cfg(windows)]
        SocketKind::Pipe { server, path } => {
            serve_pipe(server, path, registry, activity_ctx, lifecycle, surface).await
        }
    }
}

/// H-2: returns `true` when the lifecycle gate is closed and the accept
/// loop should drop its listener and exit. `None` lifecycle (test /
/// headless callers) is treated as "always enabled" so the loop runs
/// until it is `abort()`ed.
fn lifecycle_disabled(lifecycle: Option<&McpLifecycle>) -> bool {
    lifecycle.is_some_and(|lc| !lc.is_enabled())
}

#[cfg(unix)]
async fn serve_unix<R>(
    listener: tokio::net::UnixListener,
    registry: std::sync::Arc<R>,
    activity_ctx: Option<super::activity::ActivityContext>,
    lifecycle: Option<McpLifecycle>,
    surface: McpSurface,
) -> Result<(), AppError>
where
    R: ToolRegistry + Send + Sync + 'static,
{
    // #636 — consecutive accept-failure counter driving the M-53-style
    // exponential back-off. Reset to zero by every successful accept.
    let mut accept_failure_count: u32 = 0;

    loop {
        // H-2: per-iteration gate. A `mcp_set_enabled(false)` clears
        // `enabled` and notifies, so we either short-circuit here on
        // the next pass or wake from the `select!` below and re-check
        // on the wrapped iteration. Either way we return cleanly and
        // the listener is dropped, freeing the socket file.
        if lifecycle_disabled(lifecycle.as_ref()) {
            tracing::info!(
                target: "mcp",
                kind = surface.label(),
                "MCP accept loop exiting (lifecycle.enabled cleared)",
            );
            return Ok(());
        }

        // Race `accept()` against the disconnect signal so a shutdown
        // pulls us out of the kernel `accept(2)` syscall instead of
        // waiting for the next client. The signal also fires for
        // plain `mcp_disconnect_all` calls; in that case the gate is
        // still open and we just loop back to a fresh `accept()`.
        let outcome: Option<std::io::Result<(tokio::net::UnixStream, _)>> = match lifecycle.as_ref()
        {
            Some(lc) => {
                let notify = lc.disconnect_signal.clone();
                tokio::select! {
                    res = listener.accept() => Some(res),
                    () = async move { notify.notified().await } => None,
                }
            }
            None => Some(listener.accept().await),
        };

        let (stream, _addr) = match outcome {
            Some(Ok(accepted)) => {
                accept_failure_count = 0;
                accepted
            }
            Some(Err(e)) => {
                // #636 — a transient accept error (EMFILE / ENFILE /
                // ECONNABORTED) must NOT kill the serve loop: the old
                // `res?` propagated it out, leaving the socket dead
                // until the user toggled the setting off and on. Log,
                // back off (M-53 schedule), and retry. The sleep races
                // the disconnect signal so a disable during back-off
                // still tears the loop down promptly via the gate
                // re-check at the top.
                accept_failure_count = accept_failure_count.saturating_add(1);
                let backoff = compute_accept_backoff_duration(accept_failure_count);
                tracing::warn!(
                    target: "mcp",
                    kind = surface.label(),
                    error = %e,
                    failure_count = accept_failure_count,
                    backoff_ms = u64::try_from(backoff.as_millis()).unwrap_or(u64::MAX),
                    "MCP accept() failed; backing off and retrying",
                );
                match lifecycle.as_ref() {
                    Some(lc) => {
                        let notify = lc.disconnect_signal.clone();
                        tokio::select! {
                            () = tokio::time::sleep(backoff) => {}
                            () = async move { notify.notified().await } => {}
                        }
                    }
                    None => tokio::time::sleep(backoff).await,
                }
                continue;
            }
            None => continue,
        };

        // H-2: re-check the gate before spawning a handler. If the
        // disconnect signal raced an in-flight `accept()` and won the
        // syscall but the user actually disabled the surface, drop the
        // freshly-accepted stream rather than leaking a connection
        // through the gate.
        if lifecycle_disabled(lifecycle.as_ref()) {
            drop(stream);
            tracing::info!(
                target: "mcp",
                kind = surface.label(),
                "MCP accept loop exiting after racing accept (lifecycle.enabled cleared)",
            );
            return Ok(());
        }

        let registry = registry.clone();
        let activity_ctx = activity_ctx.clone();
        let lifecycle = lifecycle.clone();
        tokio::spawn(async move {
            run_connection(stream, registry, activity_ctx, lifecycle, surface).await;
        });
    }
}

#[cfg(windows)]
async fn serve_pipe<R>(
    mut server: tokio::net::windows::named_pipe::NamedPipeServer,
    pipe_path: String,
    registry: std::sync::Arc<R>,
    activity_ctx: Option<super::activity::ActivityContext>,
    lifecycle: Option<McpLifecycle>,
    surface: McpSurface,
) -> Result<(), AppError>
where
    R: ToolRegistry + Send + Sync + 'static,
{
    use tokio::net::windows::named_pipe::ServerOptions;

    // M-83: the pipe path is threaded through from the bound listener
    // (captured on the `SocketKind::Pipe` variant) rather than being
    // recovered from `super::MCP_RO_PIPE_PATH`. The previous version
    // hard-coded the RO constant here, which silently routed RW
    // callers onto the RO pipe namespace once the first RW client
    // connected and the loop spun up the second server instance.
    let pipe_path = pipe_path.as_str();

    // #636 — consecutive connect-failure counter; see `serve_unix`.
    let mut accept_failure_count: u32 = 0;

    loop {
        // H-2: per-iteration gate. See `serve_unix` for the rationale.
        if lifecycle_disabled(lifecycle.as_ref()) {
            tracing::info!(
                target: "mcp",
                kind = surface.label(),
                "MCP accept loop exiting (lifecycle.enabled cleared)",
            );
            return Ok(());
        }

        let outcome: Option<std::io::Result<()>> = match lifecycle.as_ref() {
            Some(lc) => {
                let notify = lc.disconnect_signal.clone();
                tokio::select! {
                    res = server.connect() => Some(res),
                    () = async move { notify.notified().await } => None,
                }
            }
            None => Some(server.connect().await),
        };

        match outcome {
            Some(Ok(())) => {
                accept_failure_count = 0;
            }
            Some(Err(e)) => {
                // #636 — same hardening as `serve_unix`: a transient
                // `connect()` error must not kill the loop. Log, back
                // off, retry against the same pipe instance (the
                // instance stays listenable; if it is permanently
                // broken the capped back-off keeps the retry loop
                // cheap until the user toggles the surface).
                accept_failure_count = accept_failure_count.saturating_add(1);
                let backoff = compute_accept_backoff_duration(accept_failure_count);
                tracing::warn!(
                    target: "mcp",
                    kind = surface.label(),
                    error = %e,
                    failure_count = accept_failure_count,
                    backoff_ms = u64::try_from(backoff.as_millis()).unwrap_or(u64::MAX),
                    "MCP pipe connect() failed; backing off and retrying",
                );
                match lifecycle.as_ref() {
                    Some(lc) => {
                        let notify = lc.disconnect_signal.clone();
                        tokio::select! {
                            () = tokio::time::sleep(backoff) => {}
                            () = async move { notify.notified().await } => {}
                        }
                    }
                    None => tokio::time::sleep(backoff).await,
                }
                continue;
            }
            None => continue,
        }

        // H-2: re-check the gate before handing the freshly-connected
        // pipe instance to a handler.
        if lifecycle_disabled(lifecycle.as_ref()) {
            tracing::info!(
                target: "mcp",
                kind = surface.label(),
                "MCP accept loop exiting after racing connect (lifecycle.enabled cleared)",
            );
            return Ok(());
        }

        let connected = server;
        // Prepare the next server instance before handing off the current
        // connection. Without this, the second client would fail to connect.
        //
        // I-MCP-2: explicitly pass `first_pipe_instance(false)` even though
        // it is the `ServerOptions::default` value. The initial bind in
        // `bind_pipe` (`mcp/mod.rs`) uses `first_pipe_instance(true)` as
        // the per-process lock that detects double-launches; subsequent
        // `.create` calls here inherit that namespace ownership and must
        // NOT re-claim it (re-claiming would either fail spuriously or,
        // worse, race another instance into accepting a connection meant
        // for us). Being explicit makes the namespace-ownership contract
        // visible at the call site so a future maintainer doesn't flip
        // the flag without understanding it.
        server = ServerOptions::new()
            .first_pipe_instance(false)
            .create(pipe_path)?;

        let registry = registry.clone();
        let activity_ctx = activity_ctx.clone();
        let lifecycle = lifecycle.clone();
        tokio::spawn(async move {
            run_connection(connected, registry, activity_ctx, lifecycle, surface).await;
        });
    }
}

/// Wrap [`handle_connection`] with the FEAT-4e lifecycle bookkeeping:
/// increment / decrement the shared connection counter via an RAII guard
/// and `select!` on `disconnect_signal.notified()` so a `mcp_disconnect_all`
/// call exits the handler promptly. When `lifecycle` is `None` this is a
/// straight passthrough.
async fn run_connection<S, R>(
    stream: S,
    registry: std::sync::Arc<R>,
    activity_ctx: Option<super::activity::ActivityContext>,
    lifecycle: Option<McpLifecycle>,
    surface: McpSurface,
) where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    R: ToolRegistry,
{
    // Bind the RAII counter guard to the task lifetime so panics (or the
    // disconnect-signal branch below) still decrement the counter.
    let _guard = lifecycle
        .as_ref()
        .map(|lc| ConnectionCounterGuard::new(lc.active_connections.clone()));

    let fut = handle_connection(stream, registry, activity_ctx, surface);

    let result = match lifecycle.as_ref() {
        Some(lc) => {
            let notify = lc.disconnect_signal.clone();
            // Pin the connection future so it can be polled in the
            // initial `select!` and then re-polled inside the disconnect
            // arm's bounded grace-period `timeout`.
            tokio::pin!(fut);
            tokio::select! {
                r = &mut fut => r,
                () = async move { notify.notified().await } => {
                    // L-113: do not drop the in-flight future
                    // immediately. Give the current `tools/call` a
                    // bounded chance to return its JSON-RPC reply and
                    // emit its `mcp:activity` entry before the stream
                    // is torn down. The DB layer commits before any
                    // further `.await`, so cancellation safety is
                    // preserved either way — this only affects whether
                    // the agent sees the reply.
                    tracing::info!(
                        target: "mcp",
                        grace_secs = MCP_DISCONNECT_GRACE_PERIOD.as_secs(),
                        "MCP disconnect signal fired; granting grace period for in-flight tool call to complete",
                    );
                    match tokio::time::timeout(MCP_DISCONNECT_GRACE_PERIOD, fut).await {
                        Ok(res) => res,
                        Err(_elapsed) => {
                            tracing::warn!(
                                target: "mcp",
                                grace_secs = MCP_DISCONNECT_GRACE_PERIOD.as_secs(),
                                "MCP in-flight tool call did not complete within grace period; dropping",
                            );
                            Ok(())
                        }
                    }
                }
            }
        }
        None => fut.await,
    };

    if let Err(e) = result {
        tracing::warn!(
            target: "mcp",
            kind = surface.label(),
            error = %e,
            "MCP connection ended with error",
        );
    }
}

// ---------------------------------------------------------------------------
// #636 — accept-loop back-off tests (mirrors sync_net M-53 coverage)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests_backoff {
    use super::compute_accept_backoff_duration;
    use std::time::Duration;

    #[test]
    fn accept_backoff_is_zero_after_successful_accept() {
        assert_eq!(compute_accept_backoff_duration(0), Duration::ZERO);
    }

    #[test]
    fn accept_backoff_doubles_each_step_until_cap() {
        assert_eq!(
            compute_accept_backoff_duration(1),
            Duration::from_millis(100)
        );
        assert_eq!(
            compute_accept_backoff_duration(2),
            Duration::from_millis(200)
        );
        assert_eq!(
            compute_accept_backoff_duration(3),
            Duration::from_millis(400)
        );
        assert_eq!(
            compute_accept_backoff_duration(5),
            Duration::from_millis(1600)
        );
    }

    #[test]
    fn accept_backoff_caps_at_thirty_seconds_and_survives_runaway_counter() {
        assert_eq!(compute_accept_backoff_duration(10), Duration::from_secs(30));
        // A runaway counter must not overflow the shift.
        assert_eq!(
            compute_accept_backoff_duration(u32::MAX),
            Duration::from_secs(30)
        );
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests;

#[cfg(test)]
mod tests_rmcp;

// ---------------------------------------------------------------------------
// M-83 regression tests
// ---------------------------------------------------------------------------
//
// `serve_pipe` previously hard-coded the successor pipe path to
// `super::MCP_RO_PIPE_PATH`, which silently re-bound the RW server's
// successor named-pipe instances onto the RO namespace once the first
// RW client connected. The fix threads the bound pipe path through the
// `SocketKind::Pipe { server, path }` variant so the type system makes
// the correct path available to the accept loop.
//
// Linux / macOS see no behaviour change — Windows named pipes are the
// only platform that recreates per-instance servers, so the tests here
// are gated `#[cfg(windows)]`. On Linux/macOS the M-83 module compiles
// to nothing; the existing `serve_unix` path is unaffected.
#[cfg(test)]
mod tests_m83 {
    // Compile-time signature checks. These run on every platform and
    // catch the case where a future refactor drops the threaded path
    // and reintroduces the constant fallback.
    //
    // The `SocketKind::Pipe` variant must carry both a `server` and a
    // `path: String` field — verified at compile time on Windows by
    // the destructuring patterns in `tests_m83_windows::*` below. On
    // unix this module collapses to the sanity checks that the public
    // surface still builds.

    #[cfg(windows)]
    mod tests_m83_windows {
        use crate::mcp::server::{PlaceholderRegistry, serve};
        use crate::mcp::{MCP_RO_PIPE_PATH, MCP_RW_PIPE_PATH, McpLifecycle, SocketKind};
        use std::sync::Arc;
        use tokio::net::windows::named_pipe::{ClientOptions, ServerOptions};

        /// Pick a pipe name that is guaranteed to differ from both
        /// `MCP_RO_PIPE_PATH` and `MCP_RW_PIPE_PATH`. Includes the
        /// current process id and a random ULID so concurrent test
        /// runs do not collide.
        fn unique_pipe_path(tag: &str) -> String {
            format!(
                r"\\.\pipe\agaric-mcp-m83-{tag}-{pid}-{ulid}",
                tag = tag,
                pid = std::process::id(),
                ulid = ulid::Ulid::new(),
            )
        }

        /// M-83 acceptance test. Bind a `NamedPipeServer` on a custom
        /// path that differs from both the RO and RW constants, hand
        /// the listener to `serve()` via `SocketKind::Pipe { server,
        /// path }`, and verify that after the first client connects
        /// (and the accept loop creates the next server instance) a
        /// SECOND client can connect to the SAME custom path. Pre-fix
        /// the second connect would either fail (custom path differs
        /// from `MCP_RO_PIPE_PATH`) or — worse — succeed against the
        /// RO pipe namespace and route RW traffic through the RO
        /// listener.
        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn m83_serve_pipe_uses_threaded_path_not_hardcoded_constant() {
            let pipe_path = unique_pipe_path("threaded");

            // Make sure the chosen path is genuinely distinct from
            // both production constants — defends the test against a
            // future tweak to `unique_pipe_path` that accidentally
            // matches one of them.
            assert_ne!(pipe_path.as_str(), MCP_RO_PIPE_PATH);
            assert_ne!(pipe_path.as_str(), MCP_RW_PIPE_PATH);

            let server = ServerOptions::new()
                .first_pipe_instance(true)
                .create(&pipe_path)
                .expect("first server instance binds on the custom path");

            let socket = SocketKind::Pipe {
                server,
                path: pipe_path.clone(),
            };

            let registry = Arc::new(PlaceholderRegistry);
            let lifecycle = McpLifecycle::new();
            let serve_lc = lifecycle.clone();
            let serve_task = tokio::spawn(async move {
                serve(
                    socket,
                    registry,
                    None,
                    Some(serve_lc),
                    crate::mcp::McpSurface::ReadWrite,
                )
                .await
            });

            // First client: connect on the custom path. The accept
            // loop hands the connection off to a per-connection task
            // and then creates the next server instance via
            // `ServerOptions::new().create(pipe_path)` — this is the
            // line M-83 fixes.
            let _client_1 = ClientOptions::new()
                .open(pipe_path.as_str())
                .expect("first client connects to the custom-path pipe");

            // Second client: connect AGAIN on the custom path. This
            // would fail pre-fix because the accept loop re-created
            // the second server instance on `MCP_RO_PIPE_PATH`
            // instead of the bound custom path, so no server exists
            // on `pipe_path` to honour the connect.
            //
            // Named-pipe handoff is not synchronous — give the accept
            // loop a moment to recreate the next server instance
            // before retrying. A bounded retry keeps the test fast
            // when the loop is healthy and surfaces a clear failure
            // when it is not.
            let mut second = None;
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
            while tokio::time::Instant::now() < deadline {
                match ClientOptions::new().open(pipe_path.as_str()) {
                    Ok(c) => {
                        second = Some(c);
                        break;
                    }
                    Err(_) => {
                        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                    }
                }
            }
            assert!(
                second.is_some(),
                "second client must connect to the SAME custom pipe path the server was bound on (M-83)",
            );

            // Tear down cleanly so the test process does not leak the
            // accept loop / pipe handles.
            lifecycle.shutdown();
            drop(second);
            // `serve()` returns once the gate fires.
            let _ = tokio::time::timeout(std::time::Duration::from_secs(2), serve_task).await;
        }

        /// Lightweight signature / shape check that does not exercise
        /// the named-pipe runtime — guards against a future refactor
        /// that drops the `path` field from the `SocketKind::Pipe`
        /// variant without anyone noticing because the heavy
        /// integration test above happens to still compile.
        #[test]
        fn m83_socket_kind_pipe_carries_threaded_path() {
            let path = r"\\.\pipe\agaric-mcp-m83-shape-check";
            let server = ServerOptions::new()
                .first_pipe_instance(true)
                .create(path)
                .expect("bind shape-check pipe");
            let kind = SocketKind::Pipe {
                server,
                path: path.to_string(),
            };
            // Match must destructure both fields; if `path` is dropped
            // from the variant this stops compiling.
            match kind {
                SocketKind::Pipe { server: _, path: p } => {
                    assert_eq!(p, path, "captured path round-trips through the variant");
                }
            }
        }
    }
}
