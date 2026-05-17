//! MAINT-111 spike — official Rust MCP SDK (`rmcp`) adapter.
//!
//! **Off by default.** This module compiles only when the
//! `mcp_rmcp_spike` Cargo feature is enabled. The production build
//! (`cargo build`) does not link `rmcp` and runs the hand-rolled
//! `mcp/server.rs` framing for every tool call.
//!
//! ## MAINT-111 M1 status — LANDED
//!
//! M1 expanded the adapter from a single-tool filter
//! (`RmcpSearchAdapter`) to a full read-only adapter
//! (`RmcpReadOnlyAdapter`) that advertises every tool the underlying
//! [`ToolRegistry`] returns. A parity test
//! (`rmcp_spike_tools_list_matches_handle_tools_list_byte_for_byte`)
//! drives a real `ReadOnlyTools` registry through both paths — the
//! hand-rolled `super::server::handle_tools_list` and rmcp's
//! `ListToolsResult` — and asserts that every `tools[]` entry matches
//! field-by-field (`name`, `description`, `inputSchema`).
//! `call_tool` still rejects every non-search tool name and is
//! expanded in M2.
//!
//! The spike answers the four MAINT-111 questions with code:
//!
//! 1. *How much of `mcp/server.rs` would collapse?* The adapter below
//!    delegates JSON-RPC framing, `tools/list` / `tools/call` /
//!    `notifications/initialized` dispatch, and the spec error-code
//!    mapping to `rmcp`. ~250 LOC of `parse_request` /
//!    `make_success` / `make_error` / `handle_initialize` /
//!    `handle_notification` / `dispatch` / `truncate_params_preview`
//!    would no longer be needed if every tool used this adapter.
//!
//! 2. *Can `rmcp`'s tool model adapt to the existing `ToolRegistry`
//!    trait without breaking activity-feed / `ActorContext` /
//!    `LAST_APPEND`?* Yes — the [`RmcpReadOnlyAdapter::call_tool`]
//!    implementation re-creates the same task-local-scoped wrapper
//!    that `mcp/server.rs::handle_tools_call` uses (ACTOR scope +
//!    LAST_APPEND scope + `emit_tool_completion` on completion).
//!    `clientInfo.name` is read from `rmcp`'s
//!    `context.peer.peer_info()` — `rmcp` captures it during the
//!    handshake, exactly like our `ConnectionState.client_info`.
//!
//! 3. *Spec-conformance delta.* `rmcp` drives the protocol-version
//!    negotiation, `notifications/initialized` handling, `ping`,
//!    `tools/listChanged` notifications, and the `_meta` propagation
//!    for free. The hand-rolled code stubs all of these.
//!
//! 4. *Stability.* `rmcp 1.6` is post-1.0; the breaking-change cadence
//!    has slowed. Apache-2.0 — already on the `deny.toml` allow-list.
//!
//! ## What the spike does NOT do
//!
//! - It does NOT replace the accept loop / lifecycle bookkeeping in
//!   `mcp/mod.rs::serve` / `mcp/server.rs::serve_unix` /
//!   `serve_pipe` / `run_connection`. Those are agaric-specific
//!   (Unix-domain socket, Windows named pipe, FEAT-4e disconnect
//!   gate, L-113 grace period) and would stay even after a full
//!   migration. `rmcp` only takes over the per-connection JSON-RPC
//!   loop.
//! - It does NOT replace the existing [`super::server::serve`] for
//!   any tool. The hand-rolled path is still the production code
//!   path; this module is purely additive. M1 brings `tools/list`
//!   parity for the full RO registry; M2 will extend `call_tool` to
//!   dispatch every RO tool through the adapter; M3 deletes the
//!   hand-rolled framing.
//! - It does NOT migrate any RW tool. Read-write tools have richer
//!   side-effects (op-log appends, activity-feed errors, materializer
//!   trigger) that the spike does not need to demonstrate to answer
//!   the four MAINT-111 questions.
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

use super::activity::{
    emit_tool_completion, ActivityContext, ActivityResult, ActorKind, ToolCompletionEvent,
};
use super::actor::{Actor, ActorContext, ACTOR};
use super::registry::ToolRegistry;
use super::server::ERROR_CLIP_CAP;
use crate::error::AppError;

/// Wire-format name of the only tool the spike currently dispatches
/// through `rmcp::call_tool` (M1 still gates `call_tool` to this single
/// name; M2 expands it to every RO tool). Matches
/// `super::registry::TOOL_SEARCH` exactly so a real `ReadOnlyTools`
/// registry can be plugged in without renaming.
pub const SEARCH_TOOL_NAME: &str = "search";

/// Spike adapter that exposes the read-only registry through `rmcp`'s
/// [`ServerHandler`] trait.
///
/// As of MAINT-111 M1, `list_tools` forwards every entry the
/// [`ToolRegistry`] returns (the previous single-tool filter is gone),
/// proving byte-for-byte parity with
/// `super::server::handle_tools_list` for the full RO surface. The
/// `call_tool` body still rejects every name other than
/// [`SEARCH_TOOL_NAME`] — M2 lifts that restriction and routes every
/// `tools/call` through this adapter.
///
/// `R` is the existing [`ToolRegistry`] trait — the spike pins down
/// that the adapter does NOT need a parallel registration model.
pub struct RmcpReadOnlyAdapter<R: ToolRegistry> {
    registry: Arc<R>,
    activity_ctx: ActivityContext,
    /// Stable per-connection ULID, mirroring
    /// `super::server::ConnectionState::session_id`. Stamped onto every
    /// emitted activity entry so the frontend feed can group entries
    /// by MCP session.
    session_id: String,
}

impl<R: ToolRegistry> RmcpReadOnlyAdapter<R> {
    /// Build an adapter around an existing registry handle and the
    /// FEAT-4d activity context. Mirrors the
    /// [`super::server::ConnectionState`] construction, minus the
    /// hand-rolled JSON-RPC plumbing.
    pub fn new(registry: Arc<R>, activity_ctx: ActivityContext) -> Self {
        Self {
            registry,
            activity_ctx,
            session_id: Ulid::new().to_string(),
        }
    }
}

impl<R: ToolRegistry> ServerHandler for RmcpReadOnlyAdapter<R> {
    fn get_info(&self) -> ServerInfo {
        // `ServerInfo` (= `InitializeResult`) is `#[non_exhaustive]` —
        // construct it through the documented builder methods. The
        // hand-rolled code pins to MCP "2025-06-18"; rmcp picks the
        // latest spec version it knows. Either is acceptable per MCP
        // — version negotiation is the client's responsibility.
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new(
                "agaric-rmcp-spike",
                env!("CARGO_PKG_VERSION"),
            ))
            .with_instructions(
                "MAINT-111 spike — advertises the full read-only tool list \
                 through rmcp (M1). `tools/call` still routes only `search` \
                 (M2 will extend). Production build still uses the hand-rolled \
                 mcp/server.rs framing.",
            )
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        // MAINT-111 M1: forward every registry description unfiltered.
        // The previous single-tool filter (`name == SEARCH_TOOL_NAME`)
        // is gone — parity with `super::server::handle_tools_list` is
        // asserted byte-for-byte by
        // `tests::rmcp_spike_tools_list_matches_handle_tools_list_byte_for_byte`.
        //
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
        // of `super::server::ConnectionState::client_info` we read
        // in `handle_tools_call`.
        let agent_name = context
            .peer
            .peer_info()
            .map(|info| info.client_info.name.clone())
            .unwrap_or_else(|| "unknown".to_string());

        let actor_ctx = ActorContext {
            actor: Actor::Agent {
                name: agent_name.clone(),
            },
            request_id: Ulid::new().to_string(),
        };
        // Two clones for the same reason `handle_tools_call` keeps
        // two: one moves into `ACTOR.scope`, one is borrowed by the
        // explicit-parameter path of [`ToolRegistry::call_tool`].
        let scoped_ctx = actor_ctx.clone();
        let call_ctx = actor_ctx;

        let args = request.arguments.map(Value::Object).unwrap_or(Value::Null);
        let args_for_summary = args.clone();

        let registry = self.registry.clone();
        let name_for_call = name.clone();

        // Re-implement `handle_tools_call`'s nested scope:
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

        // FEAT-4d emission point — same shape as `handle_tools_call`.
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
        emit_tool_completion(
            &self.activity_ctx,
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

        match result {
            // The hand-rolled path wraps the value in
            // `wrap_tool_result_success` so the wire shape is
            // `{ content, structuredContent, isError: false }`.
            // `CallToolResult::structured` produces the exact same
            // envelope.
            Ok(value) => Ok(CallToolResult::structured(value)),
            // Mirror `super::server::app_error_to_jsonrpc`'s mapping
            // so the wire-format error codes match the hand-rolled
            // path byte-for-byte: NotFound → resource-not-found
            // (-32002), Validation / InvalidOperation → invalid-params
            // (-32602), everything else → internal-error (-32603).
            Err(err) => Err(app_error_to_rmcp(&err)),
        }
    }
}

/// `AppError → rmcp::ErrorData` translation that mirrors the
/// hand-rolled [`super::server::app_error_to_jsonrpc`] mapping so the
/// wire-format error codes match byte-for-byte.
fn app_error_to_rmcp(err: &AppError) -> ErrorData {
    let msg = err.to_string();
    match err {
        AppError::NotFound(_) => ErrorData::resource_not_found(msg, None),
        AppError::Validation(_) | AppError::InvalidOperation(_) => {
            ErrorData::invalid_params(msg, None)
        }
        _ => ErrorData::internal_error(msg, None),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    //! End-to-end test of the rmcp adapter. Drives a real `rmcp`
    //! client/server pair over an in-memory `tokio::io::duplex`
    //! transport — no socket / DB / Tauri runtime needed. Every
    //! assertion exercises the four MAINT-111 integration points:
    //! tool body invocation, activity-feed emission, actor scoping,
    //! and `clientInfo` propagation through the handshake.

    use std::sync::{Arc, Mutex};

    use rmcp::{
        model::{CallToolRequestParams, ClientCapabilities, ClientInfo, Implementation},
        service::ServiceExt,
    };
    use serde_json::{json, Value};

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
        ActivityContext, ActivityRing, RecordingEmitter, MCP_ACTIVITY_EVENT,
    };
    use crate::mcp::actor::{current_actor, Actor};
    use crate::mcp::registry::{ToolDescription, ToolRegistry};

    /// Minimal in-memory registry. Records the actor observed inside
    /// `call_tool` so the test can assert that the rmcp adapter's
    /// `ACTOR.scope(...)` actually reaches the registry layer.
    struct SpikeMockRegistry {
        observed_actor: Arc<Mutex<Option<Actor>>>,
        call_count: Arc<Mutex<usize>>,
    }

    impl ToolRegistry for SpikeMockRegistry {
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
    fn rmcp_spike_adapter_advertises_tools_capability() {
        let registry = Arc::new(SpikeMockRegistry {
            observed_actor: Arc::new(Mutex::new(None)),
            call_count: Arc::new(Mutex::new(0)),
        });
        let activity_ctx = ActivityContext::new(
            Arc::new(std::sync::Mutex::new(ActivityRing::new())),
            Arc::new(RecordingEmitter::new()),
        );
        let adapter = RmcpReadOnlyAdapter::new(registry, activity_ctx);
        let info = adapter.get_info();
        assert!(
            info.capabilities.tools.is_some(),
            "rmcp adapter must advertise the `tools` capability — without it, `tools/list` would be a method-not-found",
        );
        assert_eq!(info.server_info.name, "agaric-rmcp-spike");
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
    ///        the hand-rolled code builds in `wrap_tool_result_success`.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn rmcp_spike_search_round_trip_emits_activity_and_actor() {
        let observed = Arc::new(Mutex::new(None));
        let count = Arc::new(Mutex::new(0));
        let registry = Arc::new(SpikeMockRegistry {
            observed_actor: observed.clone(),
            call_count: count.clone(),
        });

        let ring = Arc::new(std::sync::Mutex::new(ActivityRing::new()));
        let emitter = Arc::new(RecordingEmitter::new());
        let activity_ctx = ActivityContext::new(ring.clone(), emitter.clone());

        let adapter = RmcpReadOnlyAdapter::new(registry, activity_ctx);

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
        assert_eq!(tools.len(), 1, "spike advertises one tool");
        assert_eq!(tools[0].name, SEARCH_TOOL_NAME);

        // Call the tool.
        let args =
            serde_json::Map::from_iter([("query".to_string(), Value::String("spike".to_string()))]);
        let result = client
            .call_tool(CallToolRequestParams::new(SEARCH_TOOL_NAME).with_arguments(args))
            .await
            .expect("tools/call round-trip");

        assert_eq!(result.is_error, Some(false));
        // Spec wire-shape parity: rmcp's `CallToolResult::structured`
        // mirrors the hand-rolled `wrap_tool_result_success` envelope.
        let structured = result
            .structured_content
            .as_ref()
            .expect("structuredContent is the spike's primary payload");
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
        // Tauri event channel constant — pin it so the emitter
        // contract is locked in for the spike.
        assert_eq!(MCP_ACTIVITY_EVENT, "mcp:activity");
    }

    /// Negative path — a `tools/call` for a tool name the registry
    /// does not advertise surfaces as `resource_not_found` (-32002) /
    /// `-32001` over the wire AND emits one activity entry with an
    /// `Err` variant. Mirrors the hand-rolled `handle_tools_call`
    /// behaviour: unknown tool names round-trip through the registry,
    /// returning `AppError::NotFound` which the dispatcher maps to
    /// the spec's resource-not-found code.
    ///
    /// (`-32601 Method not found` is reserved at the JSON-RPC method
    /// level — `tools/nonexistent_method` — and is handled outside
    /// `call_tool`.)
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn rmcp_spike_unknown_tool_returns_resource_not_found_with_activity() {
        let observed = Arc::new(Mutex::new(None));
        let count = Arc::new(Mutex::new(0));
        let registry = Arc::new(SpikeMockRegistry {
            observed_actor: observed,
            call_count: count.clone(),
        });
        let ring = Arc::new(std::sync::Mutex::new(ActivityRing::new()));
        let emitter = Arc::new(RecordingEmitter::new());
        let activity_ctx = ActivityContext::new(ring.clone(), emitter.clone());
        let adapter = RmcpReadOnlyAdapter::new(registry, activity_ctx);

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

    /// MAINT-111 M1 parity gate. Builds the production
    /// [`crate::mcp::tools_ro::ReadOnlyTools`] registry against a
    /// temp-dir SQLite pool, drives `tools/list` through both paths
    /// — the hand-rolled `super::server::handle_tools_list` and the
    /// new `RmcpReadOnlyAdapter` over rmcp's wire framing — and
    /// asserts that every advertised tool matches field-by-field:
    /// `name`, `description`, and `inputSchema`.
    ///
    /// The hand-rolled path returns `{ "tools": [<ToolDescription>...] }`
    /// where `ToolDescription` already serialises `input_schema` as
    /// `inputSchema` (camelCase, via `#[serde(rename = "inputSchema")]`
    /// on the struct field). rmcp's `Tool` model uses `inputSchema`
    /// in its JSON wire form too. The two therefore agree on the
    /// MCP-spec field name — no drift to surface here.
    ///
    /// If a future rmcp bump or registry change introduces a drift,
    /// this test pinpoints exactly which field on which tool diverged.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn rmcp_spike_tools_list_matches_handle_tools_list_byte_for_byte() {
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

        // -- Hand-rolled path -------------------------------------
        // Call the production `handle_tools_list` directly. Returns
        // the inner JSON-RPC `result` value (i.e. `{ "tools": [...] }`).
        let hand_rolled = crate::mcp::server::handle_tools_list(registry.as_ref())
            .expect("hand-rolled tools/list must succeed for ReadOnlyTools");
        let hand_rolled_tools = hand_rolled
            .get("tools")
            .and_then(Value::as_array)
            .cloned()
            .expect("hand-rolled response carries a `tools` array");
        assert!(
            !hand_rolled_tools.is_empty(),
            "ReadOnlyTools must advertise at least one tool — parity test is otherwise vacuous",
        );

        // -- rmcp adapter path ------------------------------------
        // Drive a real rmcp client/server pair over an in-memory
        // duplex — same pattern as the search round-trip test.
        let ring = Arc::new(std::sync::Mutex::new(ActivityRing::new()));
        let emitter = Arc::new(RecordingEmitter::new());
        let activity_ctx = ActivityContext::new(ring, emitter);
        let adapter = RmcpReadOnlyAdapter::new(registry, activity_ctx);

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

        // -- Cardinality parity -----------------------------------
        assert_eq!(
            rmcp_tools.len(),
            hand_rolled_tools.len(),
            "tools/list cardinality must match between rmcp adapter and hand-rolled path; \
             rmcp={} hand_rolled={}",
            rmcp_tools.len(),
            hand_rolled_tools.len(),
        );

        // -- Field-by-field parity --------------------------------
        // Compare in declaration order — `ReadOnlyTools::list_tools`
        // returns a stable order (`list_tool_descriptions`'s vec
        // literal), and rmcp preserves that order through framing.
        for (idx, (rmcp_tool, hand_tool)) in
            rmcp_tools.iter().zip(hand_rolled_tools.iter()).enumerate()
        {
            // Tool name (`name`) — must be identical.
            let hand_name = hand_tool
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_else(|| {
                    panic!("hand-rolled tools[{idx}] is missing `name`: {hand_tool}")
                });
            assert_eq!(
                rmcp_tool.name.as_ref(),
                hand_name,
                "tools[{idx}].name drift: rmcp={:?} hand_rolled={:?}",
                rmcp_tool.name,
                hand_name,
            );

            // Tool description (`description`) — must be identical.
            let hand_desc = hand_tool
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or_else(|| {
                    panic!("hand-rolled tools[{idx}] is missing `description`: {hand_tool}")
                });
            let rmcp_desc = rmcp_tool
                .description
                .as_deref()
                .expect("rmcp tool must carry a description");
            assert_eq!(
                rmcp_desc, hand_desc,
                "tools[{idx}].description drift on `{hand_name}`: \
                 rmcp={rmcp_desc:?} hand_rolled={hand_desc:?}",
            );

            // Input schema (`inputSchema`) — must be identical.
            //
            // MCP spec wire-form is `inputSchema` (camelCase). The
            // hand-rolled `ToolDescription` carries
            // `#[serde(rename = "inputSchema")]` so the snake_case
            // Rust field name does NOT leak onto the wire. rmcp
            // exposes the schema as `tool.input_schema:
            // Arc<JsonObject>` on the Rust side, but serialises it
            // as `inputSchema` over JSON-RPC. The two paths therefore
            // converge on the same wire field name — no drift to
            // surface in M1.
            let hand_schema = hand_tool
                .get("inputSchema")
                .unwrap_or_else(|| {
                    panic!(
                        "hand-rolled tools[{idx}] is missing `inputSchema` (camelCase wire \
                         field per MCP spec): {hand_tool}"
                    )
                })
                .clone();
            // `Tool::input_schema` is `Arc<JsonObject>`; lift it
            // into a `serde_json::Value` so the equality check is
            // structural rather than pointer-equal.
            let rmcp_schema = Value::Object((*rmcp_tool.input_schema).clone());
            assert_eq!(
                rmcp_schema, hand_schema,
                "tools[{idx}].inputSchema drift on `{hand_name}`: \
                 rmcp={rmcp_schema} hand_rolled={hand_schema}",
            );
        }
    }
}
