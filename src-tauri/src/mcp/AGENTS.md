# `src-tauri/src/mcp/` — Model Context Protocol server

> Rules for the MCP read-only and read-write tool surfaces (`tools_ro.rs`, `tools_rw.rs`) and their JSON-RPC framing. Root [`AGENTS.md`](../../../AGENTS.md) covers cross-cutting invariants.

## File map

- `rmcp_adapter.rs` — `RmcpAdapter`, the production `tools/list` / `tools/call` path; `sanitize_agent_name`, `durable_agent_name`, `app_error_to_rmcp`.
- `server.rs` — `run_connection` lifecycle wrapper; error-code and grace-period constants.
- `registry.rs` — `ToolRegistry` trait. `dispatch.rs` — `scoped_dispatch` (`ACTOR.scope` wrapper). `handler_utils.rs` — `parse_args` / `to_tool_result`.
- `tools_ro.rs` / `tools_rw.rs` — tool handlers; tests in `tools_ro/tests.rs`, `tools_rw/tests.rs`.
- `activity.rs` — `emit_tool_completion`; `summarise.rs` — per-tool summaries; `view_notify.rs` — change events so open views reload after an RW write.

## Production framing = `rmcp` adapter

`RmcpAdapter` (`rmcp_adapter.rs`) serves both surfaces, parameterised on `McpSurface` so `get_info` advertises the surface it fronts. Hand-rolled JSON-RPC framing was deleted; a new MCP method goes through `rmcp`'s `ServerHandler` impl.

`run_connection` (`server.rs`) owns the per-connection lifecycle (grace period, `McpLifecycle::active_connections`) and delegates the wire loop to `adapter.serve(stream)`. Connection-level concerns go in the wrapper; tool dispatch goes in the adapter.

## `ToolRegistry` trait — the IPC seam

`tools_ro` and `tools_rw` both implement `ToolRegistry` (`registry.rs`):

```rust
pub trait ToolRegistry: Send + Sync + 'static {
    fn list_tools(&self) -> Vec<ToolDescription>;
    fn call_tool(&self, name: &str, args: Value, ctx: &ActorContext)
        -> impl Future<Output = Result<Value, AppError>> + Send;
}
```

A new tool is a new match arm inside the registry's `scoped_dispatch` closure plus a `list_tools` entry. Do not add a parallel registration mechanism.

## `ActorContext` + `ACTOR` task-local

Every `tools/call` runs inside `ACTOR.scope(actor_context, …)`; command handlers read `current_actor()` to attribute the call to an agent — the activity feed's `agent_name` and the op-log `origin` column. **Never call a command function outside the scope**: it sees `Actor::User` and misattributes the write.

The agent name is the rmcp client's `clientInfo.name`, sanitised once at the trust boundary by `sanitize_agent_name` (control chars stripped, trimmed, capped at `MAX_AGENT_NAME_LEN` = 128 chars, `"unknown"` when nothing printable remains) — the only chance to bound an attacker-controlled string before it lands in the append-only `op_log.origin`. Two labels result:

- Activity feed: the bare sanitised name, with `session_id` carried separately.
- `op_log.origin`: `durable_agent_name` — `agent:<name>` for a named client, `agent:unknown:<session-ulid>` for an anonymous one so simultaneous anonymous agents stay distinguishable. Both keep the `agent:` prefix for `LIKE 'agent:%'` consumers.

## Activity-feed contract

After every `tools/call`, `RmcpAdapter::call_tool` calls `emit_tool_completion(ctx, ToolCompletionEvent { … })` (`activity.rs`). Handlers never call it directly. The event carries:

- `tool_name`.
- `summary` — built per tool by `summarise.rs`. May include structural counts, dates, property keys, number/date/bool property values, and eight-character ULID prefixes. Never block content, page titles, tag display names, search queries, or `value_text`.
- `result` — `ActivityResult::Ok` or `Err(short_message)`, clipped to `ERROR_CLIP_CAP` (200 chars, `server.rs`).
- `session_id` — the connection's ULID.
- `op_ref` + `additional_op_refs` — drained from the `LAST_APPEND` task-local. One entry per tool call, however many ops it wrote.

## JSON-RPC error codes

`app_error_to_rmcp` (`rmcp_adapter.rs`) is the single `AppError → wire` mapping; keep its three arms in sync with this list:

- `AppError::NotFound` → `-32001` (`JSONRPC_RESOURCE_NOT_FOUND`, `server.rs`): the tool or resource named in the arguments doesn't exist. rmcp's `-32601` means the JSON-RPC method doesn't exist.
- `AppError::Validation`, `AppError::InvalidOperation` and `AppError::Ulid` → `-32602`, keeping the agent-actionable `Display` message. A malformed ULID is a bad argument, not a server fault (#3301).
- Everything else → `-32603` with the generic `INTERNAL_ERROR_WIRE_MESSAGE`; the real chain goes to `tracing::error!(target: "mcp", …)`. Internal variants embed sqlx / OS detail that must not reach a client, so never put `err.to_string()` on the catch-all arm.

## Disconnect grace period

When `mcp_disconnect_all` fires mid-call, `run_connection` wraps the in-flight future in `tokio::time::timeout(MCP_DISCONNECT_GRACE_PERIOD, fut)` (2 s, `server.rs`) so the reply and activity entry can land before the stream drops. The DB layer commits before any further `.await`, so cancellation is safe either way. Don't lower the cap without checking the slowest tool's p95 latency.

## Read-only vs read-write surfaces

- `tools_ro.rs` mounts on the RO socket / pipe: search, list, fetch.
- `tools_rw.rs` mounts on the RW socket / pipe: create, update, delete, tag, untag, ….

Separate sockets let an agent connect to RO only and let the user disable RW independently (`McpLifecycle::enabled`). A read-only tool that needs to write belongs on the RW surface; do not add a mutation path to RO beyond the one carve-out below.

### `journal_for_date` — bounded create carve-out (#2719)

`handle_journal_for_date` (`tools_ro.rs`) is the one RO tool with a write side-effect: on a lookup miss it emits `CreateBlock` + `SetProperty(space)` for the missing journal page, but only when `date` is within today ± `JOURNAL_CREATE_WINDOW_MONTHS` (12; `within_journal_create_window`). Outside the window a missing page is `AppError::NotFound`; inside it the call is idempotent per `(space_id, date)`. The bound exists because the op log is append-only — an unbounded date range let the RO socket append millions of unreclaimable ops. If you touch this, update the Settings tooltip too (`agentAccess.roToggleDescription` in `src/lib/i18n/settings.ts`).

### Full-vault RO scope (no per-space isolation)

The RO surface is vault-wide by design: `list_spaces` (`handle_list_spaces` → `list_spaces_registry_inner`) returns every space, and RO readers accept any `space_id`. Per-space isolation would have to gate `list_spaces` and filter every RO reader.

## Testing

No single test drives the full production stack; the layers are covered separately:

- `tools_ro/tests.rs`, `tools_rw/tests.rs` — validation, happy path, and one error path per tool via `registry.call_tool()` against a real `test_pool()` DB. **Every new tool needs a test here.**
- `rmcp_adapter::tests` — wire framing over `tokio::io::duplex`, mostly against `MockRoRegistry`.
- `server/tests.rs`, `server/tests_rmcp.rs` — `run_connection`, shutdown gate, grace period against a real `UnixListener` with stub registries. **Every new protocol-error path needs a test in `server/tests_rmcp.rs`.**
- `stub_binary_roundtrips_initialize_over_uds` (`mod.rs`, `ci-smoke` feature) spawns the real `agaric-mcp` binary but only round-trips `initialize`.
- `scripts/mcp_smoke.py` — the only real `tools/call` through the full stack, against a live `cargo tauri dev`. Manual only; never in CI.

```sh
cd src-tauri && cargo nextest run -p agaric -E 'test(mcp::)'
```

## Cross-references

- [`src-tauri/src/commands/AGENTS.md`](../commands/AGENTS.md) — `LAST_APPEND` task-local + `_inner` pattern that tools call into.
- [`docs/architecture/search.md`](../../../docs/architecture/search.md) — architecture behind the MCP `search` tool.
