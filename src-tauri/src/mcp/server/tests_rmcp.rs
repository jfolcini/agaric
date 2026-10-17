//! rmcp-client integration tests.
//!
//! Wire-level coverage for what the adapter does not own: the agent token
//! handshake and the registry an agent's mode picks (`handle_connection`),
//! the disconnect grace period (`run_connection`), and the rmcp framer's
//! handling of protocol-level errors (unknown method, malformed JSON).
//! Sibling `mcp::rmcp_adapter::tests` covers the happy-path tools/list +
//! tools/call surface.
//!
//! All tests drive a real rmcp client (or raw bytes for the handshake and
//! framer-rejection paths) over a `tokio::io::duplex` transport — no socket
//! or Tauri runtime; a temp vault holds the agents.

use std::sync::Arc;
use std::time::Duration;

use rmcp::{
    model::{CallToolRequestParams, ClientCapabilities, ClientConfig, Implementation},
    service::ServiceExt,
};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use super::{
    MCP_DISCONNECT_GRACE_PERIOD, McpServer, PlaceholderRegistry, handle_connection, run_connection,
};
use crate::materializer::Materializer;
use crate::mcp::activity::{ActivityContext, ActivityRing, RecordingEmitter};
use crate::mcp::agents::{AgentStore, McpAgentMode, delete_agent, insert_agent};
use crate::mcp::registry::{ToolDescription, ToolRegistry};
use crate::mcp::tools_ro::ReadOnlyTools;
use crate::mcp::tools_rw::ReadWriteTools;
use crate::mcp::{McpLifecycle, TOKEN_PREAMBLE, test_support};
use agaric_core::error::AppError;
use agaric_store::task_locals::ActorContext;

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

fn make_test_client_info(name: &str) -> ClientConfig {
    ClientConfig::new(
        ClientCapabilities::default(),
        Implementation::new(name, "0.1.0"),
    )
}

/// The bridge's first line for `token`.
fn preamble(token: &str) -> String {
    format!("{TOKEN_PREAMBLE} {token}\n")
}

/// A JSON-RPC line, as a client writes it.
fn line(message: &Value) -> Vec<u8> {
    let mut bytes = serde_json::to_vec(message).unwrap();
    bytes.push(b'\n');
    bytes
}

fn initialize_request() -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "clientInfo": {"name": "handshake-test", "version": "0.1.0"},
            "capabilities": {},
        },
    })
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
    let slow = || SlowRegistry {
        sleep: Duration::from_millis(500),
    };
    let (pool, agent, _dir) =
        test_support::vault_with_agent("grace", McpAgentMode::ReadOnly, None).await;
    let server = test_support::server(slow(), slow(), pool);
    let lifecycle = McpLifecycle::new();

    let (server_io, mut client_io) = tokio::io::duplex(4096);
    client_io
        .write_all(preamble(&agent.token).as_bytes())
        .await
        .unwrap();

    let task_lc = lifecycle.clone();
    let server_task = tokio::spawn(async move {
        run_connection(server_io, server, Some(task_lc)).await;
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
    assert_eq!(
        crate::mcp::rmcp_adapter::tool_result_json(&result)["slept"],
        true,
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
    // Longer than the 2 s grace period so the timeout fires.
    let slow = || SlowRegistry {
        sleep: Duration::from_secs(5),
    };
    let (pool, agent, _dir) =
        test_support::vault_with_agent("grace", McpAgentMode::ReadOnly, None).await;
    let server = test_support::server(slow(), slow(), pool);
    let lifecycle = McpLifecycle::new();

    let (server_io, mut client_io) = tokio::io::duplex(4096);
    client_io
        .write_all(preamble(&agent.token).as_bytes())
        .await
        .unwrap();

    let task_lc = lifecycle.clone();
    let server_task = tokio::spawn(async move {
        run_connection(server_io, server, Some(task_lc)).await;
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
        "server task exited too quickly ({elapsed:?}); the grace-period \
         timeout arm must elapse before the stream is dropped",
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
    let (pool, agent, _dir) =
        test_support::vault_with_agent("framer", McpAgentMode::ReadOnly, None).await;
    let agent = test_support::connected(&pool, &agent).await;
    let adapter = RmcpAdapter::new(registry, None, agent);

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
    let (pool, agent, _dir) =
        test_support::vault_with_agent("framer", McpAgentMode::ReadOnly, None).await;
    let agent = test_support::connected(&pool, &agent).await;
    let adapter = RmcpAdapter::new(registry, None, agent);

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

// ──────────────────────────────────────────────────────────────────────
// #5667 — the agent token handshake
// ──────────────────────────────────────────────────────────────────────

type ClientReader = BufReader<tokio::io::ReadHalf<tokio::io::DuplexStream>>;
type ClientWriter = tokio::io::WriteHalf<tokio::io::DuplexStream>;

/// Writes `bytes` in one write to a fresh connection served by
/// `handle_connection`, returning the client's halves to read the replies
/// and keep the connection open.
async fn exchange<RO: ToolRegistry, RW: ToolRegistry>(
    server: Arc<McpServer<RO, RW>>,
    bytes: &[u8],
) -> (ClientReader, ClientWriter) {
    let (server_io, client_io) = tokio::io::duplex(64 * 1024);
    tokio::spawn(async move {
        handle_connection(server_io, server)
            .await
            .expect("the connection ends cleanly");
    });
    let (r, mut w) = tokio::io::split(client_io);
    w.write_all(bytes).await.unwrap();
    w.flush().await.unwrap();
    (BufReader::new(r), w)
}

/// The next reply line, or `None` once the server closed the connection.
async fn next_reply(reader: &mut ClientReader) -> Option<Value> {
    let mut buf = String::new();
    let read = tokio::time::timeout(Duration::from_secs(5), reader.read_line(&mut buf))
        .await
        .expect("the server answers")
        .expect("the reply is readable");
    (read > 0).then(|| serde_json::from_str(buf.trim_end()).expect("a JSON-RPC line"))
}

/// The reply refuses request `id` with `-32001` and names where to get a
/// token, and the server then closes the connection.
async fn assert_refused(reader: &mut ClientReader, id: Option<i64>) {
    let reply = next_reply(reader).await.expect("a refusal");
    match id {
        Some(id) => assert_eq!(reply["id"], id, "the refusal answers the request: {reply}"),
        None => assert!(
            reply.get("id").is_none(),
            "no request id to answer: {reply}"
        ),
    }
    assert_eq!(reply["error"]["code"], -32001, "{reply}");
    let message = reply["error"]["message"].as_str().unwrap_or_default();
    assert!(
        message.contains("Settings → Agent access"),
        "the refusal names where to get a token: {message}",
    );
    assert!(
        next_reply(reader).await.is_none(),
        "the server closes a refused connection",
    );
}

/// The bridge's preamble and the client's `initialize` can arrive in one
/// read; the bytes past the preamble must still reach rmcp.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn preamble_and_initialize_in_one_write_5667() {
    let (pool, agent, _dir) =
        test_support::vault_with_agent("one-write", McpAgentMode::ReadOnly, None).await;
    let server = test_support::server(PlaceholderRegistry, PlaceholderRegistry, pool);
    let mut bytes = preamble(&agent.token).into_bytes();
    bytes.extend(line(&initialize_request()));

    let (mut reader, _writer) = exchange(server, &bytes).await;

    let reply = next_reply(&mut reader).await.expect("a reply");
    assert_eq!(reply["id"], 1, "{reply}");
    assert_eq!(
        reply["result"]["serverInfo"]["name"], "agaric",
        "a live token gets the server's initialize result: {reply}",
    );
}

/// An `agaric-mcp` from before #5667, or a client that skips the bridge,
/// starts with MCP traffic.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn no_preamble_gets_a_settings_error_5667() {
    let (pool, _agent, _dir) =
        test_support::vault_with_agent("present", McpAgentMode::ReadWrite, None).await;
    let server = test_support::server(PlaceholderRegistry, PlaceholderRegistry, pool);

    let (mut reader, _writer) = exchange(server, &line(&initialize_request())).await;

    assert_refused(&mut reader, Some(1)).await;
}

/// The vault holds an agent, so a lookup that fell back to one would serve.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unknown_token_is_refused_5667() {
    let (pool, _agent, _dir) =
        test_support::vault_with_agent("present", McpAgentMode::ReadWrite, None).await;
    let server = test_support::server(PlaceholderRegistry, PlaceholderRegistry, pool);
    let mut bytes = preamble(&format!("agt_{}", "0".repeat(32))).into_bytes();
    bytes.extend(line(&initialize_request()));

    let (mut reader, _writer) = exchange(server, &bytes).await;

    assert_refused(&mut reader, Some(1)).await;
}

/// Another agent stays live, so a lookup that fell back to one would serve.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn revoked_token_is_refused_5667() {
    let (pool, agent, _dir) =
        test_support::vault_with_agent("revoked", McpAgentMode::ReadWrite, None).await;
    insert_agent(&pool, "present", McpAgentMode::ReadWrite, None)
        .await
        .unwrap()
        .unwrap();
    assert!(delete_agent(&pool, &agent.id).await.unwrap(), "revoked");
    let server = test_support::server(PlaceholderRegistry, PlaceholderRegistry, pool);
    let mut bytes = preamble(&agent.token).into_bytes();
    bytes.extend(line(&initialize_request()));

    let (mut reader, _writer) = exchange(server, &bytes).await;

    assert_refused(&mut reader, Some(1)).await;
}

/// A preamble without its token, and a first line that is neither a
/// preamble nor JSON.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn malformed_preamble_is_refused_5667() {
    let (pool, _agent, _dir) =
        test_support::vault_with_agent("present", McpAgentMode::ReadWrite, None).await;

    let mut bare = format!("{TOKEN_PREAMBLE}\n").into_bytes();
    bare.extend(line(&initialize_request()));
    let server = test_support::server(PlaceholderRegistry, PlaceholderRegistry, pool.clone());
    let (mut reader, _writer) = exchange(server, &bare).await;
    assert_refused(&mut reader, Some(1)).await;

    let server = test_support::server(PlaceholderRegistry, PlaceholderRegistry, pool);
    let (mut reader, _writer) = exchange(server, b"hello agaric\n").await;
    assert_refused(&mut reader, None).await;
}

// ──────────────────────────────────────────────────────────────────────
// #5667 — the agent's mode picks the registry
// ──────────────────────────────────────────────────────────────────────

const DEV: &str = "dev-5667";

type Client = rmcp::service::RunningService<rmcp::RoleClient, ClientConfig>;

/// The production registries over `pool`, and its agents.
fn real_server(
    pool: sqlx::SqlitePool,
    activity_ctx: Option<ActivityContext>,
) -> Arc<McpServer<ReadOnlyTools, ReadWriteTools>> {
    let mat = Materializer::new(pool.clone());
    Arc::new(McpServer {
        read_only: Arc::new(ReadOnlyTools::new(
            pool.clone(),
            pool.clone(),
            mat.clone(),
            DEV.into(),
        )),
        read_write: Arc::new(ReadWriteTools::new(
            pool.clone(),
            pool.clone(),
            mat,
            DEV.into(),
        )),
        agents: AgentStore::new(pool.clone(), pool),
        activity_ctx,
    })
}

/// An rmcp client named `client_name`, on a connection that presented
/// `token` as the bridge does.
async fn connect_as<RO: ToolRegistry, RW: ToolRegistry>(
    server: Arc<McpServer<RO, RW>>,
    token: &str,
    client_name: &str,
) -> Client {
    let (server_io, mut client_io) = tokio::io::duplex(256 * 1024);
    tokio::spawn(async move {
        let _ = handle_connection(server_io, server).await;
    });
    client_io
        .write_all(preamble(token).as_bytes())
        .await
        .unwrap();
    make_test_client_info(client_name)
        .serve(client_io)
        .await
        .expect("client handshake")
}

async fn tool_names(client: &Client) -> Vec<String> {
    client
        .list_all_tools()
        .await
        .expect("tools/list")
        .into_iter()
        .map(|tool| tool.name.into_owned())
        .collect()
}

fn names(descriptions: Vec<ToolDescription>) -> Vec<String> {
    descriptions.into_iter().map(|d| d.name).collect()
}

/// The error a `tools/call` with no arguments gets, if any.
async fn call_error(client: &Client, name: &str) -> Option<rmcp::model::ErrorData> {
    match client
        .call_tool(CallToolRequestParams::new(name.to_owned()))
        .await
    {
        Ok(_) => None,
        Err(rmcp::ServiceError::McpError(error)) => Some(error),
        Err(other) => panic!("{name}: not a tool error: {other}"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn read_only_agent_lists_no_write_tools_5667() {
    let (pool, reader_agent, _dir) =
        test_support::vault_with_agent("Reader", McpAgentMode::ReadOnly, None).await;
    let writer_agent = insert_agent(&pool, "Writer", McpAgentMode::ReadWrite, None)
        .await
        .unwrap()
        .unwrap();
    let server = real_server(pool, None);

    let reader = connect_as(server.clone(), &reader_agent.token, "client").await;
    assert_eq!(
        tool_names(&reader).await,
        names(crate::mcp::tools_ro::list_tool_descriptions()),
        "a read-only agent gets the read-only registry",
    );
    let instructions = reader
        .peer_info()
        .and_then(|info| info.instructions.clone())
        .unwrap_or_default();
    assert!(
        instructions.contains("read-only"),
        "a read-only agent is told so: {instructions:?}",
    );

    let writer = connect_as(server, &writer_agent.token, "client").await;
    assert_eq!(
        tool_names(&writer).await,
        names(crate::mcp::tools_rw::list_tool_descriptions()),
        "a read-write agent gets the write tools, then every read tool",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn each_write_tool_refuses_a_read_only_agent_5667() {
    let (pool, agent, _dir) =
        test_support::vault_with_agent("Reader", McpAgentMode::ReadOnly, None).await;
    let client = connect_as(real_server(pool, None), &agent.token, "client").await;

    for tool in crate::mcp::tools_rw::write_tool_descriptions() {
        let error = call_error(&client, &tool.name)
            .await
            .unwrap_or_else(|| panic!("{} ran for a read-only agent", tool.name));
        assert_eq!(error.code.0, -32001, "{}: {error:?}", tool.name);
        assert!(
            error.message.contains("unknown tool"),
            "{}: a read-only agent has no such tool: {}",
            tool.name,
            error.message,
        );
    }
}

/// Called without arguments, a read tool answers or refuses its arguments;
/// it is never an unknown tool, in either mode.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn each_read_tool_serves_both_modes_5667() {
    let (pool, reader_agent, _dir) =
        test_support::vault_with_agent("Reader", McpAgentMode::ReadOnly, None).await;
    let writer_agent = insert_agent(&pool, "Writer", McpAgentMode::ReadWrite, None)
        .await
        .unwrap()
        .unwrap();
    let server = real_server(pool, None);
    let reader = connect_as(server.clone(), &reader_agent.token, "client").await;
    let writer = connect_as(server, &writer_agent.token, "client").await;

    for tool in crate::mcp::tools_ro::list_tool_descriptions() {
        for (mode, client) in [("read-only", &reader), ("read-write", &writer)] {
            if let Some(error) = call_error(client, &tool.name).await {
                assert!(
                    !error.message.contains("unknown tool"),
                    "{} is not served to a {mode} agent: {}",
                    tool.name,
                    error.message,
                );
            }
        }
    }
}

// ──────────────────────────────────────────────────────────────────────
// #5667 — attribution
// ──────────────────────────────────────────────────────────────────────

async fn call_json(client: &Client, name: &str, args: Value) -> Value {
    let Value::Object(args) = args else {
        panic!("tool arguments are an object")
    };
    let result = client
        .call_tool(CallToolRequestParams::new(name.to_owned()).with_arguments(args))
        .await
        .unwrap_or_else(|e| panic!("{name} failed: {e}"));
    crate::mcp::rmcp_adapter::tool_result_json(&result)
}

/// The client calls itself `claude-code`; every trace of the edit names the
/// agent instead, and the session's Revert still undoes it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_agents_edit_carries_its_name_and_the_session_reverts_5667() {
    use crate::commands::{create_space_inner, revert_ops_inner};

    let (pool, agent, _dir) =
        test_support::vault_with_agent("Planner", McpAgentMode::ReadWrite, None).await;
    let mat = Materializer::new(pool.clone());
    let space = create_space_inner(&pool, DEV, &mat, "S".into(), None)
        .await
        .unwrap()
        .into_string();
    let ring = Arc::new(std::sync::Mutex::new(ActivityRing::new()));
    let activity = ActivityContext::new(ring.clone(), Arc::new(RecordingEmitter::new()));
    let client = connect_as(
        real_server(pool.clone(), Some(activity)),
        &agent.token,
        "claude-code",
    )
    .await;

    let page = call_json(
        &client,
        "create_page",
        json!({ "title": "Plan", "space_id": space }),
    )
    .await;
    let page_id = page["id"].as_str().expect("the page's id").to_owned();
    call_json(
        &client,
        "append_block",
        json!({ "parent_id": page_id, "content": "step one", "space_id": space }),
    )
    .await;
    mat.flush_background().await.unwrap();

    let origins: Vec<String> = sqlx::query_scalar!(
        r#"SELECT DISTINCT origin AS "origin!: String" FROM op_log WHERE origin LIKE 'agent:%'"#
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(origins, ["agent:Planner"], "op_log names the agent");

    let history = call_json(
        &client,
        "page_history",
        json!({ "page_id": page_id, "space_id": space }),
    )
    .await;
    let history_origins: Vec<&str> = history["items"]
        .as_array()
        .expect("history items")
        .iter()
        .map(|item| item["origin"].as_str().unwrap_or_default())
        .collect();
    assert_eq!(
        history_origins, ["agent:Planner"; 3],
        "History shows the agent's name on each op the two calls wrote",
    );

    let entries: Vec<_> = ring.lock().unwrap().entries().iter().cloned().collect();
    assert_eq!(entries.len(), 3, "one feed entry per call");
    assert!(
        entries
            .iter()
            .all(|entry| entry.agent_name.as_deref() == Some("Planner")),
        "the feed shows the agent's name: {entries:?}",
    );
    assert!(
        entries
            .iter()
            .all(|entry| entry.session_id == entries[0].session_id),
        "one connection is one session",
    );

    // Revert session: every op ref of the session's entries, as
    // `SessionRevertControls` sends them.
    let refs: Vec<agaric_store::op::OpRef> = entries
        .iter()
        .flat_map(|entry| {
            entry
                .op_ref
                .clone()
                .into_iter()
                .chain(entry.additional_op_refs.clone())
        })
        .collect();
    revert_ops_inner(&pool, DEV, &mat, refs).await.unwrap();
    let deleted: Option<i64> =
        sqlx::query_scalar!("SELECT deleted_at FROM blocks WHERE id = ?", page_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(deleted.is_some(), "reverting the session removes the page");
}
