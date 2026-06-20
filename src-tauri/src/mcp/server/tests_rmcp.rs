//! rmcp-client integration tests.
//!
//! Wire-level coverage for the surfaces the production
//! `handle_connection` no longer owns directly: the
//! disconnect grace period (still implemented in `run_connection`)
//! and the rmcp framer's handling of protocol-level errors (unknown
//! method, malformed JSON). Sibling `mcp::rmcp_adapter::tests` covers
//! the happy-path tools/list + tools/call surface; this file
//! exclusively covers the lifecycle wrapper + framer-rejection paths.
//!
//! All tests drive a real rmcp client (or raw bytes for the framer-
//! rejection paths) over a `tokio::io::duplex` transport — no socket
//! / DB / Tauri runtime needed.

use std::sync::Arc;
use std::time::Duration;

use rmcp::{
    model::{CallToolRequestParams, ClientCapabilities, ClientInfo, Implementation},
    service::ServiceExt,
};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use super::MCP_DISCONNECT_GRACE_PERIOD;
use super::run_connection;
use crate::error::AppError;
use crate::mcp::McpLifecycle;
use crate::mcp::actor::ActorContext;
use crate::mcp::registry::{ToolDescription, ToolRegistry};

/// Registry whose `call_tool` parks on `sleep(self.sleep)` before
/// Returning success — drives the grace-period race between
/// `lifecycle.disconnect_all()` and an in-flight tool dispatch.
struct SlowRegistry {
    sleep: Duration,
}

impl ToolRegistry for SlowRegistry {
    fn list_tools(&self) -> Vec<ToolDescription> {
        vec![ToolDescription {
            name: "slow".to_string(),
            description: "Sleeps before returning success —  grace-period test fixture."
                .to_string(),
            input_schema: json!({ "type": "object", "properties": {} }),
        }]
    }

    async fn call_tool(
        &self,
        _name: &str,
        _args: Value,
        _ctx: &ActorContext,
    ) -> Result<Value, AppError> {
        tokio::time::sleep(self.sleep).await;
        Ok(json!({ "slept": true }))
    }
}

fn make_test_client_info(name: &str) -> ClientInfo {
    ClientInfo::new(
        ClientCapabilities::default(),
        Implementation::new(name, "0.1.0"),
    )
}

// ──────────────────────────────────────────────────────────────────────
// Grace period — happy path
// ──────────────────────────────────────────────────────────────────────

/// When `lifecycle.disconnect_all()` fires while a `tools/call` is
/// mid-dispatch, `run_connection` must wrap the in-flight future in
/// a 2 s timeout so the call gets a chance to return its CallToolResult
/// before the stream is dropped. This test exercises the happy path:
/// the tool finishes well within the grace period, so the agent sees
/// the reply.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn disconnect_signal_grants_grace_period_for_in_flight_tool_call_l113() {
    let registry = Arc::new(SlowRegistry {
        sleep: Duration::from_millis(500),
    });
    let lifecycle = McpLifecycle::new();

    let (server_io, client_io) = tokio::io::duplex(4096);

    let task_lc = lifecycle.clone();
    let task_registry = registry.clone();
    let server_task = tokio::spawn(async move {
        run_connection(
            server_io,
            task_registry,
            None,
            Some(task_lc),
            crate::mcp::McpSurface::ReadOnly,
        )
        .await;
    });

    let client = make_test_client_info("l113-grace-test")
        .serve(client_io)
        .await
        .expect("client handshake");

    // Spawn the slow call_tool as a background task so we can fire
    // `disconnect_all` while it is parked inside the registry. We
    // hold the `RunningService` (the rmcp client) by reference via
    // the spawned closure's move — the actual `peer().call_tool` runs
    // through the client's request channel.
    let call_task = {
        let peer = client.peer().clone();
        tokio::spawn(async move { peer.call_tool(CallToolRequestParams::new("slow")).await })
    };

    // Park long enough for the dispatch to enter the registry's
    // `call_tool` body (which then parks on `sleep(500ms)`). Without
    // this, `disconnect_all` races the dispatch and `notify_waiters`
    // misses the connection task (edge-triggered semantics).
    tokio::time::sleep(Duration::from_millis(100)).await;

    lifecycle.disconnect_all();

    // The slow tool finishes in ~500 ms, well under the 2 s grace
    // period, so the CallToolResult must arrive at the client before
    // the grace timeout drops the stream.
    let outcome = tokio::time::timeout(
        MCP_DISCONNECT_GRACE_PERIOD + Duration::from_millis(500),
        call_task,
    )
    .await
    .expect("call_tool must complete within the  grace period")
    .expect("call_task did not panic");

    let result = outcome.expect("tools/call must succeed under the grace period");
    assert_eq!(
        result.is_error,
        Some(false),
        "is_error must be false: {result:?}"
    );
    let structured = result
        .structured_content
        .as_ref()
        .expect("structured_content carries the slow tool's payload");
    assert_eq!(
        structured["slept"], true,
        "payload must echo the slow tool body"
    );

    // Tear down the client so the server task observes EOF / drop.
    let _ = client.cancel().await;
    let _ = tokio::time::timeout(Duration::from_secs(2), server_task).await;
}

// ──────────────────────────────────────────────────────────────────────
// Grace period — timeout (hang) path
// ──────────────────────────────────────────────────────────────────────

/// If the in-flight `tools/call` does not complete within the bounded
/// grace period, `run_connection` must drop the future, exit cleanly,
/// and release the stream. The assertion shape is timing-based: the
/// server task elapses at least `MCP_DISCONNECT_GRACE_PERIOD` between
/// `disconnect_all` firing and the task ending, proving the timeout
/// arm of the `select!` was taken (and not the immediate-cancel arm
/// or an early EOF).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn disconnect_signal_drops_after_grace_period_when_call_hangs_l113() {
    let registry = Arc::new(SlowRegistry {
        // Longer than the 2 s grace period so the timeout fires.
        sleep: Duration::from_secs(5),
    });
    let lifecycle = McpLifecycle::new();

    let (server_io, client_io) = tokio::io::duplex(4096);

    let task_lc = lifecycle.clone();
    let task_registry = registry.clone();
    let server_task = tokio::spawn(async move {
        run_connection(
            server_io,
            task_registry,
            None,
            Some(task_lc),
            crate::mcp::McpSurface::ReadOnly,
        )
        .await;
    });

    let client = make_test_client_info("l113-drop-test")
        .serve(client_io)
        .await
        .expect("client handshake");

    let _call_task = {
        let peer = client.peer().clone();
        tokio::spawn(async move { peer.call_tool(CallToolRequestParams::new("slow")).await })
    };

    // Park long enough for the dispatch to enter the registry's
    // `call_tool` body so the disconnect arm of `run_connection`'s
    // `select!` is parked on `notified().await` (edge-triggered
    // semantics).
    tokio::time::sleep(Duration::from_millis(100)).await;

    let t0 = std::time::Instant::now();
    lifecycle.disconnect_all();

    // Wait the full grace period plus a 2 s buffer for the timeout
    // future to resolve and the per-connection task to drop the
    // stream. The assertion is two-part:
    //   (a) the server task must exit within `grace + buffer`, and
    //   (b) it must NOT exit before `grace - tolerance` — that would
    //       mean the grace-period arm was skipped.
    let server_outcome = tokio::time::timeout(
        MCP_DISCONNECT_GRACE_PERIOD + Duration::from_secs(2),
        server_task,
    )
    .await;
    assert!(
        server_outcome.is_ok(),
        "server task must exit within grace + buffer; timed out",
    );
    let elapsed = t0.elapsed();
    let lower_bound = MCP_DISCONNECT_GRACE_PERIOD - Duration::from_millis(200);
    assert!(
        elapsed >= lower_bound,
        "server task exited too quickly ({:?}); the grace-period \
         timeout arm must elapse before the stream is dropped",
        elapsed,
    );
}

// ──────────────────────────────────────────────────────────────────────
// Protocol-error path — unknown JSON-RPC method
// ──────────────────────────────────────────────────────────────────────

/// `tools/list` and `tools/call` are wired through rmcp's typed router,
/// but the spec also requires the server to respond with
/// `-32601 Method not found` for unknown method names. Drive a raw
/// JSON-RPC request for `tools/nonexistent` over the wire so we
/// exercise rmcp's framer path (the rmcp client API only constructs
/// typed `ClientRequest` variants, which closes off the unknown-method
/// surface — raw bytes are the only way to test it).
///
/// Server side still uses the production `RmcpAdapter` over
/// `tokio::io::duplex`; client side writes raw newline-delimited JSON
/// directly to the pipe.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unknown_method_returns_method_not_found() {
    use crate::mcp::rmcp_adapter::RmcpAdapter;

    let registry = Arc::new(SlowRegistry {
        sleep: Duration::from_millis(0),
    });
    let adapter = RmcpAdapter::new(registry, None, crate::mcp::McpSurface::ReadOnly);

    let (server_io, client_io) = tokio::io::duplex(4096);
    let server_task = tokio::spawn(async move {
        let server = adapter.serve(server_io).await.expect("server handshake");
        let _ = server.waiting().await;
    });

    let (r, mut w) = tokio::io::split(client_io);
    let mut reader = BufReader::new(r);

    // Initialize handshake — rmcp requires a completed `initialize`
    // before any other request gets a response.
    let init = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "clientInfo": {"name": "unknown-method-test", "version": "0.1.0"},
            "capabilities": {},
        },
    });
    let mut bytes = serde_json::to_vec(&init).unwrap();
    bytes.push(b'\n');
    w.write_all(&bytes).await.unwrap();
    w.flush().await.unwrap();

    // Drain the initialize response.
    let mut buf = String::new();
    reader.read_line(&mut buf).await.unwrap();
    let init_resp: Value = serde_json::from_str(buf.trim_end_matches(['\r', '\n'])).unwrap();
    assert_eq!(init_resp["id"], 1, "initialize id echoes: {init_resp:?}");

    // Notification: initialized (required by spec; rmcp gates
    // subsequent requests on this).
    let initialized = json!({
        "jsonrpc": "2.0",
        "method": "notifications/initialized",
    });
    let mut bytes = serde_json::to_vec(&initialized).unwrap();
    bytes.push(b'\n');
    w.write_all(&bytes).await.unwrap();
    w.flush().await.unwrap();

    // Unknown method — rmcp's framer must emit `-32601`.
    let unknown = json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/nonexistent",
        "params": {},
    });
    let mut bytes = serde_json::to_vec(&unknown).unwrap();
    bytes.push(b'\n');
    w.write_all(&bytes).await.unwrap();
    w.flush().await.unwrap();

    let mut buf = String::new();
    let read_outcome = tokio::time::timeout(Duration::from_secs(5), reader.read_line(&mut buf))
        .await
        .expect("server must reply within timeout")
        .expect("server reply must be readable");
    assert!(read_outcome > 0, "server reply must be non-empty");

    let response: Value = serde_json::from_str(buf.trim_end_matches(['\r', '\n'])).unwrap();
    assert_eq!(response["id"], 2, "echoed id");
    assert_eq!(
        response["error"]["code"], -32601,
        "unknown method must surface as JSON-RPC -32601; got: {response}",
    );

    drop(w);
    drop(reader);
    let _ = tokio::time::timeout(Duration::from_secs(2), server_task).await;
}

// ──────────────────────────────────────────────────────────────────────
// Protocol-error path — malformed JSON line
// ──────────────────────────────────────────────────────────────────────

/// rmcp's framer must reject malformed JSON without panicking the
/// server task. The exact wire response is rmcp-internal (it may emit
/// `-32700 Parse error` or fail the handshake) — what matters for
/// agaric is that the server task exits cleanly so the per-connection
/// accept loop continues handling future connections.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn malformed_json_does_not_panic_server() {
    use crate::mcp::rmcp_adapter::RmcpAdapter;

    let registry = Arc::new(SlowRegistry {
        sleep: Duration::from_millis(0),
    });
    let adapter = RmcpAdapter::new(registry, None, crate::mcp::McpSurface::ReadOnly);

    let (server_io, client_io) = tokio::io::duplex(4096);
    let server_task = tokio::spawn(async move {
        // `serve` is expected to fail on garbage input (no valid
        // initialize handshake). The assertion is that no panic
        // propagates out of the spawn.
        let serve_result = adapter.serve(server_io).await;
        if let Ok(server) = serve_result {
            let _ = server.waiting().await;
        }
    });

    let (r, mut w) = tokio::io::split(client_io);

    // Send malformed bytes where rmcp expects the initialize
    // request. Drop BOTH halves of the duplex so both directions
    // observe EOF — `tokio::io::split` retains the inner pipe until
    // every half is dropped.
    w.write_all(b"this is not json\n").await.unwrap();
    w.flush().await.unwrap();
    drop(w);
    drop(r);

    // Server task must complete (not panic, not hang) within a
    // bounded budget. Both `Ok` (clean handshake-rejection) and
    // join error (unexpected) are caught — the assertion is that
    // the timeout does not elapse and no panic propagates.
    let join = tokio::time::timeout(Duration::from_secs(5), server_task).await;
    assert!(
        join.is_ok(),
        "server task must terminate (not hang) on malformed JSON; timed out",
    );
    let inner = join.unwrap();
    assert!(
        inner.is_ok(),
        "server task must not panic on malformed JSON; got join error: {inner:?}",
    );
}
