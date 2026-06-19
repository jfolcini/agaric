//! Production MCP adapter (rmcp). Handles tools/call dispatch via the registered tool registry.
//!
//! `rmcp` is a hard dependency (see `Cargo.toml`) and this adapter is the
//! production `tools/list` / `tools/call` dispatcher: `super::server`
//! constructs [`RmcpAdapter`] (parameterised on [`McpSurface`], #693)
//! and serves both the read-only and read-write registries through it.
//! The hand-rolled `mcp/server.rs` framing is retained only
//! for the connection lifecycle plumbing it wraps (see "What this adapter
//! does NOT do" below); it no longer dispatches tool calls.
//!
//! ## What this adapter does NOT do
//!
//! - It does NOT replace the accept loop / lifecycle bookkeeping in
//!   `mcp/mod.rs::serve` / `mcp/server.rs::serve_unix` /
//!   `serve_pipe` / `run_connection`. Those are agaric-specific
//!   (Unix-domain socket, Windows named pipe, FEAT-4e disconnect
//!   gate, L-113 grace period). `rmcp` only takes over the
//!   per-connection JSON-RPC loop.
//! - It does NOT replace the connection-level [`super::server::serve`]
//!   plumbing — that wraps the rmcp `serve` loop. It DOES, however,
//!   own per-connection JSON-RPC dispatch for every read-only tool:
//!   `tools/list` reflects the full RO registry and `call_tool`
//!   dispatches every RO tool through the adapter.
//! - It does NOT special-case RW tools. Read-write tools' richer
//!   side-effects (op-log appends, activity-feed errors, materializer
//!   trigger) live behind the [`ToolRegistry`] seam; the adapter only
//!   differs per surface in what `get_info` advertises (#693).
//!
//! ## How to drive it
//!
//! Tests use [`tokio::io::duplex`] to pair the adapter with a real
//! `rmcp` client over an in-memory async pipe — no Unix socket / DB
//! / Tauri runtime required. See the test module at the bottom of
//! this file.

use std::borrow::Cow;
use std::sync::Arc;

use rmcp::{
    handler::server::ServerHandler,
    model::{
        CallToolRequestParams, CallToolResult, ErrorData, Implementation, ListToolsResult,
        PaginatedRequestParams, ServerCapabilities, ServerInfo, Tool,
    },
    service::{RequestContext, RoleServer},
};
use serde_json::Value;
use ulid::Ulid;

use super::McpSurface;
use super::activity::{
    ActivityContext, ActivityResult, ActorKind, ToolCompletionEvent, emit_tool_completion,
};
use super::actor::{ACTOR, Actor, ActorContext};
use super::registry::ToolRegistry;
use super::server::ERROR_CLIP_CAP;
use crate::error::AppError;

/// #1569 — upper bound on the number of Unicode scalar values (chars)
/// kept from a self-reported MCP `clientInfo.name` before it becomes an
/// [`Actor::Agent`] label and is stamped, verbatim, into the permanent,
/// append-only, hash-chained `op_log.origin` column (see
/// `op_log::append_local_op_in_tx`).
///
/// The handshake name is fully attacker-controlled by a local MCP client
/// and was previously taken with no length cap, charset normalisation, or
/// control-char rejection, letting a misbehaving client persist an
/// arbitrarily large / malformed string into durable state on every RW
/// tool call. 128 chars is generous for a human-meaningful client label
/// (e.g. `"claude-desktop"`, `"Cursor 0.42 (macOS)"`) while bounding the
/// per-op `origin` contribution to a small, predictable size. Truncation
/// is on a char boundary so a multi-byte scalar is never split.
const MAX_AGENT_NAME_LEN: usize = 128;

/// Stable placeholder used when a self-reported MCP `clientInfo.name` is
/// empty or becomes empty after control-char stripping. Mirrors the
/// `"unknown"` fallback used when `peer_info()` is absent so the
/// resulting `origin` is always a non-empty, well-formed `agent:<name>`.
const AGENT_NAME_PLACEHOLDER: &str = "unknown";

/// #1569 — normalise a self-reported MCP `clientInfo.name` at the trust
/// boundary, before it is wrapped in [`Actor::Agent`] and durably stamped
/// into `op_log.origin`.
///
/// Performed exactly once, here at the capture site, so the cleaned value
/// flows through `Actor::Agent` → `Actor::origin_tag` → `op_log.origin`
/// unchanged. The steps:
///
/// 1. Strip ASCII control characters (`\0`, `\t`, `\n`, `\r`, `\x1b`, …)
///    and other Unicode control scalars (`char::is_control`) so no
///    control bytes ever reach the append-only log.
/// 2. Collapse / trim surrounding ASCII whitespace so a name that is all
///    spaces (or padded) does not produce a blank-looking label.
/// 3. Truncate to [`MAX_AGENT_NAME_LEN`] chars on a char boundary so a
///    multi-KiB / multi-MiB name cannot bloat the durable row and a
///    multi-byte scalar is never split mid-codepoint.
/// 4. Fall back to [`AGENT_NAME_PLACEHOLDER`] when nothing printable
///    remains, so the label is never empty.
fn sanitize_agent_name(raw: &str) -> String {
    let cleaned: String = raw
        // Drop every control char (ASCII C0/C1 + Unicode controls).
        .chars()
        .filter(|c| !c.is_control())
        // Bound length on a char boundary — `take` counts scalars, so a
        // multi-byte char is kept whole or dropped, never split.
        .take(MAX_AGENT_NAME_LEN)
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        AGENT_NAME_PLACEHOLDER.to_string()
    } else {
        trimmed.to_string()
    }
}

/// Production adapter that exposes a tool registry through `rmcp`'s
/// [`ServerHandler`] trait.
///
/// `list_tools` forwards every entry the [`ToolRegistry`] returns and
/// `call_tool` dispatches every tool through the registry. `R` is the
/// existing [`ToolRegistry`] trait — the adapter does NOT need a parallel
/// registration model.
///
/// #693 — the adapter is parameterised on [`McpSurface`] so `get_info`
/// advertises the surface it actually fronts. (Previously named
/// `RmcpReadOnlyAdapter` and hardcoded to introduce itself as the
/// read-only server even on the RW socket.)
pub struct RmcpAdapter<R: ToolRegistry> {
    registry: Arc<R>,
    /// FEAT-4d activity-emission seam. `None` in tests / stub binaries
    /// where no Tauri runtime is bound; `Some(_)` in production via
    /// `ActivityContext::from_app_handle`.
    activity_ctx: Option<ActivityContext>,
    /// Which surface this adapter fronts — drives `get_info`'s
    /// instructions (#693).
    surface: McpSurface,
    /// Stable per-connection ULID, mirroring
    /// `super::server::ConnectionState::session_id`. Stamped onto every
    /// emitted activity entry so the frontend feed can group entries
    /// by MCP session.
    session_id: String,
}

impl<R: ToolRegistry> RmcpAdapter<R> {
    /// Build an adapter around an existing registry handle, an optional
    /// FEAT-4d activity context, and the surface it fronts. Pass `None`
    /// for activity_ctx in tests / stub binaries with no Tauri runtime
    /// bound.
    pub fn new(
        registry: Arc<R>,
        activity_ctx: Option<ActivityContext>,
        surface: McpSurface,
    ) -> Self {
        Self {
            registry,
            activity_ctx,
            surface,
            session_id: Ulid::new().to_string(),
        }
    }
}

impl<R: ToolRegistry> ServerHandler for RmcpAdapter<R> {
    fn get_info(&self) -> ServerInfo {
        // `ServerInfo` (= `InitializeResult`) is `#[non_exhaustive]` —
        // construct it through the documented builder methods. The
        // hand-rolled code pins to MCP "2025-06-18"; rmcp picks the
        // latest spec version it knows. Either is acceptable per MCP
        // — version negotiation is the client's responsibility.
        //
        // #693 — instructions come from the surface so the RW socket
        // no longer advertises itself as the read-only server.
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("agaric", env!("CARGO_PKG_VERSION")))
            .with_instructions(self.surface.instructions())
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        // Forward every registry description unfiltered.
        // `ToolDescription::input_schema` is a `serde_json::Value`;
        // rmcp's `Tool::new` takes an `Arc<JsonObject>`. Coerce via
        // `Value::as_object().cloned()` and fall back to an empty
        // object on the (unreachable in practice) non-object schema
        // case — the registry always emits a `{"type":"object",...}`
        // schema.
        let tools: Vec<Tool> = self
            .registry
            .list_tools()
            .into_iter()
            .map(|d| {
                let schema_obj = d.input_schema.as_object().cloned().unwrap_or_default();
                Tool::new(
                    Cow::Owned(d.name),
                    Cow::Owned(d.description),
                    Arc::new(schema_obj),
                )
            })
            .collect();
        Ok(ListToolsResult::with_all_items(tools))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let name = request.name.to_string();

        // Pull `clientInfo.name` out of rmcp's per-connection peer
        // state. rmcp captures `InitializeRequestParams` during the
        // handshake automatically — `peer_info()` is the equivalent
        // of `super::server::ConnectionState::client_info`.
        // #1569 — the handshake `clientInfo.name` is fully controlled by
        // the local MCP client and is stamped, verbatim, into the
        // permanent append-only `op_log.origin` column on every RW tool
        // call. Cap + control-strip it ONCE here at the trust boundary so
        // the cleaned value flows through `Actor::Agent` → `origin_tag()`
        // → durable state; downstream code never sees the raw string.
        let agent_name = context
            .peer
            .peer_info()
            .map(|info| sanitize_agent_name(&info.client_info.name))
            .unwrap_or_else(|| AGENT_NAME_PLACEHOLDER.to_string());

        let actor_ctx = ActorContext {
            actor: Actor::Agent {
                name: agent_name.clone(),
            },
            request_id: Ulid::new().to_string(),
        };
        // Two clones needed: one moves into `ACTOR.scope`, one is borrowed
        // by the explicit-parameter path of [`ToolRegistry::call_tool`].
        let scoped_ctx = actor_ctx.clone();
        let call_ctx = actor_ctx;

        let args = request.arguments.map(Value::Object).unwrap_or(Value::Null);
        let args_for_summary = args.clone();

        let registry = self.registry.clone();
        let name_for_call = name.clone();

        // Two task-local scopes, following the same pattern as the
        // hand-rolled server:
        //  - ACTOR scope so `current_actor()` reads the agent name in
        //    every downstream `*_inner` handler.
        //  - LAST_APPEND scope so any RW tool's `record_append`
        //    landings are harvested for the activity entry.
        //
        // The whole block is `move` so `registry` and the args land
        // on the spawned future, not on the enclosing handler.
        let (result, op_refs) = ACTOR
            .scope(scoped_ctx, async move {
                crate::task_locals::LAST_APPEND
                    .scope(std::cell::RefCell::new(Vec::new()), async move {
                        let r = registry.call_tool(&name_for_call, args, &call_ctx).await;
                        let captured = crate::task_locals::take_appends();
                        (r, captured)
                    })
                    .await
            })
            .await;

        // FEAT-4d emission point.
        // The success branch routes through the privacy-safe summariser;
        // the error branch clips at ERROR_CLIP_CAP chars before pushing.
        let (summary, result_variant) = match &result {
            Ok(value) => (
                super::summarise::summarise(&name, &args_for_summary, value),
                ActivityResult::Ok,
            ),
            Err(err) => {
                let short: String = err.to_string().chars().take(ERROR_CLIP_CAP).collect();
                (name.clone(), ActivityResult::Err(short))
            }
        };
        let mut iter = op_refs.into_iter();
        let op_ref = iter.next();
        let additional_op_refs: Vec<crate::op::OpRef> = iter.collect();
        if let Some(ref ctx) = self.activity_ctx {
            emit_tool_completion(
                ctx,
                ToolCompletionEvent {
                    tool_name: &name,
                    summary: &summary,
                    actor_kind: ActorKind::Agent,
                    agent_name: Some(agent_name),
                    result: result_variant,
                    session_id: &self.session_id,
                    op_ref,
                    additional_op_refs,
                },
            );
        }

        match result {
            // `CallToolResult::structured` produces the MCP wire shape
            // `{ content, structuredContent, isError: false }`.
            Ok(value) => Ok(CallToolResult::structured(value)),
            // Map AppError variants to JSON-RPC error codes:
            // NotFound → resource-not-found (-32001),
            // Validation / InvalidOperation → invalid-params (-32602),
            // everything else → internal-error (-32603).
            Err(err) => Err(app_error_to_rmcp(&err)),
        }
    }
}

/// Generic wire message for the `app_error_to_rmcp` catch-all arm
/// (#698). Mirrors the wording of the IPC boundary's
/// `sanitize_internal_error` so both agent-facing surfaces speak the
/// same sentence.
pub(crate) const INTERNAL_ERROR_WIRE_MESSAGE: &str = "an internal error occurred";

/// `AppError → rmcp::ErrorData` translation. Maps error variants to
/// JSON-RPC error codes. NotFound is mapped
/// via [`ErrorData::new`] rather than [`ErrorData::resource_not_found`]
/// because the latter emits -32002 (MCP-spec default); the agaric
/// hand-rolled path deliberately uses -32001 to leave -32002 free
/// for a future second resource class.
///
/// #698 — the catch-all arm no longer copies `err.to_string()` onto the
/// wire: internal `AppError` variants (Database / Io / Json / …) embed
/// sqlx / OS detail that has no business reaching an automation client
/// (the Tauri IPC boundary already strips the same variants via
/// `sanitize_internal_error`). The detail is preserved on a
/// `tracing::error!` line for the daily log; the wire sees a generic
/// `-32603` message.
fn app_error_to_rmcp(err: &AppError) -> ErrorData {
    use rmcp::model::ErrorCode;
    match err {
        AppError::NotFound(_) => {
            // The constant is `i64` (JSON-RPC error codes are spec'd as
            // signed 32-bit but our hand-rolled module stores them as
            // `i64` for arithmetic ergonomics). The value is statically
            // -32001 which fits in `i32`; the `try_from + unwrap`
            // makes the round-trip explicit so clippy does not flag
            // a hidden cast.
            let code = i32::try_from(super::server::JSONRPC_RESOURCE_NOT_FOUND)
                .expect("JSONRPC_RESOURCE_NOT_FOUND fits in i32");
            ErrorData::new(ErrorCode(code), err.to_string(), None)
        }
        AppError::Validation(_) | AppError::InvalidOperation(_) => {
            ErrorData::invalid_params(err.to_string(), None)
        }
        _ => {
            // #698 — log the real chain, send a generic message.
            tracing::error!(
                target: "mcp",
                error = %err,
                "internal error suppressed before reaching the MCP wire",
            );
            ErrorData::internal_error(INTERNAL_ERROR_WIRE_MESSAGE, None)
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    //! End-to-end test of the rmcp adapter. Drives a real `rmcp`
    //! client/server pair over an in-memory `tokio::io::duplex`
    //! transport — no socket / DB / Tauri runtime needed.

    use std::sync::{Arc, Mutex};

    /// Wire-format name of the mock tool used in unit tests. Matches
    /// `super::super::registry::TOOL_SEARCH` so a real `ReadOnlyTools`
    /// registry can be plugged into the round-trip tests without renaming.
    const SEARCH_TOOL_NAME: &str = "search";

    use rmcp::{
        model::{CallToolRequestParams, ClientCapabilities, ClientInfo, Implementation},
        service::ServiceExt,
    };
    use serde_json::{Value, json};

    /// Build a `ClientInfo` with a custom `clientInfo.name` so the
    /// adapter's `peer_info().client_info.name` is observable in
    /// assertions. `ClientInfo` is `#[non_exhaustive]`, so we route
    /// through `InitializeRequestParams::new` instead of a struct
    /// literal — this is the public constructor.
    fn make_test_client_info() -> ClientInfo {
        ClientInfo::new(
            ClientCapabilities::default(),
            Implementation::new("spike-test-agent", "0.1.0"),
        )
    }

    use super::*;
    use crate::error::AppError;
    use crate::mcp::activity::{
        ActivityContext, ActivityRing, MCP_ACTIVITY_EVENT, RecordingEmitter,
    };
    use crate::mcp::actor::{Actor, current_actor};
    use crate::mcp::registry::{ToolDescription, ToolRegistry};

    /// Minimal in-memory registry. Records the actor observed inside
    /// `call_tool` so the test can assert that the rmcp adapter's
    /// `ACTOR.scope(...)` actually reaches the registry layer.
    struct MockRoRegistry {
        observed_actor: Arc<Mutex<Option<Actor>>>,
        call_count: Arc<Mutex<usize>>,
    }

    impl ToolRegistry for MockRoRegistry {
        fn list_tools(&self) -> Vec<ToolDescription> {
            vec![ToolDescription {
                name: SEARCH_TOOL_NAME.to_string(),
                description: "Spike-only mock search tool.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": { "query": { "type": "string" } },
                    "required": ["query"],
                }),
            }]
        }

        async fn call_tool(
            &self,
            name: &str,
            args: Value,
            _ctx: &ActorContext,
        ) -> Result<Value, AppError> {
            // Assert via stash: the actor seen at the registry layer
            // must be the agent the rmcp client identified itself as.
            *self.observed_actor.lock().unwrap() = Some(current_actor());
            *self.call_count.lock().unwrap() += 1;

            if name != SEARCH_TOOL_NAME {
                return Err(AppError::NotFound(format!("unknown tool `{name}`")));
            }
            // Echo the args back as `items: []` to match the
            // search-blocks summariser's expected shape (it reads
            // `items.len()` for the privacy-safe summary).
            let query = args
                .get("query")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            Ok(json!({
                "items": [],
                "next_cursor": null,
                "echoed_query": query,
            }))
        }
    }

    /// Smoke-level sanity that the adapter compiles and produces the
    /// right `ServerInfo` capabilities — pinned so a future rmcp bump
    /// that subtly changes `ServerCapabilities::builder` is caught.
    #[test]
    fn rmcp_adapter_advertises_tools_capability() {
        let registry = Arc::new(MockRoRegistry {
            observed_actor: Arc::new(Mutex::new(None)),
            call_count: Arc::new(Mutex::new(0)),
        });
        let activity_ctx = ActivityContext::new(
            Arc::new(std::sync::Mutex::new(ActivityRing::new())),
            Arc::new(RecordingEmitter::new()),
        );
        let adapter = RmcpAdapter::new(registry, Some(activity_ctx), McpSurface::ReadOnly);
        let info = adapter.get_info();
        assert!(
            info.capabilities.tools.is_some(),
            "rmcp adapter must advertise the `tools` capability — without it, `tools/list` would be a method-not-found",
        );
        assert_eq!(info.server_info.name, "agaric");
        assert_eq!(info.server_info.version, env!("CARGO_PKG_VERSION"));
    }

    /// Core integration test. Exercises the full rmcp framing path:
    ///
    /// 1. Spawn the adapter as a real rmcp service over an in-memory
    ///    duplex stream.
    /// 2. Connect a real rmcp client over the other end with a
    ///    custom `clientInfo.name` so the adapter's
    ///    `peer_info().client_info.name` is observable.
    /// 3. `client.call_tool("search", { query: "spike" })` round-trip.
    /// 4. Assert:
    ///    (a) the registry's `call_tool` ran (call_count == 1),
    ///    (b) the registry observed `Actor::Agent { name: "spike-test-agent" }`
    ///        — confirms `ACTOR.scope(...)` threading through rmcp,
    ///    (c) the activity feed received exactly one entry with the
    ///        right tool name + agent name + Ok variant,
    ///    (d) the `RecordingEmitter` got a Tauri-style `mcp:activity`
    ///        event for the same entry,
    ///    (e) the response carries the `structuredContent` envelope
    ///        produced by `CallToolResult::structured`.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn rmcp_adapter_search_round_trip_emits_activity_and_actor() {
        let observed = Arc::new(Mutex::new(None));
        let count = Arc::new(Mutex::new(0));
        let registry = Arc::new(MockRoRegistry {
            observed_actor: observed.clone(),
            call_count: count.clone(),
        });

        let ring = Arc::new(std::sync::Mutex::new(ActivityRing::new()));
        let emitter = Arc::new(RecordingEmitter::new());
        let activity_ctx = ActivityContext::new(ring.clone(), emitter.clone());

        let adapter = RmcpAdapter::new(registry, Some(activity_ctx), McpSurface::ReadOnly);

        // 4 KiB duplex pipe — large enough for handshake + one tool
        // call without back-pressure stalls.
        let (server_io, client_io) = tokio::io::duplex(4096);

        // Server side — `serve` drives the handshake response and the
        // per-connection JSON-RPC loop.
        let server_task = tokio::spawn(async move {
            let server = adapter.serve(server_io).await.expect("server handshake");
            // Park until the client closes the duplex.
            let _ = server.waiting().await;
        });

        // Client side — identify with a stable name so the adapter
        // picks it up via `context.peer.peer_info().client_info.name`.
        let client_info = make_test_client_info();
        let client = client_info
            .serve(client_io)
            .await
            .expect("client handshake");

        // List tools — sanity check that the adapter forwarded the
        // registry description through rmcp's framing.
        let tools = client
            .list_all_tools()
            .await
            .expect("tools/list round-trip");
        assert_eq!(tools.len(), 1, "mock registry advertises one tool");
        assert_eq!(tools[0].name, SEARCH_TOOL_NAME);

        // Call the tool.
        let args =
            serde_json::Map::from_iter([("query".to_string(), Value::String("spike".to_string()))]);
        let result = client
            .call_tool(CallToolRequestParams::new(SEARCH_TOOL_NAME).with_arguments(args))
            .await
            .expect("tools/call round-trip");

        assert_eq!(result.is_error, Some(false));
        // Spec wire-shape: `CallToolResult::structured` produces the
        // MCP `{ content, structuredContent, isError: false }` envelope.
        let structured = result
            .structured_content
            .as_ref()
            .expect("structuredContent is the primary payload");
        assert_eq!(structured["echoed_query"], "spike");

        // Tear down the client first so the server task observes EOF
        // and exits cleanly.
        let cancel = client.cancel().await;
        assert!(cancel.is_ok());
        let _ = tokio::time::timeout(std::time::Duration::from_secs(2), server_task).await;

        // (a) the tool body actually ran.
        assert_eq!(
            *count.lock().unwrap(),
            1,
            "registry call_tool ran exactly once"
        );

        // (b) the actor observed inside the registry was the named agent.
        let actor = observed
            .lock()
            .unwrap()
            .clone()
            .expect("actor was captured during the call");
        match actor {
            Actor::Agent { name } => {
                assert_eq!(
                    name, "spike-test-agent",
                    "ACTOR.scope must thread the rmcp clientInfo.name into the registry layer",
                );
            }
            Actor::User => panic!("expected Actor::Agent inside the rmcp dispatch path"),
        }

        // (c) one activity-feed entry was pushed with the right shape.
        let ring_guard = ring.lock().unwrap();
        let entries: Vec<_> = ring_guard.entries().iter().cloned().collect();
        assert_eq!(entries.len(), 1, "one activity entry per tool call");
        let entry = &entries[0];
        assert_eq!(entry.tool_name, SEARCH_TOOL_NAME);
        assert_eq!(entry.agent_name.as_deref(), Some("spike-test-agent"));
        assert!(matches!(
            entry.result,
            crate::mcp::activity::ActivityResult::Ok
        ));
        drop(ring_guard);

        // (d) the recording emitter saw the same entry — the FEAT-4d
        // `mcp:activity` Tauri-event surface still fires through the
        // rmcp path.
        let emitted = emitter.entries();
        assert_eq!(emitted.len(), 1, "one mcp:activity event per tool call");
        assert_eq!(emitted[0].tool_name, SEARCH_TOOL_NAME);
        // pin the Tauri event channel constant.
        assert_eq!(MCP_ACTIVITY_EVENT, "mcp:activity");
    }

    /// Negative path — a `tools/call` for a tool name the registry
    /// does not advertise surfaces as `resource_not_found` (-32002) /
    /// `-32001` over the wire AND emits one activity entry with an
    /// `Err` variant. Unknown tool names round-trip through the registry,
    /// returning `AppError::NotFound` which the dispatcher maps to
    /// the spec's resource-not-found code.
    ///
    /// (`-32601 Method not found` is reserved at the JSON-RPC method
    /// level — `tools/nonexistent_method` — and is handled outside
    /// `call_tool`.)
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn rmcp_adapter_unknown_tool_returns_resource_not_found_with_activity() {
        let observed = Arc::new(Mutex::new(None));
        let count = Arc::new(Mutex::new(0));
        let registry = Arc::new(MockRoRegistry {
            observed_actor: observed,
            call_count: count.clone(),
        });
        let ring = Arc::new(std::sync::Mutex::new(ActivityRing::new()));
        let emitter = Arc::new(RecordingEmitter::new());
        let activity_ctx = ActivityContext::new(ring.clone(), emitter.clone());
        let adapter = RmcpAdapter::new(registry, Some(activity_ctx), McpSurface::ReadOnly);

        let (server_io, client_io) = tokio::io::duplex(4096);
        let server_task = tokio::spawn(async move {
            let server = adapter.serve(server_io).await.expect("server handshake");
            let _ = server.waiting().await;
        });

        let client_info = make_test_client_info();
        let client = client_info
            .serve(client_io)
            .await
            .expect("client handshake");

        let res = client
            .call_tool(CallToolRequestParams::new("definitely-not-search"))
            .await;
        assert!(
            res.is_err(),
            "unknown tool must surface as a JSON-RPC error"
        );

        let _ = client.cancel().await;
        let _ = tokio::time::timeout(std::time::Duration::from_secs(2), server_task).await;

        // Registry sees the call (the dispatcher hands every name to
        // the registry — the mock matches the hand-rolled path's
        // single-name guard).
        assert_eq!(*count.lock().unwrap(), 1);
        // One activity entry pushed for the failed call — the
        // hand-rolled path also emits failure entries so an operator
        // sees agent-attempted-unknown-tool events in the feed.
        assert_eq!(ring.lock().unwrap().entries().len(), 1);
        let emitted = emitter.entries();
        assert_eq!(emitted.len(), 1);
        assert_eq!(emitted[0].tool_name, "definitely-not-search");
        assert!(matches!(emitted[0].result, ActivityResult::Err(_)));
    }

    /// Parity gate. Builds the production
    /// [`crate::mcp::tools_ro::ReadOnlyTools`] registry against a
    /// temp-dir SQLite pool, drives `tools/list` through the
    /// `RmcpAdapter` over rmcp's wire framing, and asserts that
    /// every advertised tool matches the registry's own `list_tools()`
    /// output field-by-field: `name`, `description`, and `inputSchema`.
    ///
    /// `ToolDescription` serialises `input_schema` as `inputSchema`
    /// (camelCase, via `#[serde(rename = "inputSchema")]`); rmcp's
    /// `Tool` model uses `inputSchema` in its JSON wire form too —
    /// no drift to surface here.
    ///
    /// If a future rmcp bump or registry change introduces a drift,
    /// this test pinpoints exactly which field on which tool diverged.
    /// Drive a real `ReadOnlyTools` registry through the rmcp adapter
    /// and assert that the advertised tool list matches the registry's
    /// own `list_tools()` output field-by-field. Pins the wire-format
    /// (`name`, `description`, `inputSchema`) so a future rmcp bump
    /// that subtly changes the `Tool` serialisation surface is caught.
    ///
    /// MCP spec wire-form is `inputSchema` (camelCase). The registry's
    /// `ToolDescription` carries `#[serde(rename = "inputSchema")]` so
    /// the snake_case Rust field name does NOT leak onto the wire; rmcp
    /// exposes the schema as `tool.input_schema: Arc<JsonObject>` on
    /// the Rust side and serialises it as `inputSchema` over JSON-RPC.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn rmcp_tools_list_advertises_full_read_only_registry() {
        use crate::db::init_pool;
        use crate::materializer::Materializer;
        use crate::mcp::tools_ro::ReadOnlyTools;
        use tempfile::TempDir;

        // Build a real ReadOnlyTools registry against a tempdir DB.
        // `list_tools` is static metadata (no DB access), but
        // `ReadOnlyTools::new` requires a valid pool, so wire one up.
        let dir = TempDir::new().expect("tempdir");
        let db_path = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.expect("init_pool");
        let materializer = Materializer::new(pool.clone());
        let registry = Arc::new(ReadOnlyTools::new(
            pool.clone(),
            pool,
            materializer,
            "test-mcp-dev".to_string(),
        ));

        // Direct registry view — what we expect rmcp's tools/list
        // round-trip to surface, modulo the spec's camelCase rename.
        let registry_view = registry.list_tools();
        assert!(
            !registry_view.is_empty(),
            "ReadOnlyTools must advertise at least one tool — test is otherwise vacuous",
        );

        // rmcp adapter path — real client/server pair over duplex.
        let ring = Arc::new(std::sync::Mutex::new(ActivityRing::new()));
        let emitter = Arc::new(RecordingEmitter::new());
        let activity_ctx = ActivityContext::new(ring, emitter);
        let adapter = RmcpAdapter::new(registry, Some(activity_ctx), McpSurface::ReadOnly);

        let (server_io, client_io) = tokio::io::duplex(64 * 1024);
        let server_task = tokio::spawn(async move {
            let server = adapter.serve(server_io).await.expect("server handshake");
            let _ = server.waiting().await;
        });
        let client = make_test_client_info()
            .serve(client_io)
            .await
            .expect("client handshake");

        let rmcp_tools = client
            .list_all_tools()
            .await
            .expect("rmcp tools/list round-trip");

        let _ = client.cancel().await;
        let _ = tokio::time::timeout(std::time::Duration::from_secs(2), server_task).await;

        // Cardinality + field-by-field parity in declaration order.
        // `ReadOnlyTools::list_tools` returns a stable order and rmcp
        // preserves it through framing.
        assert_eq!(
            rmcp_tools.len(),
            registry_view.len(),
            "tools/list cardinality drift: rmcp={} registry={}",
            rmcp_tools.len(),
            registry_view.len(),
        );
        for (idx, (rmcp_tool, expected)) in rmcp_tools.iter().zip(registry_view.iter()).enumerate()
        {
            assert_eq!(
                rmcp_tool.name.as_ref(),
                expected.name,
                "tools[{idx}].name drift: rmcp={:?} registry={:?}",
                rmcp_tool.name,
                expected.name,
            );
            let rmcp_desc = rmcp_tool
                .description
                .as_deref()
                .expect("rmcp tool must carry a description");
            assert_eq!(
                rmcp_desc, expected.description,
                "tools[{idx}].description drift on `{}`: rmcp={rmcp_desc:?} registry={:?}",
                expected.name, expected.description,
            );
            // `Tool::input_schema` is `Arc<JsonObject>`; lift it into
            // a `serde_json::Value` so the equality check is
            // structural rather than pointer-equal.
            let rmcp_schema = Value::Object((*rmcp_tool.input_schema).clone());
            assert_eq!(
                rmcp_schema, expected.input_schema,
                "tools[{idx}].inputSchema drift on `{}`: rmcp={rmcp_schema} registry={}",
                expected.name, expected.input_schema,
            );
        }
    }

    // ---------------------------------------------------------------------
    // Wire-format parity tests.
    //
    // These tests pin the exact JSON envelope shapes produced by the two
    // dispatch shims:
    //   - success: `CallToolResult::structured(value)`
    //   - failure: `ErrorData = app_error_to_rmcp(&err)`
    //
    // If the spec's wire format ever shifts, exactly one assertion fails
    // and points at the drifting shim.
    // ---------------------------------------------------------------------

    /// Pins the success envelope rmcp emits onto the canonical MCP
    /// wire shape. Asserts byte-for-byte against hardcoded JSON literals
    /// across a cross-section of payload shapes (object, array, primitive,
    /// null, empty object) so any future rmcp behaviour change shows up as
    /// a focused diff against a fixed reference.
    #[test]
    fn rmcp_call_tool_result_envelope_matches_canonical_wire_shape() {
        use rmcp::model::CallToolResult;

        // (label, payload, expected envelope serialisation). The
        // expected `content[0].text` is the JSON-stringified payload
        // — what every MCP-2024-11-05 client falls back to when it
        // cannot read `structuredContent`.
        let samples: &[(&str, Value, Value)] = &[
            // `serde_json::to_string` emits map keys in BTreeMap
            // order (alphabetical) for `Value::Object`, so the
            // expected `text` literal must reflect that.
            (
                "object",
                json!({"results": [{"id": "ABC"}], "next_cursor": null}),
                json!({
                    "content": [{
                        "type": "text",
                        "text": r#"{"next_cursor":null,"results":[{"id":"ABC"}]}"#,
                    }],
                    "isError": false,
                    "structuredContent": {"results": [{"id": "ABC"}], "next_cursor": null},
                }),
            ),
            (
                "array",
                json!([1, 2, 3]),
                json!({
                    "content": [{"type": "text", "text": "[1,2,3]"}],
                    "isError": false,
                    "structuredContent": [1, 2, 3],
                }),
            ),
            (
                "empty_object",
                json!({}),
                json!({
                    "content": [{"type": "text", "text": "{}"}],
                    "isError": false,
                    "structuredContent": {},
                }),
            ),
        ];
        for (label, value, expected) in samples {
            let rmcp_envelope = CallToolResult::structured(value.clone());
            let rmcp_json = serde_json::to_value(&rmcp_envelope).expect("rmcp serialise");
            assert_eq!(
                rmcp_json, *expected,
                "{label}: rmcp `CallToolResult::structured` diverged from the \
                 canonical MCP wire shape\n  rmcp={rmcp_json}\n  expected={expected}",
            );
        }
    }

    /// Pins `app_error_to_rmcp` onto its `(code, message)` mapping
    /// for every `AppError` variant the dispatcher hands it. Asserts
    /// against hardcoded reference codes (matching the JSON-RPC
    /// constants in `mcp/server.rs`) so a drift in either rmcp's
    /// `ErrorCode` or the variant→code mapping surfaces as a
    /// focused failure with a clear delta.
    #[test]
    fn rmcp_app_error_to_rmcp_pins_canonical_code_and_message() {
        // (label, error, expected_code, expected_message).
        // -32001 = JSONRPC_RESOURCE_NOT_FOUND, -32602 =
        // JSONRPC_INVALID_PARAMS, -32603 = JSONRPC_INTERNAL_ERROR.
        let cases: &[(&str, AppError, i32, &str)] = &[
            (
                "NotFound → -32001",
                AppError::NotFound("block X missing".into()),
                -32001,
                "Not found: block X missing",
            ),
            (
                "Validation → -32602",
                AppError::Validation("invalid args".into()),
                -32602,
                "Validation error: invalid args",
            ),
            (
                "InvalidOperation → -32602",
                AppError::InvalidOperation("cannot do that".into()),
                -32602,
                "Invalid operation: cannot do that",
            ),
            (
                // #698 — the catch-all arm sends a GENERIC message;
                // the sqlx detail goes to tracing, not the wire. The
                // previous revision of this test pinned the raw
                // "attempted to acquire a connection on a closed pool"
                // string on the wire as intended behaviour — that was
                // the leak, not the contract.
                "Database (catch-all) → -32603",
                AppError::Database(sqlx::Error::PoolClosed),
                -32603,
                super::INTERNAL_ERROR_WIRE_MESSAGE,
            ),
        ];
        for (label, err, expected_code, expected_msg) in cases {
            let rmcp_err = super::app_error_to_rmcp(err);
            assert_eq!(
                rmcp_err.code.0, *expected_code,
                "{label}: code drift; got {} expected {expected_code}",
                rmcp_err.code.0,
            );
            assert_eq!(
                rmcp_err.message.as_ref(),
                *expected_msg,
                "{label}: message drift",
            );
        }
    }

    /// #698 — exhaustive leak guard for the catch-all arm: internal
    /// `AppError` variants must never put their `Display` payload on
    /// the wire. NotFound / Validation / InvalidOperation keep their
    /// crafted, agent-actionable messages (covered above); everything
    /// else collapses to the generic `-32603` sentence.
    #[test]
    fn rmcp_internal_errors_never_leak_detail_to_the_wire() {
        let internal_cases: Vec<(&str, AppError)> = vec![
            ("Database", AppError::Database(sqlx::Error::PoolClosed)),
            (
                "Io",
                AppError::Io(std::io::Error::other("SECRET_OS_DETAIL: fd 7 exploded")),
            ),
            (
                "Json",
                AppError::Json(serde_json::from_str::<serde_json::Value>("{SECRET").unwrap_err()),
            ),
        ];
        for (label, err) in internal_cases {
            let detail = err.to_string();
            let rmcp_err = super::app_error_to_rmcp(&err);
            assert_eq!(rmcp_err.code.0, -32603, "{label}: must map to -32603");
            assert_eq!(
                rmcp_err.message.as_ref(),
                super::INTERNAL_ERROR_WIRE_MESSAGE,
                "{label}: wire message must be the generic sentence",
            );
            assert!(
                !rmcp_err.message.contains(&detail) && !rmcp_err.message.contains("SECRET"),
                "{label}: internal detail {detail:?} leaked onto the wire",
            );
        }
    }

    // -----------------------------------------------------------------
    // #693 — per-surface get_info advertisement
    // -----------------------------------------------------------------

    fn mk_mock_adapter(surface: McpSurface) -> RmcpAdapter<MockRoRegistry> {
        let registry = Arc::new(MockRoRegistry {
            observed_actor: Arc::new(Mutex::new(None)),
            call_count: Arc::new(Mutex::new(0)),
        });
        RmcpAdapter::new(registry, None, surface)
    }

    /// #693 — the RO adapter keeps the historical read-only
    /// advertisement, and the RW adapter must NOT claim to be the
    /// read-only server (agents weight `initialize` instructions
    /// heavily; a read-only claim suppresses legitimate write-tool
    /// use). Nothing asserted what the RW socket advertised before
    /// this test.
    #[test]
    fn rmcp_get_info_instructions_match_surface() {
        let ro_info = mk_mock_adapter(McpSurface::ReadOnly).get_info();
        let ro_instructions = ro_info.instructions.as_deref().unwrap_or_default();
        assert!(
            ro_instructions.contains("read-only"),
            "RO surface must advertise read-only; got {ro_instructions:?}",
        );

        let rw_info = mk_mock_adapter(McpSurface::ReadWrite).get_info();
        let rw_instructions = rw_info.instructions.as_deref().unwrap_or_default();
        assert!(
            rw_instructions.contains("read-write"),
            "RW surface must advertise read-write; got {rw_instructions:?}",
        );
        assert!(
            !rw_instructions.contains("read-only"),
            "RW surface must NOT claim to be the read-only server (#693); got {rw_instructions:?}",
        );
        // Both surfaces keep the same serverInfo implementation name.
        assert_eq!(ro_info.server_info.name, "agaric");
        assert_eq!(rw_info.server_info.name, "agaric");
    }

    /// #693 wire-level twin: drive a real rmcp handshake against an
    /// RW-surface adapter and assert the `initialize` result the
    /// client observes carries the read-write instructions.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn rmcp_rw_surface_advertises_read_write_over_the_wire() {
        let adapter = mk_mock_adapter(McpSurface::ReadWrite);
        let (server_io, client_io) = tokio::io::duplex(4096);
        let server_task = tokio::spawn(async move {
            let server = adapter.serve(server_io).await.expect("server handshake");
            let _ = server.waiting().await;
        });
        let client = make_test_client_info()
            .serve(client_io)
            .await
            .expect("client handshake");
        let info = client.peer_info().expect("initialize result captured");
        let instructions = info.instructions.as_deref().unwrap_or_default();
        assert!(
            instructions.contains("read-write"),
            "wire initialize must advertise read-write; got {instructions:?}",
        );
        let _ = client.cancel().await;
        let _ = tokio::time::timeout(std::time::Duration::from_secs(2), server_task).await;
    }

    // -----------------------------------------------------------------------
    // #1569 — agent-name sanitisation at the op_log.origin trust boundary
    // -----------------------------------------------------------------------

    /// A multi-MiB self-reported `clientInfo.name` must be truncated to the
    /// cap before it can become an `Actor::Agent` label / `op_log.origin`
    /// string — a misbehaving client can otherwise persist an arbitrarily
    /// large blob into the permanent append-only log on every RW call.
    #[test]
    fn sanitize_agent_name_caps_oversized_input() {
        let huge = "a".repeat(4 * 1024 * 1024); // 4 MiB
        let cleaned = sanitize_agent_name(&huge);
        assert_eq!(
            cleaned.chars().count(),
            MAX_AGENT_NAME_LEN,
            "oversized name must be truncated to exactly MAX_AGENT_NAME_LEN chars",
        );
        // And the resulting durable origin tag is correspondingly bounded.
        let origin = Actor::Agent { name: cleaned }.origin_tag();
        assert_eq!(
            origin.chars().count(),
            // "agent:" prefix (6 chars) + the capped name.
            "agent:".chars().count() + MAX_AGENT_NAME_LEN,
            "op_log.origin must be bounded by the agent-name cap",
        );
    }

    /// Truncation must land on a char boundary — a multi-byte scalar is
    /// kept whole or dropped, never split into invalid UTF-8.
    #[test]
    fn sanitize_agent_name_truncates_on_char_boundary() {
        // Each '€' is 3 bytes; far more than the cap so truncation kicks in.
        let multibyte = "€".repeat(MAX_AGENT_NAME_LEN + 50);
        let cleaned = sanitize_agent_name(&multibyte);
        assert_eq!(
            cleaned.chars().count(),
            MAX_AGENT_NAME_LEN,
            "multibyte name truncated to MAX_AGENT_NAME_LEN scalars",
        );
        // Round-trips as valid UTF-8 (would panic on a byte split).
        assert!(cleaned.chars().all(|c| c == '€'));
    }

    /// ASCII control characters (and other Unicode controls) must be
    /// stripped so no control bytes ever reach the append-only log.
    #[test]
    fn sanitize_agent_name_strips_control_chars() {
        let dirty = "cla\0ude\t-de\nsk\x1btop\r";
        let cleaned = sanitize_agent_name(dirty);
        assert_eq!(
            cleaned, "claude-desktop",
            "all control chars (\\0 \\t \\n \\x1b \\r) must be stripped",
        );
        assert!(
            !cleaned.chars().any(|c| c.is_control()),
            "no control char may survive sanitisation",
        );
    }

    /// A normal, well-formed name must pass through unchanged.
    #[test]
    fn sanitize_agent_name_passes_normal_name_unchanged() {
        let name = "claude-desktop";
        assert_eq!(sanitize_agent_name(name), name);
        assert_eq!(sanitize_agent_name("Cursor 0.42"), "Cursor 0.42");
    }

    /// An empty or whitespace-only name (incl. one that is empty *after*
    /// control stripping) must yield the stable placeholder, never an
    /// empty `agent:` label.
    #[test]
    fn sanitize_agent_name_empty_yields_placeholder() {
        assert_eq!(sanitize_agent_name(""), AGENT_NAME_PLACEHOLDER);
        assert_eq!(sanitize_agent_name("   "), AGENT_NAME_PLACEHOLDER);
        // All-control input collapses to empty → placeholder, not "".
        assert_eq!(sanitize_agent_name("\0\t\n\x1b"), AGENT_NAME_PLACEHOLDER);
        // The durable origin is therefore well-formed, never "agent:".
        let origin = Actor::Agent {
            name: sanitize_agent_name(""),
        }
        .origin_tag();
        assert_eq!(origin, format!("agent:{AGENT_NAME_PLACEHOLDER}"));
        assert_ne!(origin, "agent:");
    }
}
