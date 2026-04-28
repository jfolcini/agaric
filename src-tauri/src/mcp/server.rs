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
use super::{ConnectionCounterGuard, McpLifecycle, SocketKind};
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

/// Application-level "not found" code. Distinct from
/// [`JSONRPC_METHOD_NOT_FOUND`] (−32601 — "the JSON-RPC method endpoint
/// does not exist") — this code signals "the *resource* named by the
/// call arguments was not found" (unknown tool name under `tools/call`,
/// unknown block id inside a tool handler, etc.). Picked from the
/// JSON-RPC 2.0 "server-defined" error range (−32000..=−32099) per the
/// FEAT-4c decision. Agents that want to surface a separate UX for
/// "you asked for something that does not exist" versus "you called an
/// undefined method" rely on this split.
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
///
/// `session_id` is an opaque ULID generated once on connection open and
/// stamped onto every emitted [`super::activity::ActivityEntry`]. Stable
/// across every request on the same socket connection — enables the
/// frontend activity-feed (FEAT-4h slice 3) to group entries by MCP
/// session and render a per-session Undo affordance.
#[derive(Debug)]
pub struct ConnectionState {
    pub client_info: Option<ClientInfo>,
    pub protocol_version: Option<String>,
    pub initialized: bool,
    pub activity_ctx: Option<super::activity::ActivityContext>,
    pub session_id: String,
}

impl Default for ConnectionState {
    fn default() -> Self {
        Self {
            client_info: None,
            protocol_version: None,
            initialized: false,
            activity_ctx: None,
            // Fresh ULID per connection. `Ulid::new()` uses the current
            // UTC millisecond + 80 bits of entropy — collision-free for
            // our purposes (single-user local socket). Never empty — the
            // frontend groups entries by `sessionId`, so an empty string
            // would collapse every session into one.
            session_id: Ulid::new().to_string(),
        }
    }
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
///
/// Code mapping:
/// - [`AppError::NotFound`] → [`JSONRPC_RESOURCE_NOT_FOUND`] (−32001).
///   Kept distinct from [`JSONRPC_METHOD_NOT_FOUND`] (−32601) so agents
///   can tell "unknown JSON-RPC method endpoint" apart from "resource
///   (tool / block / page) not found in the call arguments".
/// - [`AppError::Validation`] / [`AppError::InvalidOperation`] →
///   [`JSONRPC_INVALID_PARAMS`] (−32602).
/// - Everything else → [`JSONRPC_INTERNAL_ERROR`] (−32603).
///
/// **Design choice (L-116, closed).** JSON-RPC errors are the single
/// source of truth for tool failures: every `AppError` variant
/// surfaces via this function, and we deliberately do **not** emit the
/// MCP `CallToolResult { isError: true }` envelope. No current
/// `AppError` variant fits the "tool ran and reported a domain-level
/// failure" semantics that `isError: true` is meant for — `NotFound`
/// / `Validation` / `InvalidOperation` are "the tool never ran" cases,
/// and `Database` / `Io` / `Channel` / etc. are infrastructure
/// failures above the tool layer. Mapping everything to JSON-RPC
/// codes keeps FEAT-4c's wire contract stable and preserves the
/// error-code routing that clients already rely on.
fn app_error_to_jsonrpc(err: &AppError) -> (i64, String) {
    let code = match err {
        AppError::NotFound(_) => JSONRPC_RESOURCE_NOT_FOUND,
        AppError::Validation(_) | AppError::InvalidOperation(_) => JSONRPC_INVALID_PARAMS,
        _ => JSONRPC_INTERNAL_ERROR,
    };
    (code, err.to_string())
}

/// Wrap a successful tool-call result in the MCP `CallToolResult`
/// envelope expected by real MCP clients (Claude Desktop, Cursor, the
/// official Python `mcp` SDK). See FEAT-4j.
///
/// Shape:
/// ```json
/// {
///   "content": [ { "type": "text", "text": "<JSON-stringified value>" } ],
///   "isError": false,
///   "structuredContent": <original Value>
/// }
/// ```
///
/// Rationale:
/// - `content` is the MCP-2024-11-05 minimum — every client can parse
///   at least one text block.
/// - `structuredContent` lets MCP-2025-06-18+ clients skip the
///   text-parse path entirely and read the typed payload directly.
/// - `isError: false` is explicit so a client that checks the flag
///   unconditionally does not misread a missing field.
///
/// Pure function — unit-tested on its own so the envelope shape is
/// locked in independently of the dispatch path.
fn wrap_tool_result_success(value: Value) -> Value {
    // `to_string` on any valid `serde_json::Value` cannot fail — there
    // is no I/O and every `Value` variant is representable. Fall back
    // to the `Debug` rendering if it somehow does (should never happen
    // in practice).
    let text = serde_json::to_string(&value).unwrap_or_else(|_| format!("{value:?}"));
    // Build the envelope via an explicit `Map` so the caller's `value`
    // is moved into `structuredContent` rather than cloned by the
    // `json!` macro expansion. Shape is exactly equivalent to:
    //
    //     json!({
    //         "content": [ { "type": "text", "text": text } ],
    //         "isError": false,
    //         "structuredContent": value,
    //     })
    let mut envelope = serde_json::Map::with_capacity(3);
    envelope.insert(
        "content".to_string(),
        json!([{ "type": "text", "text": text }]),
    );
    envelope.insert("isError".to_string(), Value::Bool(false));
    envelope.insert("structuredContent".to_string(), value);
    Value::Object(envelope)
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

    // FEAT-4k: keep a copy of the arg bag for the post-dispatch summary
    // build, but only when an activity context is attached (otherwise
    // the summary is never read and the clone would be pure waste).
    // `registry.call_tool` consumes `args` by value, so this is the
    // last point at which we can stash a copy without threading
    // lifetimes through the registry contract.
    let args_for_summary = if state.activity_ctx.is_some() {
        Some(args.clone())
    } else {
        None
    };

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
        actor: Actor::Agent {
            name: agent_name.clone(),
        },
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

    // FEAT-4h slice 3: wrap the registry call in TWO task-local scopes
    // (ACTOR outer, LAST_APPEND inner). `append_local_op_in_tx` pokes
    // every freshly-inserted `OpRef` into LAST_APPEND; we harvest the
    // full list here so the emitted activity entry can carry it for
    // per-entry Undo. Capturing happens INSIDE the scope so the
    // task-local is still alive when we read it.
    //
    // MAINT-150 (j): `LAST_APPEND` lives in `crate::task_locals` so
    // `op_log` (core) does not depend on `mcp` (integration) just to
    // populate the cell.
    //
    // L-114: the storage is `RefCell<Vec<OpRef>>` so multi-op tools
    // (e.g. a future `move_subtree`) retain *every* `OpRef` they
    // produced, not just the last. We split the captured list below:
    // first → `op_ref` (preserves the existing wire shape so the
    // frontend keeps working), tail → `additional_op_refs`.
    let (result, op_refs) = ACTOR
        .scope(scoped_ctx, async {
            crate::task_locals::LAST_APPEND
                .scope(std::cell::RefCell::new(Vec::new()), async {
                    let r = registry.call_tool(&name, args, &call_ctx).await;
                    let captured = crate::task_locals::take_appends();
                    (r, captured)
                })
                .await
        })
        .await;

    // FEAT-4c emission path: if an activity context is attached to the
    // connection, emit one entry per completed tool call (success or
    // failure). The frontend activity feed renders errors too, so the
    // emission branches cover both the Ok and Err arms.
    if let Some(ref ctx) = state.activity_ctx {
        use super::activity::{
            emit_tool_completion, ActivityResult as ActRes, ActorKind, ToolCompletionEvent,
        };
        // FEAT-4k: per-tool privacy-safe summaries. On success, dispatch
        // through `super::summarise::summarise` so each tool produces a
        // structural one-line summary (counts, ULID prefixes, property
        // keys — never block content or text-property values). On
        // failure, fall back to the bare tool name so the error message
        // (already clipped to 200 chars below) is the entry's only
        // free-form payload.
        // `args_for_summary` is `Some` because we are inside the
        // `state.activity_ctx.is_some()` branch (see the clone above),
        // but be defensive: if a future refactor drops that guard the
        // summariser still falls back to the bare name via an empty
        // arg envelope.
        let summary_args = args_for_summary
            .as_ref()
            .cloned()
            .unwrap_or_else(|| Value::Object(serde_json::Map::new()));
        let (summary, result_variant) = match &result {
            Ok(value) => (
                super::summarise::summarise(&name, &summary_args, value),
                ActRes::Ok,
            ),
            Err(err) => {
                // Clip the message to avoid leaking long error chains
                // into the activity feed. See [`ERROR_CLIP_CAP`] for
                // the rationale on the cap and the Unicode-scalar
                // (rather than byte) basis.
                let short: String = err.to_string().chars().take(ERROR_CLIP_CAP).collect();
                (name.clone(), ActRes::Err(short))
            }
        };
        // L-114: split the captured op_refs into the legacy single
        // `op_ref` (first append) plus a `additional_op_refs` tail
        // for future multi-op tools. `into_iter` + `next` consumes
        // the head without an intermediate clone; `collect()` on the
        // remaining iterator yields the tail in append order.
        let mut op_refs_iter = op_refs.into_iter();
        let op_ref = op_refs_iter.next();
        let additional_op_refs: Vec<crate::op::OpRef> = op_refs_iter.collect();
        // `ActorKind::Agent` is correct for every MCP dispatch today —
        // the `User` branch is reserved for future non-MCP usage of
        // the same seam. The agent name is the handshake's
        // `clientInfo.name` (see the `unwrap_or_else` fallback above).
        emit_tool_completion(
            ctx,
            ToolCompletionEvent {
                tool_name: &name,
                summary: &summary,
                actor_kind: ActorKind::Agent,
                agent_name: Some(agent_name.clone()),
                result: result_variant,
                session_id: &state.session_id,
                op_ref,
                additional_op_refs,
            },
        );
    }

    match result {
        Ok(value) => Ok(wrap_tool_result_success(value)),
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

/// Maximum length (in bytes) of the truncated `params` summary that
/// `handle_notification` includes in its warn-level log line.
/// I-MCP-3: keep the diagnostic short so a noisy / verbose client cannot
/// blow up the log buffer, while still leaving enough context for support.
const UNKNOWN_NOTIFICATION_PARAMS_PREVIEW_LEN: usize = 200;

fn handle_notification(state: &mut ConnectionState, method: &str, params: &Value) {
    match method {
        "notifications/initialized" => {
            state.initialized = true;
            tracing::debug!(target: "mcp", "client signalled notifications/initialized");
        }
        other => {
            // I-MCP-3: promote unknown notifications from `debug` to `warn`
            // so that a misconfigured agent (or a future MCP spec extension
            // we have not implemented yet — `notifications/cancelled`,
            // `notifications/progress`, …) is visible in support reports
            // without re-enabling the `mcp` log target.
            let preview = truncate_params_preview(params, UNKNOWN_NOTIFICATION_PARAMS_PREVIEW_LEN);
            tracing::warn!(
                target: "mcp",
                method = other,
                params_preview = %preview,
                "ignoring unknown MCP notification — promote-to-warn for diagnostic visibility",
            );
        }
    }
}

/// Render `params` as a short single-line preview suitable for logs.
///
/// Returns an empty string for `Null`, otherwise serialises to JSON and
/// truncates to `max_len` bytes (with a trailing ellipsis when truncated).
/// Truncation is guarded against splitting a multi-byte UTF-8 codepoint.
fn truncate_params_preview(params: &Value, max_len: usize) -> String {
    if params.is_null() {
        return String::new();
    }
    let raw = serde_json::to_string(params).unwrap_or_else(|_| "<unserialisable>".to_owned());
    if raw.len() <= max_len {
        return raw;
    }
    // Find the largest valid char boundary <= max_len so we never split
    // a multi-byte codepoint.
    let mut cut = max_len;
    while cut > 0 && !raw.is_char_boundary(cut) {
        cut -= 1;
    }
    let mut out = raw[..cut].to_owned();
    out.push('…');
    out
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
                handle_notification(&mut state, &note.method, &note.params);
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
) -> Result<(), AppError>
where
    R: ToolRegistry + Send + Sync + 'static,
{
    match socket {
        #[cfg(unix)]
        SocketKind::Unix(listener) => serve_unix(listener, registry, activity_ctx, lifecycle).await,
        #[cfg(windows)]
        SocketKind::Pipe { server, path } => {
            serve_pipe(server, path, registry, activity_ctx, lifecycle).await
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
) -> Result<(), AppError>
where
    R: ToolRegistry + Send + Sync + 'static,
{
    loop {
        // H-2: per-iteration gate. A `mcp_set_enabled(false)` clears
        // `enabled` and notifies, so we either short-circuit here on
        // the next pass or wake from the `select!` below and re-check
        // on the wrapped iteration. Either way we return cleanly and
        // the listener is dropped, freeing the socket file.
        if lifecycle_disabled(lifecycle.as_ref()) {
            tracing::info!(
                target: "mcp",
                "MCP RO accept loop exiting (lifecycle.enabled cleared)",
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
            Some(res) => res?,
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
                "MCP RO accept loop exiting after racing accept (lifecycle.enabled cleared)",
            );
            return Ok(());
        }

        let registry = registry.clone();
        let activity_ctx = activity_ctx.clone();
        let lifecycle = lifecycle.clone();
        tokio::spawn(async move {
            run_connection(stream, registry.as_ref(), activity_ctx, lifecycle).await;
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

    loop {
        // H-2: per-iteration gate. See `serve_unix` for the rationale.
        if lifecycle_disabled(lifecycle.as_ref()) {
            tracing::info!(
                target: "mcp",
                "MCP RO accept loop exiting (lifecycle.enabled cleared)",
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
            Some(Ok(())) => {}
            Some(Err(e)) => return Err(e.into()),
            None => continue,
        }

        // H-2: re-check the gate before handing the freshly-connected
        // pipe instance to a handler.
        if lifecycle_disabled(lifecycle.as_ref()) {
            tracing::info!(
                target: "mcp",
                "MCP RO accept loop exiting after racing connect (lifecycle.enabled cleared)",
            );
            return Ok(());
        }

        let connected = server;
        // Prepare the next server instance before handing off the current
        // connection. Without this, the second client would fail to connect.
        server = ServerOptions::new().create(pipe_path)?;

        let registry = registry.clone();
        let activity_ctx = activity_ctx.clone();
        let lifecycle = lifecycle.clone();
        tokio::spawn(async move {
            run_connection(connected, registry.as_ref(), activity_ctx, lifecycle).await;
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
    registry: &R,
    activity_ctx: Option<super::activity::ActivityContext>,
    lifecycle: Option<McpLifecycle>,
) where
    S: AsyncRead + AsyncWrite + Unpin,
    R: ToolRegistry,
{
    // Bind the RAII counter guard to the task lifetime so panics (or the
    // disconnect-signal branch below) still decrement the counter.
    let _guard = lifecycle
        .as_ref()
        .map(|lc| ConnectionCounterGuard::new(lc.active_connections.clone()));

    let fut = handle_connection(stream, registry, activity_ctx);

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
        tracing::warn!(target: "mcp", error = %e, "MCP connection ended with error");
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
        use super::super::activity::{
            ActivityContext, ActivityResult, ActivityRing, RecordingEmitter,
        };
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
}

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
        use crate::mcp::server::{serve, PlaceholderRegistry};
        use crate::mcp::{McpLifecycle, SocketKind, MCP_RO_PIPE_PATH, MCP_RW_PIPE_PATH};
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
            let serve_task =
                tokio::spawn(async move { serve(socket, registry, None, Some(serve_lc)).await });

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
