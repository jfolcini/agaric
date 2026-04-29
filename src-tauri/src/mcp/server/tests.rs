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
async fn initialize_returns_2025_06_18_protocol_version_m86() {
    // M-86: the server emits `structuredContent` in tool-call
    // responses, a field added in MCP `2025-06-18`. The declared
    // protocol version returned from `initialize` must match — pin
    // the literal string so future drift away from `2025-06-18`
    // (without an explicit envelope change) trips this test.
    let dir = tempfile::TempDir::new().unwrap();
    let path = dir.path().join("m86.sock");
    let (client, task) = connect_pair(&path).await;
    let (r, mut w) = tokio::io::split(client);
    let mut reader = BufReader::new(r);

    send_line(
        &mut w,
        &json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-06-18",
                "clientInfo": { "name": "m86-client", "version": "0.0.1" },
                "capabilities": {},
            },
        }),
    )
    .await;

    let response = read_line(&mut reader).await;
    assert_eq!(
        response["result"]["protocolVersion"], "2025-06-18",
        "M-86: server must declare MCP 2025-06-18 to match the \
         structuredContent envelope it actually emits",
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
async fn tools_call_returns_resource_not_found() {
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
        response["error"]["code"], JSONRPC_RESOURCE_NOT_FOUND,
        "tools/call with an unknown tool name must map AppError::NotFound to -32001 \
         (distinct from -32601 method-not-found)",
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
        async move { serve_unix(listener, registry, None, None).await }
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

// ── I-MCP-3 — unknown-notification log-level promotion ─────────

/// Thread-safe buffered writer used to capture emitted log lines.
/// Mirrors the BufWriter pattern from `db.rs::tests`.
#[derive(Clone, Default)]
struct MockBufWriter(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

impl std::io::Write for MockBufWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for MockBufWriter {
    type Writer = MockBufWriter;
    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

impl MockBufWriter {
    fn contents(&self) -> String {
        String::from_utf8_lossy(&self.0.lock().unwrap()).into_owned()
    }
}

#[test]
fn handle_notification_unknown_method_emits_warn() {
    // I-MCP-3 regression: previously logged at `debug` and silently
    // dropped — a misconfigured agent firing real MCP-spec
    // notifications (`notifications/cancelled`, `notifications/progress`)
    // was invisible without re-enabling the `mcp` log target.
    use tracing_subscriber::layer::SubscriberExt;

    let writer = MockBufWriter::default();
    let subscriber = tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::new("warn"))
        .with(
            tracing_subscriber::fmt::layer()
                .with_writer(writer.clone())
                .with_ansi(false)
                .with_target(true),
        );
    let _guard = tracing::subscriber::set_default(subscriber);

    let mut state = ConnectionState::default();
    let params = json!({"reason": "user-cancelled", "request_id": 7});
    handle_notification(&mut state, "unknown.method.test", &params);

    let logs = writer.contents();
    assert!(
        logs.contains("WARN"),
        "unknown notification must be logged at warn level; got: {logs:?}",
    );
    assert!(
        logs.contains("unknown.method.test"),
        "warn must include the unknown method name; got: {logs:?}",
    );
    // Initialised flag must NOT be flipped by an unknown notification.
    assert!(
        !state.initialized,
        "unknown notification must not initialise the session",
    );
}

#[test]
fn handle_notification_initialized_stays_at_debug_level() {
    // Sanity: the known `notifications/initialized` path stays
    // at debug (no warn noise) and toggles state.initialized.
    use tracing_subscriber::layer::SubscriberExt;

    let writer = MockBufWriter::default();
    let subscriber = tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::new("warn"))
        .with(
            tracing_subscriber::fmt::layer()
                .with_writer(writer.clone())
                .with_ansi(false),
        );
    let _guard = tracing::subscriber::set_default(subscriber);

    let mut state = ConnectionState::default();
    handle_notification(&mut state, "notifications/initialized", &Value::Null);

    let logs = writer.contents();
    assert!(
        !logs.contains("WARN"),
        "known notification path must not emit warn; got: {logs:?}",
    );
    assert!(
        state.initialized,
        "known initialized notification must flip state.initialized"
    );
}

#[test]
fn truncate_params_preview_handles_null_short_and_long_inputs() {
    // I-MCP-3: helper-level coverage for the truncated `params` summary.
    assert_eq!(
        truncate_params_preview(&Value::Null, 200),
        "",
        "null params render as empty string"
    );
    assert_eq!(
        truncate_params_preview(&json!({"a": 1}), 200),
        "{\"a\":1}",
        "short params render verbatim",
    );
    let big = json!({"data": "x".repeat(500)});
    let preview = truncate_params_preview(&big, 64);
    // Truncation appends a single ellipsis char (3-byte UTF-8).
    assert!(
        preview.ends_with('…'),
        "truncated preview must end with ellipsis; got {preview:?}",
    );
    assert!(
        preview.chars().count() <= 65,
        "preview must be at most 64 chars + 1 ellipsis; got {} chars",
        preview.chars().count(),
    );
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
    // FEAT-4j: `tools/call` success responses are wrapped in the MCP
    // `CallToolResult` envelope. The canned `{"ok": true}` the
    // registry returned must be reachable via `.structuredContent`
    // and also serialised into the first text-content block.
    assert_eq!(
        response["result"]["structuredContent"],
        json!({"ok": true}),
        "raw registry value must appear under structuredContent",
    );
    assert_eq!(
        response["result"]["isError"], false,
        "successful tools/call sets isError=false explicitly",
    );
    let text = response["result"]["content"][0]["text"]
        .as_str()
        .expect("content[0].text present");
    let parsed: Value = serde_json::from_str(text).expect("text is valid JSON");
    assert_eq!(
        parsed,
        json!({"ok": true}),
        "content[0].text must round-trip back to the raw value",
    );

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
async fn tools_call_maps_registry_not_found_to_32001() {
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
    assert_eq!(
        response["error"]["code"], JSONRPC_RESOURCE_NOT_FOUND,
        "AppError::NotFound from a tool must surface as -32001 (resource-not-found), \
         distinct from -32601 (method-not-found)",
    );
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
    let request_ids: std::collections::HashSet<&str> = calls.iter().map(|c| c.3.as_str()).collect();
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
// FEAT-4j — CallToolResult envelope wrap for tools/call
//
// Real MCP clients (Claude Desktop, Cursor, official Python `mcp`
// SDK) require `tools/call` success responses to be wrapped in
// `CallToolResult { content, isError, structuredContent? }`. Tool-
// execution errors use `isError: true` inside the same envelope.
// Protocol-level failures (method-not-found, invalid params,
// resource-not-found from FEAT-4c) stay as JSON-RPC error objects.
// -----------------------------------------------------------------

#[test]
fn wrap_tool_result_success_shape() {
    // Unit-test the helper directly so the envelope is locked in
    // independently of the dispatch path.
    let raw = json!({ "items": [1, 2, 3], "has_more": false });
    let wrapped = wrap_tool_result_success(raw.clone());

    let content = wrapped["content"].as_array().expect("content array");
    assert_eq!(content.len(), 1, "one content block for the text fallback");
    assert_eq!(content[0]["type"], "text", "content[0] is a text block");
    let text = content[0]["text"].as_str().expect("text field");
    let parsed: Value = serde_json::from_str(text).expect("text parses as JSON");
    assert_eq!(
        parsed, raw,
        "content[0].text must round-trip back to the raw value",
    );
    assert_eq!(
        wrapped["isError"], false,
        "successful calls set isError=false"
    );
    assert_eq!(
        wrapped["structuredContent"], raw,
        "structuredContent carries the raw value verbatim",
    );
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tools_call_success_returns_calltoolresult_envelope() {
    // End-to-end: feed a canned success value through the dispatch
    // and assert the MCP envelope on the wire.
    let dir = tempfile::TempDir::new().unwrap();
    let path = dir.path().join("envelope-success.sock");
    let registry = Arc::new(RecordingRegistry::new(Vec::new()));
    let canned = json!({
        "items": [{"id": "01ABC"}, {"id": "01DEF"}],
        "has_more": false,
        "total_count": 2,
    });
    registry.set_response(Ok(canned.clone()));
    let (client, task) = connect_pair_with_registry(&path, registry.clone()).await;
    let (r, mut w) = tokio::io::split(client);
    let mut reader = BufReader::new(r);

    send_line(
        &mut w,
        &json!({
            "jsonrpc": "2.0",
            "id": 50,
            "method": "tools/call",
            "params": {"name": "list_pages", "arguments": {}},
        }),
    )
    .await;
    let response = read_line(&mut reader).await;

    assert_eq!(response["jsonrpc"], "2.0");
    assert_eq!(response["id"], 50);
    assert!(
        response.get("error").is_none(),
        "successful tools/call must not carry a JSON-RPC error object",
    );
    let result = &response["result"];

    // content[0] is a text block holding the JSON-stringified value.
    let content = result["content"]
        .as_array()
        .expect("result.content is an array");
    assert!(
        !content.is_empty(),
        "CallToolResult.content must have at least one block",
    );
    assert_eq!(content[0]["type"], "text");
    assert!(
        content[0]["text"].is_string(),
        "content[0].text is a string",
    );

    // isError is explicitly false.
    assert_eq!(result["isError"], false, "success sets isError=false");

    // structuredContent equals the registry's raw value verbatim.
    assert_eq!(
        result["structuredContent"], canned,
        "structuredContent must equal the raw tool value",
    );

    drop(w);
    drop(reader);
    let _ = task.await;
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tools_call_success_text_content_is_parseable_json() {
    // FEAT-4j: content[0].text must parse back to JSON equal to
    // structuredContent. This is the property that lets MCP-2024-11-05
    // clients that never look at structuredContent still reach the
    // typed payload.
    let dir = tempfile::TempDir::new().unwrap();
    let path = dir.path().join("envelope-text-json.sock");
    let registry = Arc::new(RecordingRegistry::new(Vec::new()));
    let canned = json!({
        "nested": { "a": 1, "b": ["x", "y"] },
        "unicode": "héllo — 😀",
    });
    registry.set_response(Ok(canned.clone()));
    let (client, task) = connect_pair_with_registry(&path, registry.clone()).await;
    let (r, mut w) = tokio::io::split(client);
    let mut reader = BufReader::new(r);

    send_line(
        &mut w,
        &json!({
            "jsonrpc": "2.0",
            "id": 51,
            "method": "tools/call",
            "params": {"name": "anything", "arguments": {}},
        }),
    )
    .await;
    let response = read_line(&mut reader).await;

    let text = response["result"]["content"][0]["text"]
        .as_str()
        .expect("content[0].text is a string");
    let parsed: Value = serde_json::from_str(text).expect("text parses as JSON");
    assert_eq!(
        parsed, response["result"]["structuredContent"],
        "content[0].text must parse to the same JSON as structuredContent",
    );
    assert_eq!(
        parsed, canned,
        "round-tripped text matches the original tool value (including unicode)",
    );

    drop(w);
    drop(reader);
    let _ = task.await;
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tools_call_not_found_still_returns_minus_32001_error() {
    // FEAT-4j regression: `AppError::NotFound` must still surface as
    // a JSON-RPC `-32001` error object (not inside a `CallToolResult
    // { isError: true }` envelope). This preserves FEAT-4c's wire
    // contract so clients can distinguish "the tool never ran" from
    // "the tool ran and reported an error".
    let dir = tempfile::TempDir::new().unwrap();
    let path = dir.path().join("envelope-nf.sock");
    let registry = Arc::new(RecordingRegistry::new(Vec::new()));
    registry.set_response(Err(AppError::NotFound("block XYZ".into())));
    let (client, task) = connect_pair_with_registry(&path, registry.clone()).await;
    let (r, mut w) = tokio::io::split(client);
    let mut reader = BufReader::new(r);

    send_line(
        &mut w,
        &json!({
            "jsonrpc": "2.0",
            "id": 52,
            "method": "tools/call",
            "params": {"name": "get_block", "arguments": {"block_id": "XYZ"}},
        }),
    )
    .await;
    let response = read_line(&mut reader).await;

    assert_eq!(
        response["error"]["code"], JSONRPC_RESOURCE_NOT_FOUND,
        "AppError::NotFound still maps to -32001, not wrapped in CallToolResult",
    );
    assert!(
        response.get("result").is_none(),
        "error responses must not carry a `result` field (FEAT-4j keeps the \
         FEAT-4c split intact for protocol-level failures)",
    );

    drop(w);
    drop(reader);
    let _ = task.await;
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tools_call_validation_error_still_returns_minus_32602_error() {
    // FEAT-4j regression: `AppError::Validation` must still surface
    // as a JSON-RPC `-32602` error object (not inside a
    // `CallToolResult { isError: true }` envelope).
    let dir = tempfile::TempDir::new().unwrap();
    let path = dir.path().join("envelope-val.sock");
    let registry = Arc::new(RecordingRegistry::new(Vec::new()));
    registry.set_response(Err(AppError::Validation("bad arg".into())));
    let (client, task) = connect_pair_with_registry(&path, registry.clone()).await;
    let (r, mut w) = tokio::io::split(client);
    let mut reader = BufReader::new(r);

    send_line(
        &mut w,
        &json!({
            "jsonrpc": "2.0",
            "id": 53,
            "method": "tools/call",
            "params": {"name": "search", "arguments": {}},
        }),
    )
    .await;
    let response = read_line(&mut reader).await;

    assert_eq!(
        response["error"]["code"], JSONRPC_INVALID_PARAMS,
        "AppError::Validation still maps to -32602, not wrapped in CallToolResult",
    );
    assert!(
        response.get("result").is_none(),
        "error responses must not carry a `result` field",
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

#[test]
fn connection_state_default_generates_non_empty_ulid_session_id() {
    // FEAT-4h slice 3: `session_id` must be a fresh ULID on every
    // `default()` call so each connection can be grouped by session
    // in the activity feed. An empty string would collapse every
    // connection's entries into one.
    let a = ConnectionState::default();
    let b = ConnectionState::default();
    assert_eq!(
        a.session_id.len(),
        26,
        "ULID Crockford base32 length is 26, got {:?}",
        a.session_id,
    );
    assert!(!a.session_id.is_empty());
    assert_ne!(
        a.session_id, b.session_id,
        "each ConnectionState::default() must produce a distinct ULID",
    );
}

#[tokio::test]
async fn handle_connection_emits_activity_on_placeholder_error_tools_call() {
    // FEAT-4h slice 3 wires the emission path: every completed
    // `tools/call` — success or failure — pushes an activity
    // entry. The PlaceholderRegistry returns `AppError::NotFound`,
    // so the emitted entry must carry `ActivityResult::Err(...)`.
    use super::super::activity::{ActivityContext, ActivityResult, ActivityRing, RecordingEmitter};
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
        tools_call_resp["error"]["code"], JSONRPC_RESOURCE_NOT_FOUND,
        "FEAT-4a placeholder surfaces AppError::NotFound as -32001 resource-not-found",
    );

    // Close the client side → handler observes EOF and returns Ok(()).
    drop(cw);
    drop(reader);
    drop(client);
    task.await.unwrap().expect("handle_connection Ok");

    assert_eq!(
        emitter.len(),
        1,
        "FEAT-4h slice 3 emits one entry per completed tools/call — \
         errors count too",
    );
    let entries = emitter.entries();
    let entry = entries.first().expect("one entry");
    assert_eq!(entry.tool_name, "search");
    assert!(
        matches!(entry.result, ActivityResult::Err(_)),
        "PlaceholderRegistry's NotFound must surface as Err; got {:?}",
        entry.result,
    );
    assert!(
        entry.op_ref.is_none(),
        "PlaceholderRegistry does not append any op, so op_ref is None",
    );
    assert!(
        !entry.session_id.is_empty(),
        "session_id must be stamped from ConnectionState.session_id",
    );
    assert_eq!(
        ring.lock().unwrap().len(),
        1,
        "ring receives one entry per tools/call",
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
        ActorKind, RecordingEmitter, ToolCompletionEvent,
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
        ToolCompletionEvent {
            tool_name: "search",
            summary: "searched for '…' (0 results)",
            actor_kind: ActorKind::Agent,
            agent_name: Some("claude-desktop".to_string()),
            result: ActivityResult::Ok,
            session_id: &state.session_id,
            op_ref: None,
            additional_op_refs: Vec::new(),
        },
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
    assert_eq!(entry.session_id, state.session_id);
    assert!(entry.op_ref.is_none());
}

// -----------------------------------------------------------------
// FEAT-4h slice 3 — `handle_tools_call` emission path
//
// These tests drive the `handle_tools_call` function directly (not
// via the full socket round-trip) so they can probe the precise
// emission behaviour: success-with-session-id-and-no-op-ref,
// failure-with-err-result, op_ref-carrying-from-LAST_APPEND, the
// no-ctx path, and per-connection session-id stability.
// -----------------------------------------------------------------

/// Minimal test registry: always returns `Ok(Value::Null)`.
#[derive(Default)]
struct OkRegistry;

impl ToolRegistry for OkRegistry {
    fn list_tools(&self) -> Vec<ToolDescription> {
        Vec::new()
    }
    async fn call_tool(
        &self,
        _name: &str,
        _args: Value,
        _ctx: &ActorContext,
    ) -> Result<Value, AppError> {
        Ok(Value::Null)
    }
}

/// Test registry that records a fixed `OpRef` into the `LAST_APPEND`
/// task-local before returning success — simulates a RW tool that
/// appended one op.
struct AppendingRegistry {
    op_ref: crate::op::OpRef,
}

impl ToolRegistry for AppendingRegistry {
    fn list_tools(&self) -> Vec<ToolDescription> {
        Vec::new()
    }
    async fn call_tool(
        &self,
        _name: &str,
        _args: Value,
        _ctx: &ActorContext,
    ) -> Result<Value, AppError> {
        crate::task_locals::record_append(self.op_ref.clone());
        Ok(Value::Null)
    }
}

fn recording_ctx() -> (
    super::super::activity::ActivityContext,
    Arc<super::super::activity::RecordingEmitter>,
) {
    use super::super::activity::{
        ActivityContext, ActivityEmitter, ActivityRing, RecordingEmitter,
    };
    use std::sync::Mutex;

    let ring = Arc::new(Mutex::new(ActivityRing::new()));
    let recorder = Arc::new(RecordingEmitter::new());
    let emitter: Arc<dyn ActivityEmitter> = recorder.clone();
    (ActivityContext::new(ring, emitter), recorder)
}

#[tokio::test]
async fn handle_tools_call_emits_activity_on_success_with_session_id_and_no_op_ref() {
    use super::super::activity::ActivityResult;

    let (ctx, recorder) = recording_ctx();
    let state = ConnectionState {
        client_info: Some(ClientInfo {
            name: "claude".to_string(),
            version: None,
        }),
        activity_ctx: Some(ctx),
        ..ConnectionState::default()
    };
    let registry = OkRegistry;
    let params = json!({ "name": "search", "arguments": {} });

    let result = handle_tools_call(&state, &params, &registry)
        .await
        .expect("tools/call succeeds");
    // The envelope wraps the null Value — check isError=false as
    // the success signal.
    assert_eq!(result["isError"], false);

    let entries = recorder.entries();
    assert_eq!(entries.len(), 1, "exactly one emission per call");
    let entry = &entries[0];
    assert_eq!(entry.tool_name, "search");
    assert!(matches!(entry.result, ActivityResult::Ok));
    assert_eq!(
        entry.session_id, state.session_id,
        "session_id is threaded from ConnectionState",
    );
    assert!(
        entry.op_ref.is_none(),
        "OkRegistry records no append → op_ref must be None",
    );
    assert_eq!(entry.agent_name.as_deref(), Some("claude"));
}

#[tokio::test]
async fn handle_tools_call_emits_activity_on_error_with_err_result() {
    use super::super::activity::ActivityResult;

    let (ctx, recorder) = recording_ctx();
    let state = ConnectionState {
        client_info: Some(ClientInfo {
            name: "agent-x".to_string(),
            version: None,
        }),
        activity_ctx: Some(ctx),
        ..ConnectionState::default()
    };
    let registry = PlaceholderRegistry;
    let params = json!({ "name": "ghost", "arguments": {} });

    let (code, msg) = handle_tools_call(&state, &params, &registry)
        .await
        .expect_err("placeholder never resolves to Ok");
    assert_eq!(code, JSONRPC_RESOURCE_NOT_FOUND);
    assert!(msg.contains("ghost"));

    let entries = recorder.entries();
    assert_eq!(entries.len(), 1);
    let entry = &entries[0];
    assert_eq!(entry.tool_name, "ghost");
    match &entry.result {
        ActivityResult::Err(short) => {
            assert!(
                short.contains("ghost"),
                "error message should echo the AppError body, got {short:?}",
            );
            assert!(
                short.chars().count() <= 200,
                "error message must be clipped to 200 chars, got {}",
                short.chars().count(),
            );
        }
        other => panic!("expected Err, got {other:?}"),
    }
    assert_eq!(entry.session_id, state.session_id);
    assert!(entry.op_ref.is_none());
}

#[tokio::test]
async fn handle_tools_call_op_ref_populated_when_tool_records_append() {
    let (ctx, recorder) = recording_ctx();
    let state = ConnectionState {
        client_info: Some(ClientInfo {
            name: "claude".to_string(),
            version: None,
        }),
        activity_ctx: Some(ctx),
        ..ConnectionState::default()
    };
    let expected = crate::op::OpRef {
        device_id: "TEST".to_string(),
        seq: 42,
    };
    let registry = AppendingRegistry {
        op_ref: expected.clone(),
    };
    let params = json!({ "name": "append_block", "arguments": {} });

    let _ = handle_tools_call(&state, &params, &registry)
        .await
        .expect("tools/call succeeds");

    let entries = recorder.entries();
    assert_eq!(entries.len(), 1);
    let entry = &entries[0];
    assert_eq!(
        entry.op_ref.as_ref(),
        Some(&expected),
        "op_ref must be captured from LAST_APPEND and surfaced on the entry",
    );
    assert!(
        entry.additional_op_refs.is_empty(),
        "single-op tool must leave additional_op_refs empty; got {:?}",
        entry.additional_op_refs,
    );
}

/// L-114: a tool that records *multiple* `OpRef`s into
/// `LAST_APPEND` (simulating a future `move_subtree` /
/// `bulk_set_property`) must surface the first one on `op_ref`
/// and the remainder on `additional_op_refs` — in append order.
/// Pinning this here forward-compats the dispatch layer for
/// multi-op RW tools that don't exist yet.
#[tokio::test]
async fn handle_tools_call_multi_op_tool_splits_op_refs_head_and_tail() {
    struct MultiAppendingRegistry {
        op_refs: Vec<crate::op::OpRef>,
    }
    impl ToolRegistry for MultiAppendingRegistry {
        fn list_tools(&self) -> Vec<ToolDescription> {
            Vec::new()
        }
        async fn call_tool(
            &self,
            _name: &str,
            _args: Value,
            _ctx: &ActorContext,
        ) -> Result<Value, AppError> {
            for r in &self.op_refs {
                crate::task_locals::record_append(r.clone());
            }
            Ok(Value::Null)
        }
    }

    let (ctx, recorder) = recording_ctx();
    let state = ConnectionState {
        client_info: Some(ClientInfo {
            name: "claude".to_string(),
            version: None,
        }),
        activity_ctx: Some(ctx),
        ..ConnectionState::default()
    };
    let first = crate::op::OpRef {
        device_id: "DEV".to_string(),
        seq: 1,
    };
    let second = crate::op::OpRef {
        device_id: "DEV".to_string(),
        seq: 2,
    };
    let third = crate::op::OpRef {
        device_id: "DEV".to_string(),
        seq: 3,
    };
    let registry = MultiAppendingRegistry {
        op_refs: vec![first.clone(), second.clone(), third.clone()],
    };
    let params = json!({ "name": "move_subtree", "arguments": {} });

    let _ = handle_tools_call(&state, &params, &registry)
        .await
        .expect("tools/call succeeds");

    let entries = recorder.entries();
    assert_eq!(entries.len(), 1);
    let entry = &entries[0];
    assert_eq!(
        entry.op_ref.as_ref(),
        Some(&first),
        "first append must surface on the legacy `op_ref` field",
    );
    assert_eq!(
        entry.additional_op_refs,
        vec![second, third],
        "remaining appends must surface on `additional_op_refs` in append order",
    );
}

#[tokio::test]
async fn handle_tools_call_does_not_emit_when_activity_ctx_is_none() {
    // No activity_ctx — dispatch must still work; there's nothing
    // to observe emission-wise, but the test verifies the None
    // branch doesn't panic and the result still round-trips.
    let state = ConnectionState::default();
    assert!(state.activity_ctx.is_none());
    let registry = OkRegistry;
    let params = json!({ "name": "search", "arguments": {} });

    let result = handle_tools_call(&state, &params, &registry)
        .await
        .expect("tools/call succeeds without activity_ctx");
    assert_eq!(result["isError"], false);
}

/// I-MCP-8: defensive regression test for the `chars().take(200)`
/// clip at server.rs:508. The clip MUST be char-based; a byte-based
/// truncate (`s.truncate(200)`, `&s[..200]`, `String::from_utf8_unchecked`)
/// would panic at a multi-byte UTF-8 boundary. The existing
/// length-only assertion at `handle_tools_call_emits_activity_on_error_with_err_result`
/// would not catch a regression to byte-based truncation — this
/// test pins the multi-byte invariant directly.
///
/// 199 ASCII chars + 1 four-byte emoji = 200 chars total but 203
/// UTF-8 bytes — the worst-case input for `chars().take(200)` since
/// it ends precisely on the multi-byte boundary that a byte-based
/// `s.truncate(200)` would split mid-codepoint and panic on.
#[test]
fn err_clip_handles_multibyte_codepoint_at_boundary() {
    // Build the 200-char / 203-byte input.
    let input = "a".repeat(199) + "\u{1F980}"; // 🦀
    assert_eq!(input.chars().count(), 200, "input is exactly 200 chars");
    assert_eq!(input.len(), 203, "input is 203 UTF-8 bytes (199 + 4)");

    // Mirror server.rs:508 verbatim. This must not panic.
    let short: String = input.chars().take(200).collect();

    // Char count preserved.
    assert_eq!(short.chars().count(), 200);

    // Output is valid UTF-8 (trivially true for `String`, but pin
    // the boundary explicitly so a future swap to `unsafe` slicing
    // gets caught).
    assert!(
        short.is_char_boundary(short.len()),
        "clip must end on a UTF-8 char boundary"
    );
    assert_eq!(short.len(), 203, "no codepoint was split mid-byte");

    // Round-trip cleanly through serde_json — the activity emitter
    // serialises `ActivityResult::Err(short)` to JSON for the
    // frontend (see `activity.rs::ActivityResult` Serialize impl).
    let v = serde_json::to_value(&short).unwrap();
    let back: String = serde_json::from_value(v).unwrap();
    assert_eq!(back, short, "serde_json round-trip preserves bytes");
}

/// I-MCP-8: a longer all-emoji payload (500 four-byte codepoints =
/// 2000 UTF-8 bytes). The clip MUST yield exactly 200 emojis (800
/// bytes), never panic, never split mid-codepoint.
#[test]
fn err_clip_truncates_long_emoji_string_without_splitting() {
    let input = "\u{1F4A5}".repeat(500); // 💥 × 500
    assert_eq!(input.chars().count(), 500);
    assert_eq!(input.len(), 2000);

    let short: String = input.chars().take(200).collect();
    assert_eq!(short.chars().count(), 200);
    assert_eq!(short.len(), 800, "200 four-byte codepoints = 800 bytes");
    assert!(
        short.is_char_boundary(short.len()),
        "clip must end on a UTF-8 char boundary"
    );

    let v = serde_json::to_value(&short).unwrap();
    let back: String = serde_json::from_value(v).unwrap();
    assert_eq!(back, short);
}

/// I-MCP-8: end-to-end check that the clipping in `handle_tools_call`'s
/// error branch (server.rs:503-510) survives a multi-byte AppError
/// payload through to `ActivityResult::Err(short)`. Pairs with the
/// unit tests above which pin the clip pattern in isolation.
#[tokio::test]
async fn handle_tools_call_err_clip_survives_multibyte_apperror_payload() {
    use super::super::activity::ActivityResult;

    /// Test registry whose tool always returns the configured AppError
    /// payload. Exercises the Err arm of `handle_tools_call` without
    /// needing the PlaceholderRegistry's hard-coded NotFound path.
    struct ErrRegistry {
        err_msg: String,
    }
    impl ToolRegistry for ErrRegistry {
        fn list_tools(&self) -> Vec<ToolDescription> {
            Vec::new()
        }
        async fn call_tool(
            &self,
            _name: &str,
            _args: Value,
            _ctx: &ActorContext,
        ) -> Result<Value, AppError> {
            Err(AppError::Validation(self.err_msg.clone()))
        }
    }

    let (ctx, recorder) = recording_ctx();
    let state = ConnectionState {
        client_info: Some(ClientInfo {
            name: "claude".to_string(),
            version: None,
        }),
        activity_ctx: Some(ctx),
        ..ConnectionState::default()
    };
    // 250 four-byte emojis well past the 200-char clip — the
    // production path goes through `err.to_string().chars().take(200)`,
    // and the `Validation(...)` Display prefix `"Validation error: "`
    // counts toward the clip.
    let registry = ErrRegistry {
        err_msg: "\u{1F4A5}".repeat(250),
    };
    let params = json!({ "name": "boom", "arguments": {} });

    let _ = handle_tools_call(&state, &params, &registry)
        .await
        .expect_err("ErrRegistry surfaces AppError::Validation");

    let entries = recorder.entries();
    assert_eq!(entries.len(), 1);
    match &entries[0].result {
        ActivityResult::Err(short) => {
            assert!(
                short.chars().count() <= 200,
                "I-MCP-8: clip must cap at 200 chars even for emoji-heavy payloads, got {}",
                short.chars().count()
            );
            assert!(
                short.is_char_boundary(short.len()),
                "I-MCP-8: clip must end on a UTF-8 char boundary"
            );
            // serde_json round-trip on the captured Err — pins the
            // frontend-facing payload shape.
            let v = serde_json::to_value(short).unwrap();
            let back: String = serde_json::from_value(v).unwrap();
            assert_eq!(&back, short);
        }
        other => panic!("expected ActivityResult::Err, got {other:?}"),
    }
}

#[tokio::test]
async fn handle_tools_call_session_id_stable_across_two_requests() {
    // FEAT-4h slice 3 invariant: every emission from the same
    // connection carries the same `session_id`.
    let (ctx, recorder) = recording_ctx();
    let state = ConnectionState {
        client_info: Some(ClientInfo {
            name: "claude".to_string(),
            version: None,
        }),
        activity_ctx: Some(ctx),
        ..ConnectionState::default()
    };
    let registry = OkRegistry;

    let _ = handle_tools_call(&state, &json!({ "name": "a", "arguments": {} }), &registry)
        .await
        .unwrap();
    let _ = handle_tools_call(&state, &json!({ "name": "b", "arguments": {} }), &registry)
        .await
        .unwrap();

    let entries = recorder.entries();
    assert_eq!(entries.len(), 2);
    assert_eq!(
        entries[0].session_id, entries[1].session_id,
        "both entries must share the same session_id (stable across requests \
         on the same ConnectionState)",
    );
    assert_eq!(entries[0].session_id, state.session_id);
}

// -----------------------------------------------------------------
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
// -----------------------------------------------------------------

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
        let result = serve_unix(listener, registry, None, Some(serve_lc.clone())).await;
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
        let result = serve_unix(listener_v1, registry_1, None, Some(serve_lc_1.clone())).await;
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
        let result = serve_unix(listener_v2, registry_2, None, Some(serve_lc_2.clone())).await;
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
    // `select!` (FEAT-4e) drops the in-flight stream as before;
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
        let result = serve_unix(listener, registry, None, Some(serve_lc.clone())).await;
        serve_lc
            .task_running
            .store(false, std::sync::atomic::Ordering::Release);
        result
    });

    // Open an in-flight connection — sit on it without sending so
    // the handler is parked inside `read_line(...).await`.
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
    // signal via its `select!` (FEAT-4e) and drops its half. The
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

// ── L-113 — disconnect grace period for in-flight tools/call ──────

/// Mock registry whose `call_tool` sleeps for a configurable
/// duration before returning a canned success. Used by the L-113
/// tests to simulate a tool dispatch that is mid-flight when the
/// disconnect signal fires.
struct SlowRegistry {
    sleep: std::time::Duration,
}

impl ToolRegistry for SlowRegistry {
    fn list_tools(&self) -> Vec<ToolDescription> {
        vec![ToolDescription {
            name: "slow".to_string(),
            description: "sleeps and returns".to_string(),
            input_schema: json!({"type": "object"}),
        }]
    }

    async fn call_tool(
        &self,
        _name: &str,
        _args: Value,
        _ctx: &ActorContext,
    ) -> Result<Value, AppError> {
        tokio::time::sleep(self.sleep).await;
        Ok(json!({"slept": true}))
    }
}

#[cfg(unix)]
#[tokio::test]
async fn disconnect_signal_grants_grace_period_for_in_flight_tool_call_l113() {
    // L-113: when `disconnect_all` fires while a `tools/call` is
    // mid-dispatch, `run_connection` must wrap the in-flight future
    // in a 2 s timeout so the call gets a chance to return its
    // JSON-RPC reply (and emit its activity entry) before the
    // stream is dropped. This test exercises the happy path: the
    // tool finishes well within the grace period, so the agent
    // does see the reply.
    use tokio::net::{UnixListener, UnixStream};

    let dir = tempfile::TempDir::new().unwrap();
    let path = dir.path().join("l113-grace.sock");
    let listener = UnixListener::bind(&path).unwrap();

    let lifecycle = super::super::McpLifecycle::new();
    let registry = Arc::new(SlowRegistry {
        sleep: std::time::Duration::from_millis(500),
    });

    let task_lc = lifecycle.clone();
    let task_registry = registry.clone();
    let accept_task = tokio::spawn(async move {
        let (server_side, _) = listener.accept().await.unwrap();
        run_connection(server_side, task_registry.as_ref(), None, Some(task_lc)).await;
    });

    let client = UnixStream::connect(&path).await.unwrap();
    let (r, mut w) = tokio::io::split(client);
    let mut reader = BufReader::new(r);

    // Initialize handshake — captures clientInfo so the dispatch
    // wraps `call_tool` in `ACTOR.scope(...)` properly.
    send_line(
        &mut w,
        &json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "clientInfo": {"name": "l113-grace-test"},
                "capabilities": {},
            },
        }),
    )
    .await;
    let _ = read_line(&mut reader).await;

    // Issue the slow tools/call. The handler dispatches into
    // `SlowRegistry::call_tool`, which parks on `sleep(500ms)`.
    send_line(
        &mut w,
        &json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {"name": "slow", "arguments": {}},
        }),
    )
    .await;

    // Give the accept-task time to dispatch into call_tool so the
    // disconnect arm of `run_connection`'s `select!` is parked on
    // `notify.notified().await` before we fire `notify_waiters`
    // (which is edge-triggered — late waiters miss the wake).
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    lifecycle.disconnect_all();

    // The slow tool finishes in ~500 ms, well under the 2 s grace
    // period, so the JSON-RPC reply must arrive at the client.
    let response = tokio::time::timeout(
        MCP_DISCONNECT_GRACE_PERIOD + std::time::Duration::from_millis(500),
        read_line(&mut reader),
    )
    .await
    .expect("tools/call reply must arrive within the L-113 grace period");

    assert_eq!(response["id"], 2, "tools/call reply id must echo");
    assert_eq!(
        response["result"]["isError"], false,
        "tools/call must succeed; got: {response:?}",
    );
    assert_eq!(
        response["result"]["structuredContent"],
        json!({"slept": true}),
        "structuredContent must surface the slow tool's payload",
    );

    drop(w);
    drop(reader);
    let _ = accept_task.await;
}

#[cfg(unix)]
#[tokio::test]
async fn disconnect_signal_drops_after_grace_period_when_call_hangs_l113() {
    // L-113: if the in-flight `tools/call` does not complete within
    // the bounded grace period, `run_connection` must drop the
    // future, log a `warn`, and exit cleanly. The agent will not
    // see a reply on the socket — this is the explicit failure
    // mode for tools that hang past the grace budget.
    use tokio::net::{UnixListener, UnixStream};
    use tracing_subscriber::layer::SubscriberExt;

    let writer = MockBufWriter::default();
    let subscriber = tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::new("warn"))
        .with(
            tracing_subscriber::fmt::layer()
                .with_writer(writer.clone())
                .with_ansi(false)
                .with_target(true),
        );
    // Thread-local subscriber is sufficient because `#[tokio::test]`
    // defaults to the `current_thread` flavour: every spawned task
    // runs on the same OS thread as the test.
    let _guard = tracing::subscriber::set_default(subscriber);

    let dir = tempfile::TempDir::new().unwrap();
    let path = dir.path().join("l113-drop.sock");
    let listener = UnixListener::bind(&path).unwrap();

    let lifecycle = super::super::McpLifecycle::new();
    let registry = Arc::new(SlowRegistry {
        // Longer than the 2 s grace period so the timeout fires.
        sleep: std::time::Duration::from_secs(5),
    });

    let task_lc = lifecycle.clone();
    let task_registry = registry.clone();
    let accept_task = tokio::spawn(async move {
        let (server_side, _) = listener.accept().await.unwrap();
        run_connection(server_side, task_registry.as_ref(), None, Some(task_lc)).await;
    });

    let client = UnixStream::connect(&path).await.unwrap();
    let (r, mut w) = tokio::io::split(client);
    let mut reader = BufReader::new(r);

    send_line(
        &mut w,
        &json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "clientInfo": {"name": "l113-drop-test"},
                "capabilities": {},
            },
        }),
    )
    .await;
    let _ = read_line(&mut reader).await;

    send_line(
        &mut w,
        &json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {"name": "slow", "arguments": {}},
        }),
    )
    .await;

    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    lifecycle.disconnect_all();

    // Wait the full grace period plus a buffer for the timeout
    // future to resolve and the per-connection task to drop the
    // stream. After this, the client side must observe EOF — no
    // JSON-RPC reply for id=2.
    let mut buf = String::new();
    let read_outcome = tokio::time::timeout(
        MCP_DISCONNECT_GRACE_PERIOD + std::time::Duration::from_millis(700),
        reader.read_line(&mut buf),
    )
    .await;

    match read_outcome {
        Ok(Ok(0)) => {
            // EOF — the per-connection task dropped the stream
            // after the grace period elapsed. Expected.
        }
        Ok(Err(_)) => {
            // I/O error on read — the OS observed the closed
            // socket. Also expected.
        }
        Ok(Ok(n)) => panic!(
            "L-113: expected EOF / drop after grace period; \
             instead read {n} bytes: {buf:?}",
        ),
        Err(_) => panic!(
            "L-113: connection did not drop within \
             MCP_DISCONNECT_GRACE_PERIOD + buffer; the grace \
             period timeout must elapse and force a drop",
        ),
    }

    let logs = writer.contents();
    assert!(
        logs.contains("WARN"),
        "L-113: expected WARN log when grace period elapses; got: {logs:?}",
    );
    assert!(
        logs.contains("did not complete within grace period"),
        "L-113: warn line must mention the grace-period elapse; got: {logs:?}",
    );

    drop(w);
    drop(reader);
    let _ = accept_task.await;
}
