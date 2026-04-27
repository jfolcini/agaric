//! Tool-registry trait shared by every MCP server surface.
//!
//! FEAT-4a shipped a marker placeholder trait + `PlaceholderRegistry` struct
//! so the generic parameter on `server::serve` could land early. FEAT-4b
//! (this file) replaces the marker with the real contract:
//!
//! ```text
//! trait ToolRegistry {
//!     fn list_tools() -> Vec<ToolDescription>;
//!     async fn call_tool(name, args, ctx) -> Result<Value, AppError>;
//! }
//! ```
//!
//! The trait is deliberately DB-pool-free: each impl owns its own
//! `Arc<SqlitePool>` rather than taking one via the trait. FEAT-4c will
//! land a `ReadOnlyTools` impl that holds its pool internally; FEAT-4h's
//! `ReadWriteTools` will do the same with the writer pool.
//!
//! `call_tool` returns a future with an explicit `+ Send` bound so the
//! server can `await` it across `tokio::spawn` boundaries. This uses
//! return-position impl-trait-in-trait (RPITIT, stable since Rust 1.75)
//! rather than `async fn in trait` so the `Send` requirement is explicit
//! at the definition site.

use std::future::Future;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::actor::ActorContext;
use crate::error::AppError;

// ---------------------------------------------------------------------------
// MCP tool-name constants (MAINT-136)
//
// One `pub(crate) const TOOL_<NAME>: &str = "<name>";` per advertised MCP
// tool. These are the single source of truth for the wire-format tool name
// used at four otherwise-duplicated sites:
//
//   1. `ToolDescription` schema construction (`tool_desc_*` in
//      `tools_ro.rs` / `tools_rw.rs`) — the `name:` field.
//   2. `call_tool` match arms (in `tools_ro.rs` / `tools_rw.rs`).
//   3. `parse_args` error-prefix string ("<tool>: invalid arguments — …").
//   4. `summarise.rs` privacy-summary match.
//
// Tests that intentionally pin the wire-format string (snapshot ordering
// asserts, JSON-RPC envelope assertions, `activity.rs` debug serialisations)
// still use the bare literal — they are part of the wire contract being
// asserted, not internal call sites.
//
// Constants chosen over a `ToolName` enum because every internal call site
// matches against `&str` (JSON-RPC `params.name`, `serde_json` arg
// envelopes); converting through an enum + `From<&str>` would add a parsing
// step at each dispatch with no offsetting type-system benefit.
// ---------------------------------------------------------------------------

// Read-only tool names (`tools_ro.rs`).
pub(crate) const TOOL_LIST_PAGES: &str = "list_pages";
pub(crate) const TOOL_GET_PAGE: &str = "get_page";
pub(crate) const TOOL_SEARCH: &str = "search";
pub(crate) const TOOL_GET_BLOCK: &str = "get_block";
pub(crate) const TOOL_LIST_BACKLINKS: &str = "list_backlinks";
pub(crate) const TOOL_LIST_TAGS: &str = "list_tags";
pub(crate) const TOOL_LIST_PROPERTY_DEFS: &str = "list_property_defs";
pub(crate) const TOOL_GET_AGENDA: &str = "get_agenda";
pub(crate) const TOOL_JOURNAL_FOR_DATE: &str = "journal_for_date";

// Read-write tool names (`tools_rw.rs`).
pub(crate) const TOOL_APPEND_BLOCK: &str = "append_block";
pub(crate) const TOOL_UPDATE_BLOCK_CONTENT: &str = "update_block_content";
pub(crate) const TOOL_SET_PROPERTY: &str = "set_property";
pub(crate) const TOOL_ADD_TAG: &str = "add_tag";
pub(crate) const TOOL_CREATE_PAGE: &str = "create_page";
pub(crate) const TOOL_DELETE_BLOCK: &str = "delete_block";

/// Metadata returned by [`ToolRegistry::list_tools`] — one entry per
/// advertised tool. The JSON shape matches MCP's `tools/list` response:
/// `{"name": "...", "description": "...", "inputSchema": {...}}`.
///
/// `input_schema` is a free-form JSON Schema blob. Impls typically build
/// it with `serde_json::json!` rather than a typed struct so schema
/// evolution (adding optional fields) is additive.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDescription {
    /// Stable machine-readable tool name. Must not collide within a single
    /// registry. Treated case-sensitively by [`ToolRegistry::call_tool`].
    pub name: String,
    /// Human-readable one-line description surfaced to the agent.
    pub description: String,
    /// JSON Schema describing the accepted `arguments` object for
    /// `tools/call`. Serialised as `inputSchema` to match the MCP wire
    /// format.
    #[serde(rename = "inputSchema")]
    pub input_schema: Value,
}

/// Contract implemented by each MCP tool registry (read-only in v1,
/// read-write in v2). The server holds the registry behind an `Arc` and
/// dispatches every `tools/list` / `tools/call` through this trait.
///
/// The trait is `Send + Sync + 'static` so it can be cloned into spawned
/// per-connection tasks. `call_tool`'s returned future is explicitly
/// `Send` so `tokio::spawn` can drive it.
pub trait ToolRegistry: Send + Sync + 'static {
    /// Enumerate every tool exposed by this registry. Called once per
    /// `tools/list` request — impls are expected to be cheap (static
    /// metadata with no DB access).
    fn list_tools(&self) -> Vec<ToolDescription>;

    /// Dispatch a single `tools/call` request. Returns the tool's JSON
    /// result payload on success, or an [`AppError`] that the server
    /// translates into a JSON-RPC error envelope:
    ///
    /// - `AppError::NotFound` for unknown tool names / missing resources
    ///   → `-32001` (resource-not-found; kept distinct from `-32601`
    ///   method-not-found so agents can tell them apart).
    /// - `AppError::Validation` for bad arguments → `-32602`.
    /// - everything else → `-32603` (internal) with the `AppError`
    ///   message bubbled up.
    ///
    /// `ctx` carries the `Actor` + `request_id` that the server scoped
    /// via `ACTOR.scope(...)` — impls read the same context from the
    /// task-local via `current_actor()` if they need it, but receiving
    /// `ctx` as a parameter makes the plumbing explicit at the call site
    /// and lets the FEAT-4c tools stamp `request_id` into tool-specific
    /// logs without reaching into `ACTOR` themselves.
    fn call_tool(
        &self,
        name: &str,
        args: Value,
        ctx: &ActorContext,
    ) -> impl Future<Output = Result<Value, AppError>> + Send;
}

/// No-op registry used by FEAT-4a/4b until FEAT-4c lands `ReadOnlyTools`.
/// Advertises zero tools and rejects every `tools/call`. Retained for the
/// `spawn_mcp_ro_task` default path and for `handle_connection` tests.
#[derive(Default, Debug, Clone, Copy)]
pub struct PlaceholderRegistry;

impl ToolRegistry for PlaceholderRegistry {
    fn list_tools(&self) -> Vec<ToolDescription> {
        Vec::new()
    }

    async fn call_tool(
        &self,
        name: &str,
        _args: Value,
        _ctx: &ActorContext,
    ) -> Result<Value, AppError> {
        // Surface as AppError::NotFound so the server emits `-32001`
        // (resource-not-found — the tool name does not exist in this
        // registry).
        Err(AppError::NotFound(format!(
            "Tool `{name}` not found (no tools registered in FEAT-4a/4b)"
        )))
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::actor::{Actor, ActorContext};
    use serde_json::json;

    fn test_ctx() -> ActorContext {
        ActorContext {
            actor: Actor::Agent {
                name: "test-agent".to_string(),
            },
            request_id: "req-placeholder".to_string(),
        }
    }

    #[test]
    fn placeholder_registry_list_tools_returns_empty() {
        let registry = PlaceholderRegistry;
        let tools = registry.list_tools();
        assert_eq!(
            tools.len(),
            0,
            "PlaceholderRegistry exposes zero tools; FEAT-4c adds them",
        );
    }

    #[tokio::test]
    async fn placeholder_registry_call_tool_returns_not_found() {
        let registry = PlaceholderRegistry;
        let ctx = test_ctx();
        let result = registry
            .call_tool("search", json!({"query": "anything"}), &ctx)
            .await;
        match result {
            Err(AppError::NotFound(msg)) => {
                assert!(
                    msg.contains("search"),
                    "not-found message should name the tool; got {msg:?}",
                );
            }
            other => {
                panic!("expected AppError::NotFound (server translates to -32001), got {other:?}",)
            }
        }
    }

    #[tokio::test]
    async fn placeholder_registry_call_tool_echoes_unknown_name_in_error() {
        let registry = PlaceholderRegistry;
        let ctx = test_ctx();
        let result = registry
            .call_tool("completely/unknown", Value::Null, &ctx)
            .await;
        match result {
            Err(AppError::NotFound(msg)) => {
                assert!(
                    msg.contains("completely/unknown"),
                    "error message should echo the requested name; got {msg:?}",
                );
            }
            other => panic!("expected NotFound, got {other:?}"),
        }
    }

    #[test]
    fn tool_description_serialises_input_schema_as_camel_case() {
        let desc = ToolDescription {
            name: "ping".to_string(),
            description: "health check".to_string(),
            input_schema: json!({"type": "object", "properties": {}}),
        };
        let wire: Value = serde_json::to_value(&desc).expect("serialize");
        // MCP wire format uses `inputSchema` (camelCase), not `input_schema`.
        assert!(
            wire.get("inputSchema").is_some(),
            "input_schema must serialise as `inputSchema` for MCP parity; got {wire}",
        );
        assert!(
            wire.get("input_schema").is_none(),
            "raw snake_case field must not leak onto the wire; got {wire}",
        );
        assert_eq!(wire["name"], "ping");
        assert_eq!(wire["description"], "health check");
    }

    #[test]
    fn tool_description_roundtrips_through_serde() {
        let original = ToolDescription {
            name: "search".to_string(),
            description: "full-text search across all notes".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": { "query": { "type": "string" } },
                "required": ["query"],
            }),
        };
        let wire = serde_json::to_value(&original).unwrap();
        let parsed: ToolDescription = serde_json::from_value(wire).unwrap();
        assert_eq!(parsed.name, original.name);
        assert_eq!(parsed.description, original.description);
        assert_eq!(parsed.input_schema, original.input_schema);
    }

    /// Compile-time assertion: the trait must be usable through an `Arc` in
    /// spawned tasks. If this ever fails to compile the `Send + Sync +
    /// 'static` bounds on `ToolRegistry` have regressed.
    #[test]
    fn placeholder_registry_is_send_sync_static() {
        fn assert_bounds<T: Send + Sync + 'static>() {}
        assert_bounds::<PlaceholderRegistry>();
    }

    /// Compile-time assertion: `call_tool`'s future must be `Send` so the
    /// server can drive it across a `tokio::spawn` boundary.
    #[tokio::test]
    async fn placeholder_registry_call_tool_future_is_send() {
        fn assert_send_future<F: Future + Send>(_: &F) {}
        let registry = PlaceholderRegistry;
        let ctx = test_ctx();
        let fut = registry.call_tool("x", Value::Null, &ctx);
        assert_send_future(&fut);
        // Actually drive it to completion so the future isn't dropped
        // without polling (clippy: let_underscore_future).
        let _ = fut.await;
    }
}
