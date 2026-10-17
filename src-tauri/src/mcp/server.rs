//! MCP server lifecycle and accept-loop driver.
//!
//! Per-connection JSON-RPC framing and `tools/call` dispatch live in
//! [`super::rmcp_adapter::RmcpAdapter`]. This module owns the bits rmcp does
//! not touch:
//!
//! - [`serve`] / `serve_unix` / `serve_pipe` (the latter is
//!   `#[cfg(windows)]`, so it is absent from a non-Windows doc build) — accept-loop with the
//!   H-2 enable/disable gate and the disconnect signal.
//! - `run_connection` — per-connection lifecycle wrapper threading
//!   [`super::McpLifecycle`]'s connection counter and the disconnect grace
//!   period.
//! - [`handle_connection`] — reads the bridge's token preamble, refuses a
//!   connection without a live agent's token, and serves the rest through
//!   the registry the agent's mode picks.
//!
//! Framing: handled by rmcp's `serve` (line-delimited JSON-RPC over
//! the Unix-domain socket / Windows named pipe).

use std::sync::Arc;

use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};

use super::activity::ActivityContext;
use super::agents::{AgentStore, McpAgentMode};
use super::rmcp_adapter::RmcpAdapter;
use super::{ConnectionCounterGuard, McpLifecycle, SocketKind, TOKEN_PREAMBLE};
use agaric_core::error::AppError;

// Re-export the registry types so external callers (tests, mod.rs's
// spawn path) that refer to `server::ToolRegistry` /
// `server::PlaceholderRegistry` keep compiling.
pub use super::registry::{PlaceholderRegistry, ToolDescription, ToolRegistry};

/// What every connection on the socket shares: the registry for each mode,
/// the agents table, and the activity feed (`None` in tests).
pub struct McpServer<RO, RW> {
    pub read_only: Arc<RO>,
    pub read_write: Arc<RW>,
    pub agents: AgentStore,
    pub activity_ctx: Option<ActivityContext>,
}

// ---------------------------------------------------------------------------
// Protocol constants
// ---------------------------------------------------------------------------

/// Application-level "not found" code, used by the private
/// `super::rmcp_adapter::app_error_to_rmcp` helper.
/// Distinct from JSON-RPC's `-32601 Method not found` — this code signals
/// "the *resource* named by the call arguments was not found" (unknown
/// tool name under `tools/call`, unknown block id inside a tool handler,
/// etc.). Picked from the JSON-RPC 2.0 "server-defined" error range
/// (−32000..=−32099) per the decision. Agents that want to
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

/// Grace period: when [`super::McpLifecycle::disconnect_all`]
/// fires while a `tools/call` is mid-dispatch, the per-connection task
/// waits up to this long for the in-flight future to finish before
/// dropping it. Without the grace period the agent received no
/// JSON-RPC reply and no `mcp:activity` event was emitted for the
/// dropped call. The DB-layer cancellation safety story (commits
/// happen before any further `.await`) is preserved either way — this
/// is purely about giving the reply + activity entry a chance to land.
pub(crate) const MCP_DISCONNECT_GRACE_PERIOD: std::time::Duration =
    std::time::Duration::from_secs(2);

/// The longest line read before MCP traffic starts: the token preamble, or
/// the first request of a connection being refused.
const PREAMBLE_LINE_CAP: u64 = 64 * 1024;

/// The refusal for a connection whose first line is not a token preamble:
/// an `agaric-mcp` from before #5667, or a client that skips the bridge.
pub(crate) const NO_TOKEN_REFUSAL: &str = "this connection sent no agent token. Update \
     agaric-mcp and copy this client's config from Settings → Agent access";

/// The refusal for a token no agent holds.
pub(crate) const UNKNOWN_TOKEN_REFUSAL: &str = "no agent has this token: it was revoked, or \
     made on another device. Copy this client's config from Settings → Agent access";

/// #636 — maximum back-off for consecutive `accept()` failures.
///
/// 30 s is the ceiling because the failure this bounds is the app's own
/// (FD exhaustion, a sysctl limit, address-family weirdness), not a
/// peer's: the loop must keep retrying so the socket recovers on its own
/// once the condition clears, and 30 s is short enough that recovery is
/// unnoticeable to a user who has just closed some file handles, while
/// long enough that a permanently broken listener costs two log lines a
/// minute instead of a spinning core.
///
/// The sync daemon's accept loop carried the identical schedule for the
/// identical reason. That module has been deleted (#3464), so the
/// rationale is stated here rather than cross-referenced.
const ACCEPT_BACKOFF_CAP: std::time::Duration = std::time::Duration::from_secs(30);

/// #636 — back-off duration before the *next* accept attempt after a
/// run of consecutive `accept()` failures.
///
/// Schedule: `100ms × 2^(n-1)` capped at [`ACCEPT_BACKOFF_CAP`], where
/// `n` is the 1-based count of consecutive failures; `0` means "no
/// recent failure" and yields zero so a healthy loop never sleeps. The
/// first step is 100 ms so a single transient error costs no visible
/// latency, and doubling means a genuinely wedged listener reaches the
/// cap in nine failures rather than logging thousands of times.
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

/// Drive a single MCP connection to completion.
///
/// The first line is the bridge's `AGARIC-TOKEN <token>`. A live agent's
/// token picks the registry its mode serves, and the stream, with any bytes
/// read past that line, goes to rmcp. Anything else gets one JSON-RPC error
/// naming Settings → Agent access, in reply to the client's first request,
/// and the connection closes.
pub async fn handle_connection<S, RO, RW>(
    stream: S,
    server: Arc<McpServer<RO, RW>>,
) -> Result<(), AppError>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    RO: ToolRegistry,
    RW: ToolRegistry,
{
    let mut stream = BufReader::new(stream);
    let Some(first_line) = read_capped_line(&mut stream).await? else {
        // Closed before a byte: the bind-time liveness probe, or a client
        // that gave up.
        return Ok(());
    };
    let Some(token) = first_line.strip_prefix(TOKEN_PREAMBLE) else {
        return refuse(stream, NO_TOKEN_REFUSAL, Some(&first_line)).await;
    };
    let Some(agent) = server.agents.connect(token.trim()).await? else {
        let request = read_capped_line(&mut stream).await?;
        return refuse(stream, UNKNOWN_TOKEN_REFUSAL, request.as_deref()).await;
    };
    let activity_ctx = server.activity_ctx.clone();
    match agent.mode {
        McpAgentMode::ReadOnly => {
            serve_agent(
                stream,
                RmcpAdapter::new(server.read_only.clone(), activity_ctx, agent),
            )
            .await
        }
        McpAgentMode::ReadWrite => {
            serve_agent(
                stream,
                RmcpAdapter::new(server.read_write.clone(), activity_ctx, agent),
            )
            .await
        }
    }
}

/// The next line of `stream`, without its line ending, cut at
/// [`PREAMBLE_LINE_CAP`]. `None` at end of stream.
async fn read_capped_line<S>(stream: &mut BufReader<S>) -> Result<Option<String>, AppError>
where
    S: AsyncRead + Unpin,
{
    let mut line = Vec::new();
    (&mut *stream)
        .take(PREAMBLE_LINE_CAP)
        .read_until(b'\n', &mut line)
        .await?;
    if line.is_empty() {
        return Ok(None);
    }
    Ok(Some(
        String::from_utf8_lossy(&line)
            .trim_end_matches(['\r', '\n'])
            .to_owned(),
    ))
}

/// Answer `request`, the client's first JSON-RPC request, with a `-32001`
/// carrying `reason`, then close.
async fn refuse<S>(mut stream: S, reason: &str, request: Option<&str>) -> Result<(), AppError>
where
    S: AsyncWrite + Unpin,
{
    use rmcp::model::{JsonRpcError, RequestId};

    let id = request
        .and_then(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .and_then(|request| request.get("id").cloned())
        .and_then(|id| serde_json::from_value::<RequestId>(id).ok());
    let error = super::rmcp_adapter::app_error_to_rmcp(&AppError::NotFound(reason.to_owned()));
    let mut reply = serde_json::to_vec(&JsonRpcError::new(id, error))?;
    reply.push(b'\n');
    stream.write_all(&reply).await?;
    stream.shutdown().await?;
    tracing::warn!(target: "mcp", reason, "MCP connection refused");
    Ok(())
}

/// Serve `stream` through `adapter` until the client disconnects.
async fn serve_agent<S, R>(stream: S, adapter: RmcpAdapter<R>) -> Result<(), AppError>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    R: ToolRegistry,
{
    use rmcp::service::ServiceExt;

    let server = adapter
        .serve(stream)
        .await
        .map_err(|e| AppError::validation(format!("rmcp serve handshake: {e}")))?;
    server
        .waiting()
        .await
        .map_err(|e| AppError::validation(format!("rmcp serve loop: {e}")))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Accept loop
// ---------------------------------------------------------------------------

/// Accept connections on `socket` and spawn a per-connection task for each,
/// driving them through [`handle_connection`]. Runs until the underlying
/// listener errors or the task is aborted by the caller.
///
/// `server` is shared by every connection: its registries, agents table
/// and activity feed.
///
/// `lifecycle` is the shared state. When `Some`, each per-
/// connection task bumps `active_connections` on entry (decrementing on
/// drop via [`ConnectionCounterGuard`]) and `select!`s on
/// `disconnect_signal.notified()` so the `mcp_disconnect_all` command
/// can kick every in-flight client at once. The accept loop itself
/// also consults `lifecycle.enabled` on every iteration and races
/// `accept().await` against the level-triggered `shutdown_signal` watch
/// channel (#2824) so a `mcp_set_enabled(false)` (H-2) wakes the loop —
/// even if the disable fired while the loop was mid-FFI — whereupon it
/// observes the cleared gate and returns, releasing the listener so the
/// OS port / socket file is freed and a subsequent re-enable can re-bind
/// cleanly.
pub async fn serve<RO, RW>(
    socket: SocketKind,
    server: Arc<McpServer<RO, RW>>,
    lifecycle: Option<McpLifecycle>,
) -> Result<(), AppError>
where
    RO: ToolRegistry,
    RW: ToolRegistry,
{
    match socket {
        #[cfg(unix)]
        SocketKind::Unix(listener) => serve_unix(listener, server, lifecycle).await,
        #[cfg(windows)]
        SocketKind::Pipe { server: pipe, path } => serve_pipe(pipe, path, server, lifecycle).await,
    }
}

/// H-2: returns `true` when the lifecycle gate is closed and the accept
/// loop should drop its listener and exit. `None` lifecycle (test /
/// headless callers) is treated as "always enabled" so the loop runs
/// until it is `abort()`ed.
fn lifecycle_disabled(lifecycle: Option<&McpLifecycle>) -> bool {
    lifecycle.is_some_and(|lc| !lc.is_enabled())
}

/// #2824 — level-triggered shutdown wake for the accept loops.
///
/// Resolves as soon as [`McpLifecycle::shutdown`] has flipped the
/// `shutdown_signal` `watch` channel to `true`, **including the case
/// where the flip happened before this future was first polled**. That
/// is the whole point: `watch` stores the level, so unlike the
/// edge-triggered `Notify::notify_waiters` used previously, a shutdown
/// that fires while the accept loop is mid-FFI (not parked in this
/// future) is not lost — the first poll observes the stored level and
/// returns immediately. The caller then re-checks [`lifecycle_disabled`]
/// and returns, releasing the listener.
///
/// `rx` is a fresh subscriber, so `borrow_and_update` first reflects the
/// value at subscribe time; if that is already `true` we return without
/// awaiting. `changed()` errors only once the sender is dropped (the
/// lifecycle is gone) — treated as shutdown so the loop still exits.
async fn shutdown_requested(mut rx: tokio::sync::watch::Receiver<bool>) {
    if *rx.borrow_and_update() {
        return;
    }
    while rx.changed().await.is_ok() {
        if *rx.borrow_and_update() {
            return;
        }
    }
}

#[cfg(unix)]
async fn serve_unix<RO, RW>(
    listener: tokio::net::UnixListener,
    server: Arc<McpServer<RO, RW>>,
    lifecycle: Option<McpLifecycle>,
) -> Result<(), AppError>
where
    RO: ToolRegistry,
    RW: ToolRegistry,
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
                // #2824 — race `accept()` against the level-triggered
                // shutdown wake, not the edge-triggered disconnect signal,
                // so a `shutdown` that fired while we were mid-FFI is still
                // observed here and cannot be missed.
                tokio::select! {
                    res = listener.accept() => Some(res),
                    () = shutdown_requested(lc.shutdown_signal.subscribe()) => None,
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
                // Back off (schedule), and retry. The sleep races
                // the disconnect signal so a disable during back-off
                // still tears the loop down promptly via the gate
                // re-check at the top.
                accept_failure_count = accept_failure_count.saturating_add(1);
                let backoff = compute_accept_backoff_duration(accept_failure_count);
                tracing::warn!(
                    target: "mcp",
                        error = %e,
                    failure_count = accept_failure_count,
                    backoff_ms = u64::try_from(backoff.as_millis()).unwrap_or(u64::MAX),
                    "MCP accept() failed; backing off and retrying",
                );
                match lifecycle.as_ref() {
                    Some(lc) => {
                        // #2824 — race the back-off `sleep` against the
                        // level-triggered shutdown wake so a disable during
                        // back-off tears the loop down promptly (the wake
                        // cannot be missed even mid-FFI).
                        tokio::select! {
                            () = tokio::time::sleep(backoff) => {}
                            () = shutdown_requested(lc.shutdown_signal.subscribe()) => {}
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
                "MCP accept loop exiting after racing accept (lifecycle.enabled cleared)",
            );
            return Ok(());
        }

        let server = server.clone();
        let lifecycle = lifecycle.clone();
        tokio::spawn(async move {
            run_connection(stream, server, lifecycle).await;
        });
    }
}

#[cfg(windows)]
async fn serve_pipe<RO, RW>(
    mut pipe: tokio::net::windows::named_pipe::NamedPipeServer,
    pipe_path: String,
    server: Arc<McpServer<RO, RW>>,
    lifecycle: Option<McpLifecycle>,
) -> Result<(), AppError>
where
    RO: ToolRegistry,
    RW: ToolRegistry,
{
    // The pipe path is threaded through from the bound listener
    // (captured on the `SocketKind::Pipe` variant) so each successor
    // instance is created on the namespace that was bound (M-83).
    let pipe_path = pipe_path.as_str();

    // #636 — consecutive connect-failure counter; see `serve_unix`.
    let mut accept_failure_count: u32 = 0;

    loop {
        // H-2: per-iteration gate. See `serve_unix` for the rationale.
        if lifecycle_disabled(lifecycle.as_ref()) {
            tracing::info!(
                target: "mcp",
                "MCP accept loop exiting (lifecycle.enabled cleared)",
            );
            return Ok(());
        }

        let outcome: Option<std::io::Result<()>> = match lifecycle.as_ref() {
            Some(lc) => {
                // #2824 — race `connect()` against the level-triggered
                // shutdown wake (see `serve_unix`).
                tokio::select! {
                    res = pipe.connect() => Some(res),
                    () = shutdown_requested(lc.shutdown_signal.subscribe()) => None,
                }
            }
            None => Some(pipe.connect().await),
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
                        error = %e,
                    failure_count = accept_failure_count,
                    backoff_ms = u64::try_from(backoff.as_millis()).unwrap_or(u64::MAX),
                    "MCP pipe connect() failed; backing off and retrying",
                );
                match lifecycle.as_ref() {
                    Some(lc) => {
                        // #2824 — race the back-off `sleep` against the
                        // level-triggered shutdown wake so a disable during
                        // back-off tears the loop down promptly (the wake
                        // cannot be missed even mid-FFI).
                        tokio::select! {
                            () = tokio::time::sleep(backoff) => {}
                            () = shutdown_requested(lc.shutdown_signal.subscribe()) => {}
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
                "MCP accept loop exiting after racing connect (lifecycle.enabled cleared)",
            );
            return Ok(());
        }

        let connected = pipe;
        // Prepare the next server instance before handing off the current
        // connection. Without this, the second client would fail to connect.
        //
        // #2720: create the successor with the SAME explicit per-user
        // security descriptor as the initial bind (via
        // `create_secured_pipe_instance`) — never fall back to the default
        // (Everyone/Anonymous-readable) named-pipe DACL on the successor
        // path.
        //
        // #2727: retry transient creation failures with the SAME
        // log -> capped-backoff -> retry pattern used for `connect()` above,
        // racing the disconnect signal. The previous code used `?`, so a
        // single transient `CreateNamedPipe` failure propagated out of the
        // loop and permanently killed the surface (the marker still reads
        // "enabled" -> Settings shows the toggle on, yet nothing is
        // listening). Mirrors the #636 hardening applied to `connect()`.
        //
        // I-MCP-2: `first_pipe_instance(false)` — the initial bind in
        // `bind_socket` (`mcp/mod.rs`) claimed namespace ownership with
        // `first_pipe_instance(true)` as the per-process double-launch lock;
        // successors must NOT re-claim it (re-claiming would either fail
        // spuriously or, worse, race another instance into accepting a
        // connection meant for us).
        pipe = loop {
            // H-2: honor a disable that arrived while we were retrying.
            if lifecycle_disabled(lifecycle.as_ref()) {
                tracing::info!(
                    target: "mcp",
                        "MCP accept loop exiting during successor-instance creation (lifecycle.enabled cleared)",
                );
                return Ok(());
            }

            match super::win_security::create_secured_pipe_instance(pipe_path, false) {
                Ok(next) => {
                    accept_failure_count = 0;
                    break next;
                }
                Err(e) => {
                    accept_failure_count = accept_failure_count.saturating_add(1);
                    let backoff = compute_accept_backoff_duration(accept_failure_count);
                    tracing::warn!(
                        target: "mcp",
                                error = %e,
                        failure_count = accept_failure_count,
                        backoff_ms = u64::try_from(backoff.as_millis()).unwrap_or(u64::MAX),
                        "MCP successor pipe create() failed; backing off and retrying",
                    );
                    match lifecycle.as_ref() {
                        Some(lc) => {
                            // #2824 — race the back-off `sleep` against the
                            // level-triggered shutdown wake so a disable during
                            // successor-pipe back-off tears the loop down
                            // promptly (the wake cannot be missed even mid-FFI,
                            // unlike the edge-triggered `disconnect_signal`).
                            tokio::select! {
                                () = tokio::time::sleep(backoff) => {}
                                () = shutdown_requested(lc.shutdown_signal.subscribe()) => {}
                            }
                        }
                        None => tokio::time::sleep(backoff).await,
                    }
                }
            }
        };

        let server = server.clone();
        let lifecycle = lifecycle.clone();
        tokio::spawn(async move {
            run_connection(connected, server, lifecycle).await;
        });
    }
}

/// Wrap [`handle_connection`] with the lifecycle bookkeeping:
/// increment / decrement the shared connection counter via an RAII guard
/// and `select!` on `disconnect_signal.notified()` so a `mcp_disconnect_all`
/// call exits the handler promptly. When `lifecycle` is `None` this is a
/// straight passthrough.
async fn run_connection<S, RO, RW>(
    stream: S,
    server: Arc<McpServer<RO, RW>>,
    lifecycle: Option<McpLifecycle>,
) where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    RO: ToolRegistry,
    RW: ToolRegistry,
{
    // Bind the RAII counter guard to the task lifetime so panics (or the
    // disconnect-signal branch below) still decrement the counter.
    let _guard = lifecycle
        .as_ref()
        .map(|lc| ConnectionCounterGuard::new(lc.active_connections.clone()));

    let fut = handle_connection(stream, server);

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
                    // Do not drop the in-flight future
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
            error = %e,
            "MCP connection ended with error",
        );
    }
}

// ---------------------------------------------------------------------------
// #636 — accept-loop back-off tests
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
// Regression tests
// ---------------------------------------------------------------------------
//
// `serve_pipe` previously hard-coded the successor pipe path to a
// constant, which re-bound a second server's successor named-pipe
// instances onto the first one's namespace (M-83). The fix threads the
// bound pipe path through the `SocketKind::Pipe { server, path }` variant
// so the type system makes the correct path available to the accept loop.
//
// Linux / macOS see no behaviour change — Windows named pipes are the
// only platform that recreates per-instance servers, so the tests here
// Are gated `#[cfg(windows)]`. On Linux/macOS the module compiles
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
        use crate::mcp::test_support;
        use crate::mcp::{MCP_PIPE_PATH, McpLifecycle, SocketKind};
        use tokio::net::windows::named_pipe::{ClientOptions, ServerOptions};

        /// Pick a pipe name that is guaranteed to differ from
        /// `MCP_PIPE_PATH`. Includes the current process id and a random
        /// ULID so concurrent test runs do not collide.
        fn unique_pipe_path(tag: &str) -> String {
            format!(
                r"\\.\pipe\agaric-mcp-m83-{tag}-{pid}-{ulid}",
                tag = tag,
                pid = std::process::id(),
                ulid = ulid::Ulid::generate(),
            )
        }

        /// Acceptance test. Bind a `NamedPipeServer` on a custom
        /// path that differs from the production constant, hand
        /// the listener to `serve()` via `SocketKind::Pipe { server,
        /// path }`, and verify that after the first client connects
        /// (and the accept loop creates the next server instance) a
        /// SECOND client can connect to the SAME custom path. Pre-fix
        /// the second connect failed: the successor was created on the
        /// constant's namespace instead.
        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn m83_serve_pipe_uses_threaded_path_not_hardcoded_constant() {
            let pipe_path = unique_pipe_path("threaded");

            // Make sure the chosen path is genuinely distinct from the
            // production constant — defends the test against a future
            // tweak to `unique_pipe_path` that accidentally matches it.
            assert_ne!(pipe_path.as_str(), MCP_PIPE_PATH);

            let server = ServerOptions::new()
                .first_pipe_instance(true)
                .create(&pipe_path)
                .expect("first server instance binds on the custom path");

            let socket = SocketKind::Pipe {
                server,
                path: pipe_path.clone(),
            };

            let server = test_support::server(
                PlaceholderRegistry,
                PlaceholderRegistry,
                test_support::unused_pool(),
            );
            let lifecycle = McpLifecycle::new();
            let serve_lc = lifecycle.clone();
            let serve_task =
                tokio::spawn(async move { serve(socket, server, Some(serve_lc)).await });

            // First client: connect on the custom path. The accept
            // loop hands the connection off to a per-connection task
            // and then creates the next server instance via
            // `ServerOptions::new().create(pipe_path)` — this is the
            // Line fixes.
            let _client_1 = ClientOptions::new()
                .open(pipe_path.as_str())
                .expect("first client connects to the custom-path pipe");

            // Second client: connect AGAIN on the custom path. This
            // would fail pre-fix because the accept loop re-created
            // the second server instance on the constant's namespace
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
                "second client must connect to the SAME custom pipe path the server was bound on",
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
