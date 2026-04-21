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

use super::SocketKind;
use crate::error::AppError;

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
// Tool registry placeholder
// ---------------------------------------------------------------------------

/// Marker trait for a registry of MCP tools. FEAT-4b replaces this with a
/// real trait that carries `list_tools()` + `call_tool()` methods; FEAT-4a
/// only needs the type parameter so the server can be generic from day one.
pub trait ToolRegistry: Send + Sync {}

/// No-op registry used until FEAT-4b lands. Exposes zero tools so
/// `tools/list` returns `[]` and `tools/call` always yields
/// `-32601 Method not found`.
#[derive(Default, Debug, Clone, Copy)]
pub struct PlaceholderRegistry;

impl ToolRegistry for PlaceholderRegistry {}

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
#[derive(Debug, Default)]
pub struct ConnectionState {
    pub client_info: Option<ClientInfo>,
    pub protocol_version: Option<String>,
    pub initialized: bool,
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

fn handle_tools_list() -> Result<Value, (i64, String)> {
    // FEAT-4c wires real tools through the registry; FEAT-4a always returns
    // an empty list so clients can complete the handshake and discover that
    // no tools are exposed yet.
    Ok(json!({ "tools": [] }))
}

fn handle_tools_call(params: &Value) -> Result<Value, (i64, String)> {
    let name = params
        .get("name")
        .and_then(|n| n.as_str())
        .unwrap_or("<unknown>");
    Err((
        JSONRPC_METHOD_NOT_FOUND,
        format!("Tool `{name}` not found (no tools registered in FEAT-4a)"),
    ))
}

fn dispatch<R: ToolRegistry>(
    state: &mut ConnectionState,
    method: &str,
    params: &Value,
    _registry: &R,
) -> Result<Value, (i64, String)> {
    match method {
        "initialize" => handle_initialize(state, params),
        "tools/list" => handle_tools_list(),
        "tools/call" => handle_tools_call(params),
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
pub async fn handle_connection<S, R>(stream: S, registry: &R) -> Result<(), AppError>
where
    S: AsyncRead + AsyncWrite + Unpin,
    R: ToolRegistry,
{
    let (read_half, mut write_half) = tokio::io::split(stream);
    let mut reader = BufReader::new(read_half);
    let mut state = ConnectionState::default();
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
                match dispatch(&mut state, &req.method, &req.params, registry) {
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
pub async fn serve<R>(socket: SocketKind, registry: std::sync::Arc<R>) -> Result<(), AppError>
where
    R: ToolRegistry + Send + Sync + 'static,
{
    match socket {
        #[cfg(unix)]
        SocketKind::Unix(listener) => serve_unix(listener, registry).await,
        #[cfg(windows)]
        SocketKind::Pipe(server) => serve_pipe(server, registry).await,
    }
}

#[cfg(unix)]
async fn serve_unix<R>(
    listener: tokio::net::UnixListener,
    registry: std::sync::Arc<R>,
) -> Result<(), AppError>
where
    R: ToolRegistry + Send + Sync + 'static,
{
    loop {
        let (stream, _addr) = listener.accept().await?;
        let registry = registry.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_connection(stream, registry.as_ref()).await {
                tracing::warn!(target: "mcp", error = %e, "MCP connection ended with error");
            }
        });
    }
}

#[cfg(windows)]
async fn serve_pipe<R>(
    mut server: tokio::net::windows::named_pipe::NamedPipeServer,
    registry: std::sync::Arc<R>,
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
        tokio::spawn(async move {
            if let Err(e) = handle_connection(connected, registry.as_ref()).await {
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
            let _ = handle_connection(server_side, &registry).await;
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
        handle_connection(server, &registry)
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
            async move { serve_unix(listener, registry).await }
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
}
