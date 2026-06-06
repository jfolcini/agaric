# `src-tauri/src/mcp/` — Model Context Protocol server

> Rules for the MCP read-only + read-write tool surfaces (`tools_ro.rs`, `tools_rw.rs`) and their JSON-RPC framing layer. Root [`AGENTS.md`](../../../AGENTS.md) covers cross-cutting invariants; this file covers what's specific to MCP.

## Production framing = `rmcp` adapter

The production path for MCP `tools/list` and `tools/call` dispatch is **`RmcpReadOnlyAdapter`** in `rmcp_adapter.rs`. The historical hand-rolled JSON-RPC framing in `server.rs` (`make_success`, `parse_request`, `dispatch`, `handle_*`) was deleted in MAINT-111. **Do not reintroduce hand-rolled framing**; if you need a new MCP method, add it via `rmcp`'s `ServerHandler` trait impl.

`run_connection` in `server.rs` is the per-connection lifecycle wrapper: it owns the FEAT-4e disconnect grace period + `McpLifecycle::active_connections` counter, then delegates the wire loop to `adapter.serve(stream)`. **Touch the lifecycle wrapper for connection-level concerns (grace, listener teardown); touch the adapter for tool dispatch.**

## `ToolRegistry` trait — the IPC seam

Both `tools_ro` (read-only) and `tools_rw` (read-write) implement the `ToolRegistry` trait at `src-tauri/src/mcp/registry.rs`:

```rust
pub trait ToolRegistry: Send + Sync {
    fn list_tools(&self) -> Vec<ToolDescription>;
    async fn call_tool(
        &self,
        name: &str,
        args: Value,
        ctx: &ActorContext,
    ) -> Result<Value, AppError>;
}
```

New tools land as new variants of `tools_ro` / `tools_rw`'s internal dispatcher. The trait is generic over the registry; do not add a parallel registration mechanism.

## `ActorContext` + `ACTOR` task-local

Every `tools/call` dispatch runs inside `ACTOR.scope(actor_context, ...)`. Inside that scope, command handlers can read `current_actor()` to know "an agent named X called us" — used for:

- Activity-feed entry's `agent_name` field (`mcp/activity.rs`).
- Op-log `origin` field (so an op authored by an agent is distinguishable from a user op).
- Future per-agent rate-limiting / audit.

The agent name comes from the rmcp client's `clientInfo.name` (set during the MCP handshake). When no `clientInfo` is present, the fallback is `Actor::Agent { name: "unknown" }`.

**Do not bypass `ACTOR.scope`.** A handler that calls a command function without being inside the scope will see `Actor::User` (the default), corrupting the activity feed and op-log origin attribution.

## Activity-feed contract

After every `tools/call` completion, the adapter calls `emit_tool_completion(ctx, ToolCompletionEvent { ... })` (`mcp/activity.rs`). The event carries:

- `tool_name` — the tool that ran.
- `summary` — a privacy-safe one-line summary (built by `mcp/summarise.rs`; per-tool; structural counts + ULID prefixes only, never block content).
- `result` — `ActivityResult::Ok` or `Err(short_message)`.
- `session_id` — the connection's session ULID (stable across the connection's lifetime).
- `op_ref` + `additional_op_refs` — drained from the `LAST_APPEND` task-local; the first op is the primary `OpRef`, the rest are `additionalOpRefs`. **One activity-feed entry per tool call, regardless of how many ops the tool wrote.**

This is automatic; tool handlers don't call it directly. The plumbing is in `RmcpReadOnlyAdapter::call_tool`.

## JSON-RPC error codes

The rmcp framer handles standard JSON-RPC errors (`-32601 Method not found`, `-32602 Invalid params`, `-32700 Parse error`). For application-level "not found" errors, agaric uses a custom code `-32001 JSONRPC_RESOURCE_NOT_FOUND` (defined in `mcp/server.rs`). Distinct from JSON-RPC's `-32601`:

- `-32601` = "the JSON-RPC method endpoint doesn't exist" (`tools/nonexistent`).
- `-32001` = "the resource named in the call arguments doesn't exist" (an unknown tool name, an unknown block id inside a tool's args).

This is mapped from `AppError::NotFound` by `app_error_to_rmcp` in `rmcp_adapter.rs`. Agents can discriminate the two: "I called a method that doesn't exist" vs "I asked for a thing that doesn't exist".

## `ERROR_CLIP_CAP`

When a tool errors, the activity feed clips the error message to 200 Unicode scalars (`ERROR_CLIP_CAP` in `mcp/server.rs`). Char-based clipping always lands on a UTF-8 boundary; safe to serialise as JSON. Long error chains don't bloat the feed.

## L-113 disconnect grace period

When `mcp_disconnect_all` fires while a `tools/call` is mid-flight, `run_connection`'s `select!` wraps the in-flight future in `tokio::time::timeout(MCP_DISCONNECT_GRACE_PERIOD, fut)` so the call gets up to 2 s to return its reply before the stream is dropped. **The DB layer commits before any further `.await`, so cancellation safety is preserved either way** — the grace period only affects whether the agent sees the reply / whether the activity feed sees the entry.

Do not lower the cap below 2 s without checking the slowest tool's p95 latency.

## Read-only vs read-write surfaces

- **`tools_ro.rs`** mounts on the RO socket / pipe. Tools that don't mutate state (search, list, fetch). Lives at one socket path.
- **`tools_rw.rs`** mounts on the RW socket / pipe. Tools that DO mutate state (delete, update, create, tag, untag, etc.). Lives at a separate socket path.

Two pipes / two sockets is a deliberate split: an agent can connect to the RO surface only, get a guaranteed-no-mutation contract, and the user can disable the RW surface independently. The H-2 enable/disable gate (`McpLifecycle::enabled`) flips them independently.

**Do not cross-pollute.** A read-only tool that needs to write (e.g. caching) goes through a normal command handler; it doesn't grow a mutation path on the RO surface.

## Testing

- **`tools_ro::tests` + `tools_rw::tests`** cover input validation + happy path + at least one error path per tool. Use `test_pool()` + materializer fixture.
- **`rmcp_adapter::tests`** covers the adapter end-to-end (parity tests against canonical wire JSON, search round-trip, unknown-tool error mapping).
- **`server::tests` + `server::tests_rmcp`** cover the lifecycle wrapper (`run_connection`, H-2 shutdown gate, L-113 grace period).

New tools require a matching test in `tools_ro::tests` or `tools_rw::tests`. New protocol-error paths require a test in `server/tests_rmcp.rs`.

## Cross-references

- Root [`AGENTS.md`](../../../AGENTS.md) §Backend Architecture.
- [`src-tauri/src/commands/AGENTS.md`](../commands/AGENTS.md) — `LAST_APPEND` task-local + `_inner` pattern that tools call into.
- [`docs/architecture/search.md`](../../../docs/architecture/search.md) — high-level search architecture (the MCP `search` tool's twin).
- `src-tauri/src/mcp/rmcp_adapter.rs` — the production adapter.
- `src-tauri/src/mcp/activity.rs` — activity-feed emission.
