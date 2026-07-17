# `src-tauri/src/mcp/` — Model Context Protocol server

> Rules for the MCP read-only + read-write tool surfaces (`tools_ro.rs`, `tools_rw.rs`) and their JSON-RPC framing layer. Root [`AGENTS.md`](../../../AGENTS.md) covers cross-cutting invariants; this file covers what's specific to MCP.

## Production framing = `rmcp` adapter

The production path for MCP `tools/list` and `tools/call` dispatch is **`RmcpAdapter`** in `rmcp_adapter.rs` (renamed from `RmcpReadOnlyAdapter` in #693 — it serves BOTH surfaces, parameterised on `McpSurface` so `get_info` advertises the surface it actually fronts). The historical hand-rolled JSON-RPC framing in `server.rs` (`make_success`, `parse_request`, `dispatch`, `handle_*`) was deleted in. **Do not reintroduce hand-rolled framing**; if you need a new MCP method, add it via `rmcp`'s `ServerHandler` trait impl.

`run_connection` in `server.rs` is the per-connection lifecycle wrapper: it owns the disconnect grace period + `McpLifecycle::active_connections` counter, then delegates the wire loop to `adapter.serve(stream)`. **Touch the lifecycle wrapper for connection-level concerns (grace, listener teardown); touch the adapter for tool dispatch.**

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

The agent name comes from the rmcp client's `clientInfo.name` (set during the MCP handshake), **sanitized once at the trust boundary** by `sanitize_agent_name` (#1569): ASCII/Unicode control chars stripped, surrounding whitespace trimmed, truncated to `MAX_AGENT_NAME_LEN` (128) chars on a char boundary, and falling back to the `"unknown"` placeholder when nothing printable remains (or when `peer_info()` is absent). This cleaned value flows verbatim through `Actor::Agent` → `Actor::origin_tag` → the append-only `op_log.origin` column, so the sanitisation is the only chance to bound an attacker-controlled string before it is durably persisted.

Two distinct labels come out of this:

- **Activity feed** keeps the bare sanitized `agent_name` for display (it carries the per-connection `session_id` separately).
- **Durable `op_log.origin`** uses `durable_agent_name` (#1545): a *named* client is stamped `agent:<name>` unchanged, but an *anonymous* client (the `"unknown"` placeholder) is stamped `agent:unknown:<session-ulid>` — the per-connection session ULID is folded in so two simultaneous anonymous agents don't collapse to a single indistinguishable `agent:unknown` origin. Both keep the `agent:` prefix, so `LIKE 'agent:%'` consumers still match.

**Do not bypass `ACTOR.scope`.** A handler that calls a command function without being inside the scope will see `Actor::User` (the default), corrupting the activity feed and op-log origin attribution.

## Activity-feed contract

After every `tools/call` completion, the adapter calls `emit_tool_completion(ctx, ToolCompletionEvent { ... })` (`mcp/activity.rs`). The event carries:

- `tool_name` — the tool that ran.
- `summary` — a privacy-safe one-line summary (built by `mcp/summarise.rs`; per-tool; structural counts + ULID prefixes only, never block content).
- `result` — `ActivityResult::Ok` or `Err(short_message)`.
- `session_id` — the connection's session ULID (stable across the connection's lifetime).
- `op_ref` + `additional_op_refs` — drained from the `LAST_APPEND` task-local; the first op is the primary `OpRef`, the rest are `additionalOpRefs`. **One activity-feed entry per tool call, regardless of how many ops the tool wrote.**

This is automatic; tool handlers don't call it directly. The plumbing is in `RmcpAdapter::call_tool`.

## JSON-RPC error codes

The rmcp framer handles standard JSON-RPC errors (`-32601 Method not found`, `-32602 Invalid params`, `-32700 Parse error`). For application-level "not found" errors, agaric uses a custom code `-32001 JSONRPC_RESOURCE_NOT_FOUND` (defined in `mcp/server.rs`). Distinct from JSON-RPC's `-32601`:

- `-32601` = "the JSON-RPC method endpoint doesn't exist" (`tools/nonexistent`).
- `-32001` = "the resource named in the call arguments doesn't exist" (an unknown tool name, an unknown block id inside a tool's args).

`app_error_to_rmcp` in `rmcp_adapter.rs` is the single `AppError → wire` mapping. There are **three** arms — all three must stay in sync with this doc:

- `AppError::NotFound` → `-32001` (the custom resource-not-found code above). Agents discriminate this from `-32601`: "I called a method that doesn't exist" vs "I asked for a thing that doesn't exist".
- `AppError::Validation` **and** `AppError::InvalidOperation` → `-32602 Invalid params`. Bad arguments and rejected operations (e.g. an out-of-range `limit`, a malformed ULID) keep their crafted, agent-actionable `Display` message on the wire.
- **everything else** (`Database` / `Io` / `Json` / …) → `-32603 Internal error` with a **generic, scrubbed** message (`INTERNAL_ERROR_WIRE_MESSAGE` = `"an internal error occurred"`). This is the #698 contract: internal variants embed sqlx / OS detail that must never reach an automation client (mirroring the Tauri IPC boundary's `sanitize_internal_error`). The real error chain is logged on a `tracing::error!(target: "mcp", …)` line for the daily log; only the generic sentence crosses the wire. **Do not** put `err.to_string()` on the catch-all arm.

## `ERROR_CLIP_CAP`

When a tool errors, the activity feed clips the error message to 200 Unicode scalars (`ERROR_CLIP_CAP` in `mcp/server.rs`). Char-based clipping always lands on a UTF-8 boundary; safe to serialise as JSON. Long error chains don't bloat the feed.

## disconnect grace period

When `mcp_disconnect_all` fires while a `tools/call` is mid-flight, `run_connection`'s `select!` wraps the in-flight future in `tokio::time::timeout(MCP_DISCONNECT_GRACE_PERIOD, fut)` so the call gets up to 2 s to return its reply before the stream is dropped. **The DB layer commits before any further `.await`, so cancellation safety is preserved either way** — the grace period only affects whether the agent sees the reply / whether the activity feed sees the entry.

Do not lower the cap below 2 s without checking the slowest tool's p95 latency.

## Read-only vs read-write surfaces

- **`tools_ro.rs`** mounts on the RO socket / pipe. Tools that don't mutate state (search, list, fetch) — **with one documented, bounded exception**, `journal_for_date` (below). Lives at one socket path.
- **`tools_rw.rs`** mounts on the RW socket / pipe. Tools that DO mutate state (delete, update, create, tag, untag, etc.). Lives at a separate socket path.

Two pipes / two sockets is a deliberate split: an agent can connect to the RO surface only and the user can disable the RW surface independently (the H-2 enable/disable gate, `McpLifecycle::enabled`, flips them independently). This is **not** a guaranteed-no-mutation contract, though — `journal_for_date` can append a `CreateBlock` op from the RO socket under the bounded conditions described below. Every other RO tool is a pure read.

**Do not cross-pollute beyond the one documented carve-out below.** A read-only tool that needs to write (e.g. caching) goes through a normal command handler; it doesn't grow a NEW mutation path on the RO surface. `journal_for_date` is the sole, deliberately bounded exception that predates this rule — do not add a second one without updating this doc and getting explicit sign-off.

### `journal_for_date` — bounded create carve-out (#2719)

`journal_for_date` (`tools_ro.rs`, `handle_journal_for_date`) is the one RO tool with a write side-effect: on a lookup miss it may emit a `CreateBlock` + `SetProperty(space)` op pair (origin `agent:<name>`) for the missing journal page. This is genuinely a write, not a pure read — but it is bounded, not unconditional:

- The page may only be **created** when `date` falls inside a **rolling window of today ± `JOURNAL_CREATE_WINDOW_MONTHS`** (12 months, `tools_ro.rs`). "Today" is `chrono::Local::now().date_naive()`, the same source `commands/agenda.rs` and `recurrence/parser.rs` already use.
- For a `date` **outside** that window: an existing page is still returned (pure read, no write); a missing page returns `AppError::NotFound` instead of being created. The RO surface never creates a page for an arbitrary far-future or far-past date.
- Inside the window the behaviour is exactly the pre-#2719 contract: idempotent per `(space_id, date)`, one `CreateBlock` op on the first call for a given pair, a pure lookup on every call after.

Before #2719, `handle_journal_for_date` parsed **any** valid `chrono::NaiveDate` with no range check and delegated straight into the create-or-lookup helper — so an agent connected to the nominally read-only socket could append an unbounded number of `CreateBlock`/`SetProperty` ops to the append-only `op_log` (~3.6M reachable dates per space), none of them reclaimable. The window bound is what closes that: the reachable date range per space is now a ~2-year rolling window, not the full calendar. If you touch `handle_journal_for_date` or `within_journal_create_window`, keep this doc in sync — it is the single place both the code comments and the Settings "Read-only access" tooltip (`agentAccess.roToggleDescription` in `src/lib/i18n/settings.ts`) point back to.

### Full-vault RO scope (no per-space isolation)

The RO surface is **vault-wide read-only by design**: an agent given one `space_id` can still enumerate and read every space. `list_spaces` (`tools_ro.rs`, `handle_list_spaces` → `list_spaces_registry_inner`) is the concrete discovery surface — it returns `{id, name, is_default}` for *every* space with no scoping — and the other unscoped RO readers (search / list / fetch) then read any space's pages and blocks. This is the intended contract, not a leak.

**If you ever add per-space RO isolation**, `list_spaces` plus the unscoped RO readers are the enumeration path to close: gate `list_spaces` to the connection's authorised space(s) and scope every RO reader to a `space_id` filter. Until then, treat the RO surface as a full-vault enumeration capability.

## Testing

Coverage is split across layers, and **no single test drives the full production stack** (real socket accept loop + rmcp wire framing + a real `ReadOnlyTools`/`ReadWriteTools` registry + DB) in one path — each layer below is well covered individually, but the seams between them are not:

- **`tools_ro::tests` + `tools_rw::tests`** cover input validation + happy path + at least one error path per tool, calling `registry.call_tool()` **directly** against a real `init_pool` DB + materializer fixture (`test_pool()`). No socket, no rmcp framing — this is the real tool logic, exercised in-process.
- **`rmcp_adapter::tests`** covers rmcp wire framing (parity tests against canonical wire JSON, unknown-tool error mapping) over a `tokio::io::duplex`. Most `call_tool` round-trips run against `MockRoRegistry`; the one test wired to a real `ReadOnlyTools` registry (`rmcp_tools_list_advertises_full_read_only_registry`) drives `tools/list` only, not `call_tool`.
- **`server::tests` + `server::tests_rmcp`** cover the connection lifecycle (`run_connection`, H-2 shutdown gate, grace period) against a real `UnixListener` / rmcp client — but always with a stub registry (`PlaceholderRegistry` in `server::tests`, `SlowRegistry` in `server::tests_rmcp`), never a real tool registry backed by a DB.
- The `ci-smoke`-gated `stub_binary_roundtrips_initialize_over_uds` (`mod.rs`) comes closest to end-to-end — it spawns the real `agaric-mcp` binary against a real UDS — but only round-trips `initialize`, still against `PlaceholderRegistry`; it doesn't touch `tools/call`.
- **`scripts/mcp_smoke.py`** is the only test that exercises a real `tools/call` through the full stack (real client SDK → live `cargo tauri dev` process → real tools/DB). It is intentionally excluded from CI — "Never add this to CI — it depends on a live Tauri process" (see the script's own docstring) — so it only runs manually.

New tools require a matching test in `tools_ro::tests` or `tools_rw::tests`. New protocol-error paths require a test in `server/tests_rmcp.rs`.

## Cross-references

- Root [`AGENTS.md`](../../../AGENTS.md) §Backend Architecture.
- [`src-tauri/src/commands/AGENTS.md`](../commands/AGENTS.md) — `LAST_APPEND` task-local + `_inner` pattern that tools call into.
- [`docs/architecture/search.md`](../../../docs/architecture/search.md) — high-level search architecture (the MCP `search` tool's twin).
- `src-tauri/src/mcp/rmcp_adapter.rs` — the production adapter.
- `src-tauri/src/mcp/activity.rs` — activity-feed emission.
