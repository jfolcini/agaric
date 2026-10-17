# `src-tauri/src/mcp/` — Model Context Protocol server

Tools call into the `_inner` commands and their `LAST_APPEND` op-ref chain: [`commands/AGENTS.md`](../commands/AGENTS.md).

## File map

- `rmcp_adapter.rs` — `RmcpAdapter`, the production `tools/list` / `tools/call` path; `sanitize_agent_name`, `durable_agent_name`, `app_error_to_rmcp`.
- `server.rs` — `run_connection` lifecycle wrapper; error-code and grace-period constants.
- `registry.rs` — `ToolRegistry` trait. `dispatch.rs` — `scoped_dispatch` (`ACTOR.scope` wrapper). `handler_utils.rs` — `parse_args` / `to_tool_result`.
- `tools_ro.rs` / `tools_rw.rs` — tool handlers; tests in `tools_ro/tests.rs`, `tools_rw/tests.rs`.
- `activity.rs` — `emit_tool_completion`; `summarise.rs` — per-tool summaries; `view_notify.rs` — change events so open views reload after an RW write.
- `agents.rs` — the device-local `mcp_agents` rows (#5667) and `MAX_AGENT_NAME_LEN`; Settings reaches them through `commands/mcp_agents.rs`.

## Production framing = `rmcp` adapter

`RmcpAdapter` serves both surfaces, parameterised on `McpSurface` so `get_info` advertises the surface it fronts. A new MCP method goes through its `rmcp` `ServerHandler` impl, never hand-rolled JSON-RPC.

`run_connection` owns the per-connection lifecycle (grace period, `McpLifecycle::active_connections`) and delegates the wire loop to `adapter.serve(stream)`. Connection-level concerns go in the wrapper; tool dispatch goes in the adapter.

## `ToolRegistry` trait — the IPC seam

`tools_ro` and `tools_rw` both implement `ToolRegistry`:

```rust
pub trait ToolRegistry: Send + Sync + 'static {
    fn list_tools(&self) -> Vec<ToolDescription>;
    fn call_tool(&self, name: &str, args: Value, ctx: &ActorContext)
        -> impl Future<Output = Result<Value, AppError>> + Send;
}
```

A new tool is a new match arm inside the registry's `scoped_dispatch` closure plus a `list_tools` entry. Do not add a parallel registration mechanism.

## `ActorContext` + `ACTOR` task-local

Every `tools/call` runs inside `ACTOR.scope(actor_context, …)`; command handlers read `current_actor()` for the activity feed's `agent_name` and the op-log `origin`. **Never call a command function outside the scope**: it sees `Actor::User` and misattributes the write.

The agent name is the client's `clientInfo.name`, sanitised once by `sanitize_agent_name` (control chars stripped, trimmed, capped at `MAX_AGENT_NAME_LEN`, `"unknown"` when nothing printable remains) before it can land in the append-only `op_log.origin`. Two labels result:

- Activity feed: the bare sanitised name, with `session_id` carried separately.
- `op_log.origin`: `durable_agent_name` — `agent:<name>` for a named client, `agent:unknown:<session-ulid>` for an anonymous one so simultaneous anonymous agents stay distinguishable. Both keep the `agent:` prefix for `LIKE 'agent:%'` consumers.

## Activity-feed contract

`RmcpAdapter::call_tool` calls `emit_tool_completion` after every `tools/call`; handlers never call it directly. The event carries:

- `tool_name`.
- `summary` — built per tool by `summarise.rs`. May include structural counts, dates, property keys, number/date/bool property values, and eight-character ULID prefixes of ids taken from the result, or of an argument that parses as a ULID (`id_arg_prefix`): an id argument may be a page title or tag name. Never block content, page titles, tag display names, search queries, or `value_text`.
- `result` — `ActivityResult::Ok` or `Err(short_message)`, clipped to `ERROR_CLIP_CAP`.
- `session_id` — the connection's ULID.
- `op_ref` + `additional_op_refs` — drained from the `LAST_APPEND` task-local. One entry per tool call, however many ops it wrote, so a consumer that reverts it (`ActivityFeed.tsx`'s Undo and session revert) sends every ref, and `useMcpActivityFeed.ts` keeps them all.

An RW write tells open views to reload through `view_notify.rs`. A tool that touches no page (a top-level tag) emits no `blocks:changed`: the frontend reads an empty page set as "reload every mounted page".

## JSON-RPC error codes

`app_error_to_rmcp` is the single `AppError → wire` mapping; keep its three arms in sync with this list:

- `AppError::NotFound` → `-32001` (`JSONRPC_RESOURCE_NOT_FOUND`): the tool or resource named in the arguments doesn't exist. rmcp's `-32601` means the JSON-RPC method doesn't exist.
- `AppError::Validation`, `AppError::InvalidOperation` and `AppError::Ulid` → `-32602`, keeping the agent-actionable `Display` message. A malformed ULID is a bad argument, not a server fault (#3301).
- Everything else → `-32603` with the generic `INTERNAL_ERROR_WIRE_MESSAGE`; the real chain goes to `tracing::error!(target: "mcp", …)`. Internal variants embed sqlx / OS detail that must not reach a client, so never put `err.to_string()` on the catch-all arm.

## Disconnect grace period

When `mcp_disconnect_all` fires mid-call, `run_connection` gives the in-flight call `MCP_DISCONNECT_GRACE_PERIOD` so the reply and activity entry can land before the stream drops. Don't lower it below the slowest tool's p95 latency.

## Read-only vs read-write surfaces

- `tools_ro.rs` mounts on the RO socket / pipe: search, list, fetch.
- `tools_rw.rs` mounts on the RW socket / pipe: create, update, delete, tag, move to space, …, then every `tools_ro` tool through the `ReadOnlyTools` it holds. A read tool is added to `tools_ro.rs` only.

Separate sockets let an agent connect to RO only and let the user disable RW independently (`McpLifecycle::enabled`). RW is a superset, so disabling RO does not stop an RW client reading. A read-only tool that needs to write belongs on the RW surface; do not add a mutation path to RO beyond the one carve-out below.

### `journal_for_date` — bounded create carve-out (#2719)

`handle_journal_for_date` is the one RO tool with a write side-effect: on a miss it creates the journal page, but only when `date` is within today ± `JOURNAL_CREATE_WINDOW_MONTHS` (`within_journal_create_window`); outside it a missing page is `AppError::NotFound`. The bound keeps the RO socket from appending unbounded, unreclaimable ops. If you touch this, update the Settings tooltip (`agentAccess.roToggleDescription` in `src/lib/i18n/settings.ts`).

### Space scoping (no per-space isolation)

Every tool requires `space_id` except `list_spaces` and `list_property_defs` (property definitions are vault-wide), and confines the call to that space: listings return its rows, and a tool that addresses a block or page by id rejects a target in another space (`validate_block_in_space`, or `get_page_inner` for `get_page`). It is not isolation: `list_spaces` returns every space and any tool accepts any of them.

An RW tool checks inside its own write transaction through `with_space_guard` (`handler_utils.rs`), never a separate transaction before it. The guard fails open unless the write opens a `CommandTx` in the same task, so a new guarded tool joins `each_write_tool_opens_one_command_transaction_5402`.

A change to what a tool requires or returns updates, in the same PR, its `list_tools` description, the surface's `instructions()` primer (`mod.rs`), `docs/features/agent-access.md`, `docs/architecture/integrations.md` and `docs/architecture/threat-model.md`. Grep them for the old wording.

## Testing

No single test drives the full production stack:

- `tools_ro/tests.rs`, `tools_rw/tests.rs` — validation, happy path, and one error path per tool via `registry.call_tool()` against a real DB. **Every new tool needs a test here.** Summariser tests use ids that differ within their first eight characters, or a swapped id prints the same prefix.
- `rmcp_adapter::tests` — wire framing over `tokio::io::duplex`, mostly against `MockRoRegistry`.
- `server/tests.rs`, `server/tests_rmcp.rs` — `run_connection`, shutdown gate, grace period against a real `UnixListener` with stub registries. **Every new protocol-error path needs a test in `server/tests_rmcp.rs`.**
- `stub_binary_roundtrips_initialize_over_uds` (`mod.rs`, `ci-smoke` feature) spawns the real `agaric-mcp` binary but only round-trips `initialize`.

```sh
cd src-tauri && cargo nextest run -p agaric -E 'test(mcp::)'
```

## Windows

`#[cfg(windows)]` arms (named pipes in `mod.rs` and `server.rs`) are not compiled on Linux and only `release.yml` builds Windows, so a broken arm surfaces at tag time. After changing one arm, change its siblings too.
