//! JSON-RPC 2.0 dispatch for the MCP read-only server.
//!
//! FEAT-4a ships the handshake skeleton only:
//!
//! - `initialize` — parse the protocol version, capture `clientInfo`,
//!   return `serverInfo` + a capabilities bag advertising `tools`.
//! - `tools/list` — always returns an empty array. Tools land in FEAT-4c
//!   behind the real `ToolRegistry` impl.
//! - `tools/call` — returns `-32601 Method not found` until FEAT-4c wires
//!   real tools through.
//! - `notifications/initialized` — notification (no response).
//! - Anything else — `-32601 Method not found`.
//! - Malformed JSON — `-32700 Parse error`.
//!
//! Framing: line-delimited JSON (one JSON-RPC message per `\n`-terminated
//! line) over the Unix-domain socket / Windows named pipe. This matches the
//! MCP spec's stdio subprocess framing, which the `agaric-mcp` stub binary
//! forwards verbatim.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use ulid::Ulid;

use super::actor::{Actor, ActorContext, ACTOR};
use super::SocketKind;
use crate::error::AppError;

// Re-export the registry types so external callers (tests, mod.rs's
// `spawn_mcp_ro_task` default path) that still refer to
// `server::ToolRegistry` / `server::PlaceholderRegistry` keep compiling
// after FEAT-4b moved the real trait into the `registry` submodule.
pub use super::registry::{PlaceholderRegistry, ToolDescription, ToolRegistry};

// ---------------------------------------------------------------------------
// Protocol constants
// ---------------------------------------------------------------------------

/// MCP protocol version this server implements. Clients that advertise a
/// different version during `initialize` still get a response — version
/// negotiation is the client's responsibility per the MCP spec.
pub const MCP_PROTOCOL_VERSION: &str = "2024-11-05";

/// Name returned in the `serverInfo` block of the `initialize` response.
pub const MCP_SERVER_NAME: &str = "agaric";

/// Server version returned in `serverInfo`. Pinned to the crate version so
/// agents see the same value as `agaric-mcp --version`.
pub const MCP_SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");

// JSON-RPC 2.0 standard error codes.
pub const JSONRPC_PARSE_ERROR: i64 = -32700;
pub const JSONRPC_INVALID_REQUEST: i64 = -32600;
pub const JSONRPC_METHOD_NOT_FOUND: i64 = -32601;
pub const JSONRPC_INVALID_PARAMS: i64 = -32602;
pub const JSONRPC_INTERNAL_ERROR: i64 = -32603;

// ---------------------------------------------------------------------------
// Handshake payload types
// ---------------------------------------------------------------------------

/// `clientInfo` block inside `initialize` params. Captured for structured
/// logging only — FEAT-4b threads it through the `ActorContext` plumbing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientInfo {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

/// Per-connection state captured during the handshake and reused across
/// subsequent requests on the same socket.
///
/// `activity_ctx` is the FEAT-4d seam: when `Some`, every completed
/// `tools/call` dispatch pushes an [`super::activity::ActivityEntry`] into
/// the shared ring and emits an `mcp:activity` Tauri event. The current
/// placeholder dispatch returns `-32601` and does *not* emit — only real
/// tool invocations (wired by FEAT-4c) should record activity.
#[derive(Debug, Default)]
pub struct ConnectionState {
    pub client_info: Option<ClientInfo>,
    pub protocol_version: Option<String>,
    pub initialized: bool,
    pub activity_ctx: Option<super::activity::ActivityContext>,
}

// ---------------------------------------------------------------------------
// JSON-RPC framing
// ---------------------------------------------------------------------------

/// Build a JSON-RPC 2.0 success response body.
fn make_success(id: &Value, result: &Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result,
    })
}

/// Build a JSON-RPC 2.0 error response body.
pub fn make_error(id: &Value, code: i64, message: impl Into<String>) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": code,
            "message": message.into(),
        },
    })
}

/// Parse a single line as a JSON-RPC 2.0 request. Returns either the parsed
/// request or a ready-to-send error envelope (for `-32700 Parse error` etc).
enum ParsedRequest {
    Ok(IncomingRequest),
    Err(Value),
    /// A JSON-RPC notification (no `id`) — response is suppressed.
    Notification(IncomingNotification),
}

struct IncomingRequest {
    id: Value,
    method: String,
    params: Value,
}

struct IncomingNotification {
    method: String,
    #[allow(dead_code)]
    params: Value,
}

fn parse_request(line: &str) -> ParsedRequest {
    let value: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => {
            return ParsedRequest::Err(make_error(
                &Value::Null,
                JSONRPC_PARSE_ERROR,
                format!("Parse error: {e}"),
            ));
        }
    };

    let Some(obj) = value.as_object() else {
        return ParsedRequest::Err(make_error(
            &Value::Null,
            JSONRPC_INVALID_REQUEST,
            "Request must be a JSON object",
        ));
    };

    // `method` is required.
    let method = match obj.get("method").and_then(|m| m.as_str()) {
        Some(m) => m.to_string(),
        None => {
            return ParsedRequest::Err(make_error(
                &obj.get("id").cloned().unwrap_or(Value::Null),
                JSONRPC_INVALID_REQUEST,
                "Missing `method` field",
            ));
        }
    };

    let params = obj.get("params").cloned().unwrap_or(Value::Null);

    // A request with no `id` field is a notification (no response is sent).
    // Per JSON-RPC 2.0 §4.1, `"id": null` is *also* a notification in
    // practice but most MCP clients still expect a response; treat missing
    // `id` as the notification case and everything else as a request.
    match obj.get("id").cloned() {
        None => ParsedRequest::Notification(IncomingNotification { method, params }),
        Some(id) => ParsedRequest::Ok(IncomingRequest { id, method, params }),
    }
}

// ---------------------------------------------------------------------------
// Method dispatch
// ---------------------------------------------------------------------------

fn handle_initialize(state: &mut ConnectionState, params: &Value) -> Result<Value, (i64, String)> {
    // `protocolVersion` is required by the MCP spec. Accept any string —
    // version negotiation is the client's responsibility.
    let protocol_version = params
        .get("protocolVersion")
        .and_then(|v| v.as_str())
        .map(str::to_string);

    let client_info = params
        .get("clientInfo")
        .and_then(|ci| serde_json::from_value::<ClientInfo>(ci.clone()).ok());

    state.protocol_version = protocol_version.clone();
    state.client_info = client_info.clone();

    if let Some(ref info) = client_info {
        tracing::info!(
            target: "mcp",
            client = %info.name,
            version = info.version.as_deref().unwrap_or("unknown"),
            proto = protocol_version.as_deref().unwrap_or("unknown"),
            "MCP client connected",
        );
    } else {
        tracing::info!(
            target: "mcp",
            proto = protocol_version.as_deref().unwrap_or("unknown"),
            "MCP client connected without clientInfo",
        );
    }

    Ok(json!({
        "protocolVersion": MCP_PROTOCOL_VERSION,
        "capabilities": {
            "tools": { "listChanged": false },
        },
        "serverInfo": {
            "name": MCP_SERVER_NAME,
            "version": MCP_SERVER_VERSION,
        },
    }))
}

fn handle_tools_list<R: ToolRegistry>(registry: &R) -> Result<Value, (i64, String)> {
    let tools = registry.list_tools();
    let serialised = serde_json::to_value(&tools).map_err(|e| {
        (
            JSONRPC_INTERNAL_ERROR,
            format!("failed to serialise tool list: {e}"),
        )
    })?;
    Ok(json!({ "tools": serialised }))
}

/// Map an [`AppError`] returned by a tool handler onto a JSON-RPC error
/// envelope pair `(code, message)`. The message is the `AppError`'s
/// `Display` rendering — good enough for agent-side debugging without
/// exposing the underlying `kind` discriminant (which is a Tauri IPC
/// concern, not an MCP one).
fn app_error_to_jsonrpc(err: &AppError) -> (i64, String) {
    let code = match err {
        AppError::NotFound(_) => JSONRPC_METHOD_NOT_FOUND,
        AppError::Validation(_) | AppError::InvalidOperation(_) => JSONRPC_INVALID_PARAMS,
        _ => JSONRPC_INTERNAL_ERROR,
    };
    (code, err.to_string())
}

/// Dispatch a `tools/call` request through the registry. Constructs a
/// fresh [`ActorContext`] from the handshake's captured `clientInfo.name`
/// (defaulting to a synthetic `Agent { name: "unknown" }` if the client
/// skipped the `initialize` handshake) and runs the registry call inside
/// `ACTOR.scope(...)` so downstream command handlers can read the
/// `current_actor()` without threading it through their signatures.
async fn handle_tools_call<R: ToolRegistry>(
    state: &ConnectionState,
    params: &Value,
    registry: &R,
) -> Result<Value, (i64, String)> {
    let name = params
        .get("name")
        .and_then(|n| n.as_str())
        .ok_or_else(|| {
            (
                JSONRPC_INVALID_PARAMS,
                "tools/call: missing `name` field".to_string(),
            )
        })?
        .to_string();

    // MCP specifies `arguments` as the argument-bag field name.
    let args = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| Value::Object(serde_json::Map::new()));

    // Build the per-request ActorContext. The handshake guarantees a
    // `clientInfo.name` when the client followed the protocol, but we
    // gracefully tolerate a client that skipped `initialize` (some test
    // harnesses do) by falling back to `Agent { name: "unknown" }`.
    let agent_name = state
        .client_info
        .as_ref()
        .map(|ci| ci.name.clone())
        .unwrap_or_else(|| "unknown".to_string());
    let ctx = ActorContext {
        actor: Actor::Agent { name: agent_name },
        request_id: Ulid::new().to_string(),
    };

    // Two `ActorContext`s on purpose:
    //
    // - `scoped_ctx` is moved into `ACTOR.scope(...)` so downstream
    //   handlers (FEAT-4d activity feed, FEAT-4h op-log `origin`) can read
    //   it via `current_actor()` without an explicit parameter.
    // - `call_ctx` is borrowed to the registry so impls that prefer the
    //   explicit-parameter style do not need to touch the task-local.
    let scoped_ctx = ctx.clone();
    let call_ctx = ctx;
    let result = ACTOR
        .scope(scoped_ctx, async {
            registry.call_tool(&name, args, &call_ctx).await
        })
        .await;

    match result {
        Ok(value) => Ok(value),
        Err(err) => {
            tracing::debug!(
                target: "mcp",
                tool = %name,
                error = %err,
                "tools/call failed",
            );
            Err(app_error_to_jsonrpc(&err))
        }
    }
}

async fn dispatch<R: ToolRegistry>(
    state: &mut ConnectionState,
    method: &str,
    params: &Value,
    registry: &R,
) -> Result<Value, (i64, String)> {
    match method {
        "initialize" => handle_initialize(state, params),
        "tools/list" => handle_tools_list(registry),
        "tools/call" => handle_tools_call(state, params, registry).await,
        other => Err((
            JSONRPC_METHOD_NOT_FOUND,
            format!("Method `{other}` not found"),
        )),
    }
}

fn handle_notification(state: &mut ConnectionState, method: &str) {
    match method {
        "notifications/initialized" => {
            state.initialized = true;
            tracing::debug!(target: "mcp", "client signalled notifications/initialized");
        }
        other => {
            tracing::debug!(
                target: "mcp",
                method = other,
                "ignoring unknown notification",
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Per-connection loop
// ---------------------------------------------------------------------------

/// Drive a single MCP connection to completion. Reads line-delimited JSON
/// requests from `stream`, dispatches each through `registry`, and writes
/// line-delimited JSON responses back. Returns `Ok(())` on clean EOF.
///
/// `activity_ctx` is the FEAT-4d activity-emission seam. Pass `None` when
/// no activity tracking is desired (stub binary, tests); pass
/// `Some(ActivityContext::from_app_handle(...))` in production. When
/// `Some`, successful tool dispatches (FEAT-4c) will emit `mcp:activity`
/// events via the bundled emitter.
pub async fn handle_connection<S, R>(
    stream: S,
    registry: &R,
    activity_ctx: Option<super::activity::ActivityContext>,
) -> Result<(), AppError>
where
    S: AsyncRead + AsyncWrite + Unpin,
    R: ToolRegistry,
{
    let (read_half, mut write_half) = tokio::io::split(stream);
    let mut reader = BufReader::new(read_half);
    let mut state = ConnectionState {
        activity_ctx,
        ..ConnectionState::default()
    };
    let mut line = String::new();

    loop {
        line.clear();
        let n = reader.read_line(&mut line).await?;
        if n == 0 {
            // EOF — clean disconnect.
            return Ok(());
        }

        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            continue;
        }

        let response = match parse_request(trimmed) {
            ParsedRequest::Ok(req) => {
                match dispatch(&mut state, &req.method, &req.params, registry).await {
                    Ok(result) => Some(make_success(&req.id, &result)),
                    Err((code, message)) => Some(make_error(&req.id, code, message)),
                }
            }
            ParsedRequest::Err(envelope) => Some(envelope),
            ParsedRequest::Notification(note) => {
                handle_notification(&mut state, &note.method);
                None
            }
        };

        if let Some(response) = response {
            let mut payload = serde_json::to_vec(&response)?;
            payload.push(b'\n');
            write_half.write_all(&payload).await?;
            write_half.flush().await?;
        }
    }
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
pub async fn serve<R>(
    socket: SocketKind,
    registry: std::sync::Arc<R>,
    activity_ctx: Option<super::activity::ActivityContext>,
) -> Result<(), AppError>
where
    R: ToolRegistry + Send + Sync + 'static,
{
    match socket {
        #[cfg(unix)]
        SocketKind::Unix(listener) => serve_unix(listener, registry, activity_ctx).await,
        #[cfg(windows)]
        SocketKind::Pipe(server) => serve_pipe(server, registry, activity_ctx).await,
    }
}

#[cfg(unix)]
async fn serve_unix<R>(
    listener: tokio::net::UnixListener,
    registry: std::sync::Arc<R>,
    activity_ctx: Option<super::activity::ActivityContext>,
) -> Result<(), AppError>
where
    R: ToolRegistry + Send + Sync + 'static,
{
    loop {
        let (stream, _addr) = listener.accept().await?;
        let registry = registry.clone();
        let activity_ctx = activity_ctx.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_connection(stream, registry.as_ref(), activity_ctx).await {
                tracing::warn!(target: "mcp", error = %e, "MCP connection ended with error");
            }
        });
    }
}

#[cfg(windows)]
async fn serve_pipe<R>(
    mut server: tokio::net::windows::named_pipe::NamedPipeServer,
    registry: std::sync::Arc<R>,
    activity_ctx: Option<super::activity::ActivityContext>,
) -> Result<(), AppError>
where
    R: ToolRegistry + Send + Sync + 'static,
{
    use tokio::net::windows::named_pipe::ServerOptions;

    // The pipe path is needed to create the *next* server instance after the
    // current one is handed off to a connection handler. We recover it from
    // the constant rather than threading it through the API.
    let pipe_path = super::MCP_RO_PIPE_PATH;

    loop {
        server.connect().await?;
        let connected = server;
        // Prepare the next server instance before handing off the current
        // connection. Without this, the second client would fail to connect.
        server = ServerOptions::new().create(pipe_path)?;

        let registry = registry.clone();
        let activity_ctx = activity_ctx.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_connection(connected, registry.as_ref(), activity_ctx).await {
                tracing::warn!(target: "mcp", error = %e, "MCP connection ended with error");
            }
        });
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[cfg(unix)]
    async fn connect_pair(
        socket_path: &std::path::Path,
    ) -> (tokio::net::UnixStream, tokio::task::JoinHandle<()>) {
        use tokio::net::{UnixListener, UnixStream};
        let listener = UnixListener::bind(socket_path).unwrap();
        let accept_task = tokio::spawn(async move {
            let (server_side, _) = listener.accept().await.unwrap();
            let registry = PlaceholderRegistry;
            let _ = handle_connection(server_side, &registry, None).await;
        });
        let client = UnixStream::connect(socket_path).await.unwrap();
        (client, accept_task)
    }

    async fn send_line<W: AsyncWrite + Unpin>(w: &mut W, body: &Value) {
        let mut bytes = serde_json::to_vec(body).unwrap();
        bytes.push(b'\n');
        w.write_all(&bytes).await.unwrap();
        w.flush().await.unwrap();
    }

    async fn read_line<R: AsyncRead + Unpin>(r: &mut BufReader<R>) -> Value {
        let mut buf = String::new();
        r.read_line(&mut buf).await.unwrap();
        serde_json::from_str(buf.trim_end_matches(['\r', '\n'])).unwrap()
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn initialize_handshake_returns_server_info() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("test.sock");
        let (client, task) = connect_pair(&path).await;
        let (r, mut w) = tokio::io::split(client);
        let mut reader = BufReader::new(r);

        let request = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "clientInfo": { "name": "test-client", "version": "0.0.1" },
                "capabilities": {},
            }
        });
        send_line(&mut w, &request).await;

        let response = read_line(&mut reader).await;
        assert_eq!(response["jsonrpc"], "2.0", "jsonrpc envelope");
        assert_eq!(response["id"], 1, "id echoed");
        let result = &response["result"];
        assert_eq!(
            result["serverInfo"]["name"], MCP_SERVER_NAME,
            "serverInfo.name",
        );
        assert_eq!(
            result["serverInfo"]["version"], MCP_SERVER_VERSION,
            "serverInfo.version matches crate version",
        );
        assert_eq!(
            result["protocolVersion"], MCP_PROTOCOL_VERSION,
            "protocolVersion pinned",
        );
        assert_eq!(
            result["capabilities"]["tools"]["listChanged"], false,
            "tools.listChanged is false",
        );

        drop(w);
        drop(reader);
        let _ = task.await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn tools_list_returns_empty_array_in_feat_4a() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("test.sock");
        let (client, task) = connect_pair(&path).await;
        let (r, mut w) = tokio::io::split(client);
        let mut reader = BufReader::new(r);

        let request = json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/list",
        });
        send_line(&mut w, &request).await;

        let response = read_line(&mut reader).await;
        assert_eq!(response["id"], 2);
        let tools = response["result"]["tools"].as_array().expect("tools array");
        assert_eq!(
            tools.len(),
            0,
            "FEAT-4a exposes zero tools; FEAT-4c adds them",
        );

        drop(w);
        drop(reader);
        let _ = task.await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn tools_call_returns_method_not_found() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("test.sock");
        let (client, task) = connect_pair(&path).await;
        let (r, mut w) = tokio::io::split(client);
        let mut reader = BufReader::new(r);

        let request = json!({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": { "name": "search", "arguments": {} },
        });
        send_line(&mut w, &request).await;

        let response = read_line(&mut reader).await;
        assert_eq!(response["id"], 3);
        assert_eq!(
            response["error"]["code"], JSONRPC_METHOD_NOT_FOUND,
            "tools/call must return -32601 until FEAT-4c wires tools",
        );
        let msg = response["error"]["message"].as_str().unwrap_or("");
        assert!(msg.contains("search"), "error message names the tool");

        drop(w);
        drop(reader);
        let _ = task.await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn unknown_method_returns_method_not_found() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("test.sock");
        let (client, task) = connect_pair(&path).await;
        let (r, mut w) = tokio::io::split(client);
        let mut reader = BufReader::new(r);

        let request = json!({
            "jsonrpc": "2.0",
            "id": 4,
            "method": "no/such/method",
        });
        send_line(&mut w, &request).await;

        let response = read_line(&mut reader).await;
        assert_eq!(response["id"], 4);
        assert_eq!(response["error"]["code"], JSONRPC_METHOD_NOT_FOUND);

        drop(w);
        drop(reader);
        let _ = task.await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn malformed_json_returns_parse_error() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("test.sock");
        let (client, task) = connect_pair(&path).await;
        let (r, mut w) = tokio::io::split(client);
        let mut reader = BufReader::new(r);

        w.write_all(b"{not json\n").await.unwrap();
        w.flush().await.unwrap();

        let response = read_line(&mut reader).await;
        assert_eq!(
            response["error"]["code"], JSONRPC_PARSE_ERROR,
            "garbage input must yield -32700 Parse error",
        );
        assert_eq!(response["id"], Value::Null, "parse error id is null");

        drop(w);
        drop(reader);
        let _ = task.await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn notifications_initialized_has_no_response() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("test.sock");
        let (client, task) = connect_pair(&path).await;
        let (r, mut w) = tokio::io::split(client);
        let mut reader = BufReader::new(r);

        let notification = json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized",
        });
        send_line(&mut w, &notification).await;

        // No response is expected. Send a follow-up request and verify we
        // only see *its* response on the wire.
        let follow_up = json!({
            "jsonrpc": "2.0",
            "id": 42,
            "method": "tools/list",
        });
        send_line(&mut w, &follow_up).await;

        let response = read_line(&mut reader).await;
        assert_eq!(
            response["id"], 42,
            "notification must not produce a response",
        );

        drop(w);
        drop(reader);
        let _ = task.await;
    }

    #[tokio::test]
    async fn handle_connection_returns_ok_on_eof() {
        // Feed an empty stream; the handler should return Ok(()) cleanly
        // instead of panicking or spinning forever.
        let (client, server) = tokio::io::duplex(64);
        drop(client); // immediate EOF on the server side
        let registry = PlaceholderRegistry;
        handle_connection(server, &registry, None)
            .await
            .expect("clean EOF must be Ok(())");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn serve_accepts_multiple_sequential_connections() {
        use tokio::net::UnixListener;

        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("serve.sock");
        let listener = UnixListener::bind(&path).unwrap();
        let registry = Arc::new(PlaceholderRegistry);
        let serve_task = tokio::spawn({
            let registry = registry.clone();
            async move { serve_unix(listener, registry, None).await }
        });

        for i in 0..3 {
            let client = tokio::net::UnixStream::connect(&path).await.unwrap();
            let (r, mut w) = tokio::io::split(client);
            let mut reader = BufReader::new(r);
            let req = json!({
                "jsonrpc": "2.0",
                "id": i,
                "method": "tools/list",
            });
            send_line(&mut w, &req).await;
            let mut buf = String::new();
            reader.read_line(&mut buf).await.unwrap();
            let resp: Value = serde_json::from_str(buf.trim_end()).unwrap();
            assert_eq!(resp["id"], i, "id echoed for connection {i}");
        }

        serve_task.abort();
    }

    #[test]
    fn parse_request_accepts_numeric_id() {
        match parse_request(r#"{"jsonrpc":"2.0","id":7,"method":"x"}"#) {
            ParsedRequest::Ok(req) => {
                assert_eq!(req.id, json!(7));
                assert_eq!(req.method, "x");
            }
            other => panic!("expected Ok request, got {other:?}"),
        }
    }

    #[test]
    fn parse_request_accepts_string_id() {
        match parse_request(r#"{"jsonrpc":"2.0","id":"abc","method":"x"}"#) {
            ParsedRequest::Ok(req) => assert_eq!(req.id, json!("abc")),
            other => panic!("expected Ok request, got {other:?}"),
        }
    }

    #[test]
    fn parse_request_treats_missing_id_as_notification() {
        match parse_request(r#"{"jsonrpc":"2.0","method":"notifications/x"}"#) {
            ParsedRequest::Notification(n) => assert_eq!(n.method, "notifications/x"),
            other => panic!("expected notification, got {other:?}"),
        }
    }

    #[test]
    fn parse_request_rejects_non_object_root() {
        match parse_request("[1,2,3]") {
            ParsedRequest::Err(envelope) => {
                assert_eq!(envelope["error"]["code"], JSONRPC_INVALID_REQUEST);
            }
            other => panic!("expected error, got {other:?}"),
        }
    }

    #[test]
    fn parse_request_emits_parse_error_for_garbage() {
        match parse_request("not json") {
            ParsedRequest::Err(envelope) => {
                assert_eq!(envelope["error"]["code"], JSONRPC_PARSE_ERROR);
                assert_eq!(envelope["id"], Value::Null);
            }
            other => panic!("expected parse error, got {other:?}"),
        }
    }

    // Debug impl for ParsedRequest used by test assertions.
    impl std::fmt::Debug for ParsedRequest {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            match self {
                ParsedRequest::Ok(req) => write!(f, "Ok({:?})", req.method),
                ParsedRequest::Err(env) => write!(f, "Err({env})"),
                ParsedRequest::Notification(n) => write!(f, "Notification({:?})", n.method),
            }
        }
    }

    // -----------------------------------------------------------------
    // ToolRegistry integration tests (FEAT-4b)
    //
    // These exercise the real dispatch pipeline: the server calls
    // `registry.list_tools()` for tools/list, and `registry.call_tool()`
    // (wrapped in ACTOR.scope) for tools/call. The test registry captures
    // the observed inputs so the test can assert on them after the call.
    // -----------------------------------------------------------------

    use std::sync::Mutex;

    /// Scripted registry that returns a fixed tool list for `list_tools`
    /// and records every `call_tool` invocation — including the
    /// [`Actor`] discriminant observed inside the task-local scope —
    /// into a shared buffer.
    #[derive(Default)]
    struct RecordingRegistry {
        tools: Vec<ToolDescription>,
        /// (tool_name, args, observed_actor_name, observed_request_id)
        calls: Mutex<Vec<(String, Value, String, String)>>,
        /// What `call_tool` returns. Defaults to a canned success value.
        response: Mutex<Option<Result<Value, AppError>>>,
    }

    impl RecordingRegistry {
        fn new(tools: Vec<ToolDescription>) -> Self {
            Self {
                tools,
                calls: Mutex::new(Vec::new()),
                response: Mutex::new(None),
            }
        }

        fn set_response(&self, response: Result<Value, AppError>) {
            *self.response.lock().unwrap() = Some(response);
        }

        fn calls(&self) -> Vec<(String, Value, String, String)> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl ToolRegistry for RecordingRegistry {
        fn list_tools(&self) -> Vec<ToolDescription> {
            self.tools.clone()
        }

        async fn call_tool(
            &self,
            name: &str,
            args: Value,
            ctx: &ActorContext,
        ) -> Result<Value, AppError> {
            // Observe the task-local via the canonical accessor so we
            // prove the server wrapped the call in ACTOR.scope(...) and
            // didn't just pass `ctx` by parameter. The parameter and the
            // task-local must agree.
            let actor_from_taskclocal = crate::mcp::actor::current_actor();
            let param_name = match &ctx.actor {
                Actor::Agent { name } => name.clone(),
                Actor::User => "<user>".to_string(),
            };
            let scoped_name = match actor_from_taskclocal {
                Actor::Agent { name } => name,
                Actor::User => "<user-no-scope>".to_string(),
            };
            // The param and the task-local must agree; if not, fail
            // loudly so the test surfaces the bug.
            assert_eq!(
                param_name, scoped_name,
                "ctx.actor must match ACTOR task-local during call_tool",
            );

            self.calls.lock().unwrap().push((
                name.to_string(),
                args,
                param_name,
                ctx.request_id.clone(),
            ));

            self.response
                .lock()
                .unwrap()
                .take()
                .unwrap_or_else(|| Ok(json!({"ok": true})))
        }
    }

    #[cfg(unix)]
    async fn connect_pair_with_registry<R: ToolRegistry + 'static>(
        socket_path: &std::path::Path,
        registry: Arc<R>,
    ) -> (tokio::net::UnixStream, tokio::task::JoinHandle<()>) {
        use tokio::net::{UnixListener, UnixStream};
        let listener = UnixListener::bind(socket_path).unwrap();
        let accept_task = tokio::spawn(async move {
            let (server_side, _) = listener.accept().await.unwrap();
            let _ = handle_connection(server_side, registry.as_ref(), None).await;
        });
        let client = UnixStream::connect(socket_path).await.unwrap();
        (client, accept_task)
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn tools_list_dispatches_through_registry() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("list.sock");
        let registry = Arc::new(RecordingRegistry::new(vec![
            ToolDescription {
                name: "t1".to_string(),
                description: "first".to_string(),
                input_schema: json!({"type": "object"}),
            },
            ToolDescription {
                name: "t2".to_string(),
                description: "second".to_string(),
                input_schema: json!({"type": "object"}),
            },
        ]));
        let (client, task) = connect_pair_with_registry(&path, registry.clone()).await;
        let (r, mut w) = tokio::io::split(client);
        let mut reader = BufReader::new(r);

        send_line(
            &mut w,
            &json!({"jsonrpc": "2.0", "id": 11, "method": "tools/list"}),
        )
        .await;

        let response = read_line(&mut reader).await;
        assert_eq!(response["id"], 11);
        let tools = response["result"]["tools"].as_array().expect("tools array");
        assert_eq!(tools.len(), 2, "registry returned two tools");
        assert_eq!(tools[0]["name"], "t1");
        assert_eq!(tools[1]["name"], "t2");
        // Verify camelCase `inputSchema` shipped on the wire (not
        // `input_schema`) — matches the MCP spec.
        assert!(
            tools[0].get("inputSchema").is_some(),
            "tool description must serialise with MCP-canonical `inputSchema` key",
        );

        drop(w);
        drop(reader);
        let _ = task.await;
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn tools_call_scopes_actor_context_to_client_name() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("call.sock");
        let registry = Arc::new(RecordingRegistry::new(Vec::new()));
        let (client, task) = connect_pair_with_registry(&path, registry.clone()).await;
        let (r, mut w) = tokio::io::split(client);
        let mut reader = BufReader::new(r);

        // Complete the handshake so the server captures clientInfo.name.
        send_line(
            &mut w,
            &json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2024-11-05",
                    "clientInfo": {"name": "my-agent", "version": "9.9"},
                    "capabilities": {},
                },
            }),
        )
        .await;
        let _ = read_line(&mut reader).await;

        // Now issue a tools/call — the registry should observe
        // Actor::Agent { name: "my-agent" }.
        send_line(
            &mut w,
            &json!({
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {
                    "name": "some-tool",
                    "arguments": {"q": "hello"},
                },
            }),
        )
        .await;
        let response = read_line(&mut reader).await;
        assert_eq!(response["id"], 2);
        assert_eq!(response["result"], json!({"ok": true}));

        let calls = registry.calls();
        assert_eq!(calls.len(), 1, "exactly one call_tool invocation");
        let (name, args, actor_name, request_id) = &calls[0];
        assert_eq!(name, "some-tool");
        assert_eq!(args, &json!({"q": "hello"}));
        assert_eq!(
            actor_name, "my-agent",
            "ACTOR scope must carry clientInfo.name into call_tool",
        );
        assert!(
            !request_id.is_empty(),
            "server must stamp a non-empty request_id",
        );

        drop(w);
        drop(reader);
        let _ = task.await;
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn tools_call_without_handshake_uses_unknown_agent_name() {
        // Some test harnesses (and our own stub binary smoke test) issue
        // tools/* before initialize. The server must still scope an
        // Actor::Agent with a fallback name rather than panic or leak
        // Actor::User.
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("no-handshake.sock");
        let registry = Arc::new(RecordingRegistry::new(Vec::new()));
        let (client, task) = connect_pair_with_registry(&path, registry.clone()).await;
        let (r, mut w) = tokio::io::split(client);
        let mut reader = BufReader::new(r);

        send_line(
            &mut w,
            &json!({
                "jsonrpc": "2.0",
                "id": 5,
                "method": "tools/call",
                "params": {"name": "ping", "arguments": {}},
            }),
        )
        .await;
        let response = read_line(&mut reader).await;
        assert_eq!(response["id"], 5);

        let calls = registry.calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(
            calls[0].2, "unknown",
            "tools/call without initialize must fall back to Agent {{ name: \"unknown\" }}",
        );

        drop(w);
        drop(reader);
        let _ = task.await;
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn tools_call_maps_registry_not_found_to_32601() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("nf.sock");
        let registry = Arc::new(RecordingRegistry::new(Vec::new()));
        registry.set_response(Err(AppError::NotFound("unknown tool `x`".into())));
        let (client, task) = connect_pair_with_registry(&path, registry.clone()).await;
        let (r, mut w) = tokio::io::split(client);
        let mut reader = BufReader::new(r);

        send_line(
            &mut w,
            &json!({
                "jsonrpc": "2.0",
                "id": 6,
                "method": "tools/call",
                "params": {"name": "x", "arguments": {}},
            }),
        )
        .await;
        let response = read_line(&mut reader).await;
        assert_eq!(response["error"]["code"], JSONRPC_METHOD_NOT_FOUND);
        assert!(
            response["error"]["message"]
                .as_str()
                .unwrap_or("")
                .contains("unknown tool"),
            "error message should echo the AppError::NotFound body",
        );

        drop(w);
        drop(reader);
        let _ = task.await;
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn tools_call_maps_registry_validation_to_32602() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("val.sock");
        let registry = Arc::new(RecordingRegistry::new(Vec::new()));
        registry.set_response(Err(AppError::Validation("missing field `query`".into())));
        let (client, task) = connect_pair_with_registry(&path, registry.clone()).await;
        let (r, mut w) = tokio::io::split(client);
        let mut reader = BufReader::new(r);

        send_line(
            &mut w,
            &json!({
                "jsonrpc": "2.0",
                "id": 7,
                "method": "tools/call",
                "params": {"name": "search", "arguments": {}},
            }),
        )
        .await;
        let response = read_line(&mut reader).await;
        assert_eq!(response["error"]["code"], JSONRPC_INVALID_PARAMS);

        drop(w);
        drop(reader);
        let _ = task.await;
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn tools_call_with_missing_name_returns_invalid_params() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("missing-name.sock");
        let registry = Arc::new(RecordingRegistry::new(Vec::new()));
        let (client, task) = connect_pair_with_registry(&path, registry.clone()).await;
        let (r, mut w) = tokio::io::split(client);
        let mut reader = BufReader::new(r);

        send_line(
            &mut w,
            &json!({
                "jsonrpc": "2.0",
                "id": 9,
                "method": "tools/call",
                "params": {"arguments": {}},
            }),
        )
        .await;
        let response = read_line(&mut reader).await;
        assert_eq!(
            response["error"]["code"], JSONRPC_INVALID_PARAMS,
            "missing `name` field must yield -32602",
        );
        assert_eq!(
            registry.calls().len(),
            0,
            "registry.call_tool must not be invoked when `name` is missing",
        );

        drop(w);
        drop(reader);
        let _ = task.await;
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn tools_call_each_invocation_gets_fresh_request_id() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("reqid.sock");
        let registry = Arc::new(RecordingRegistry::new(Vec::new()));
        let (client, task) = connect_pair_with_registry(&path, registry.clone()).await;
        let (r, mut w) = tokio::io::split(client);
        let mut reader = BufReader::new(r);

        for i in 0..3 {
            send_line(
                &mut w,
                &json!({
                    "jsonrpc": "2.0",
                    "id": 100 + i,
                    "method": "tools/call",
                    "params": {"name": "t", "arguments": {}},
                }),
            )
            .await;
            let _ = read_line(&mut reader).await;
        }

        let calls = registry.calls();
        assert_eq!(calls.len(), 3);
        let request_ids: std::collections::HashSet<&str> =
            calls.iter().map(|c| c.3.as_str()).collect();
        assert_eq!(
            request_ids.len(),
            3,
            "each tools/call must receive a unique request_id; got {:?}",
            calls.iter().map(|c| c.3.clone()).collect::<Vec<_>>(),
        );

        drop(w);
        drop(reader);
        let _ = task.await;
    }

    // -----------------------------------------------------------------
    // FEAT-4d integration — ConnectionState carries the activity ring /
    // emitter seam, and the `emit_tool_completion` helper is the path
    // FEAT-4c will call after a successful `tools/call` dispatch.
    // -----------------------------------------------------------------

    #[test]
    fn connection_state_default_has_no_activity_ctx() {
        // FEAT-4a's existing tests pass `None` for activity; the default
        // state must reflect that so a missing ring never panics.
        let state = ConnectionState::default();
        assert!(state.activity_ctx.is_none());
    }

    #[tokio::test]
    async fn handle_connection_accepts_activity_ctx_without_emitting_on_placeholder_tools_call() {
        // Spec invariant: the placeholder `tools/call` returns -32601 and
        // MUST NOT record activity — only real tool invocations (FEAT-4c)
        // should emit. Exercise the full dispatch path with an activity
        // context attached and assert the recorder stays empty.
        use super::super::activity::{ActivityContext, ActivityRing, RecordingEmitter};
        use std::sync::Mutex;

        let ring = Arc::new(Mutex::new(ActivityRing::new()));
        let emitter = Arc::new(RecordingEmitter::new());
        let ctx = ActivityContext::new(ring.clone(), emitter.clone());

        let (mut client, server) = tokio::io::duplex(1024);
        let task = tokio::spawn(async move {
            let registry = PlaceholderRegistry;
            handle_connection(server, &registry, Some(ctx)).await
        });

        // Drive initialize + tools/call and read each response so the
        // handler can make forward progress before we close the stream.
        let (cr, mut cw) = tokio::io::split(&mut client);
        let mut reader = BufReader::new(cr);
        send_line(
            &mut cw,
            &json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": MCP_PROTOCOL_VERSION,
                    "clientInfo": { "name": "test", "version": "0" },
                }
            }),
        )
        .await;
        let _init_resp = read_line(&mut reader).await;

        send_line(
            &mut cw,
            &json!({
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": { "name": "search", "arguments": {} },
            }),
        )
        .await;
        let tools_call_resp = read_line(&mut reader).await;
        assert_eq!(
            tools_call_resp["error"]["code"], JSONRPC_METHOD_NOT_FOUND,
            "FEAT-4a placeholder still returns -32601",
        );

        // Close the client side → handler observes EOF and returns Ok(()).
        drop(cw);
        drop(reader);
        drop(client);
        task.await.unwrap().expect("handle_connection Ok");

        assert_eq!(
            emitter.len(),
            0,
            "placeholder -32601 must not emit activity; FEAT-4c wires the real tool dispatch",
        );
        assert_eq!(
            ring.lock().unwrap().len(),
            0,
            "ring stays empty until a real tool is invoked",
        );
    }

    #[test]
    fn emit_tool_completion_via_activity_ctx_records_exactly_once() {
        // FEAT-4c integration shape: after a successful tool dispatch,
        // the handler will call `emit_tool_completion` with the ctx held
        // in `ConnectionState.activity_ctx`. This test drives that path
        // directly so the wiring is verified before FEAT-4c lands.
        use super::super::activity::{
            emit_tool_completion, ActivityContext, ActivityEmitter, ActivityResult, ActivityRing,
            ActorKind, RecordingEmitter,
        };
        use std::sync::Mutex;

        let ring = Arc::new(Mutex::new(ActivityRing::new()));
        // Keep a typed handle for assertions; clone into a trait-object
        // Arc for the ctx so the seam matches the production shape
        // (`Arc<dyn ActivityEmitter>`).
        let recorder = Arc::new(RecordingEmitter::new());
        let emitter: Arc<dyn ActivityEmitter> = recorder.clone();
        let ctx = ActivityContext::new(ring.clone(), emitter);

        let state = ConnectionState {
            activity_ctx: Some(ctx),
            ..ConnectionState::default()
        };
        let ctx_ref = state
            .activity_ctx
            .as_ref()
            .expect("activity_ctx present on state");

        emit_tool_completion(
            ctx_ref,
            "search",
            "searched for '…' (0 results)",
            ActorKind::Agent,
            Some("claude-desktop".to_string()),
            ActivityResult::Ok,
        );

        assert_eq!(
            ring.lock().unwrap().len(),
            1,
            "ring captured one entry via the server-side ctx",
        );
        assert_eq!(
            recorder.len(),
            1,
            "exactly one `mcp:activity` emission per tool completion",
        );
        let entry = recorder.entries().into_iter().next().unwrap();
        assert_eq!(entry.tool_name, "search");
        assert_eq!(entry.actor_kind, ActorKind::Agent);
        assert_eq!(entry.agent_name.as_deref(), Some("claude-desktop"));
    }
}
