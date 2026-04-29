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
pub const MCP_PROTOCOL_VERSION: &str = "2025-06-18";

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

// I-MCP-7: compile-time assertion that `ConnectionState` is `Send + Sync`.
// `serve_unix` / `serve_pipe` spawn a per-connection task that owns the
// state across `.await` points, so dispatch requires `Send`. Today every
// field is `Send + Sync`; an accidental `Rc`/`RefCell` would otherwise
// surface only at the spawn site. Keeping this next to the struct
// definition pins the contract.
const _: () = {
    const fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<ConnectionState>();
};

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
mod tests;

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
