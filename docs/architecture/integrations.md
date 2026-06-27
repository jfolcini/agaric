<!-- markdownlint-disable MD060 -->
# Integrations

External-facing surfaces: MCP for AI agents, `agaric://` deep links.

## MCP (agent access)

Local-only MCP server for AI clients (Claude Desktop, Cursor, Continue). Read-only + read-write tool surfaces, each on its own socket.

### Transport

- **Linux / macOS**: Unix domain socket, mode `0600`.
- **Windows**: named pipe, default DACL (owner-only).
- **Never** a TCP port.

The `agaric-mcp` binary is a stdio↔socket bridge bundled with the app. Agents spawn it; it forwards JSON-RPC frames over the socket. Configuration snippets live in [`docs/features/agent-access.md`](../features/agent-access.md).

### Surfaces

Two separate sockets, two marker files (`mcp-ro-enabled` / `mcp-rw-enabled`):

- **Read-only** (10 tools): list pages, get page, search, get block, list backlinks, list tags, list property definitions, get agenda, fetch journal page by date, list spaces (`list_spaces` — returns `{ id, name, is_default }` for every space; the discovery surface for the `space_id` that `search` / `journal_for_date` / every RW tool require).
- **Read-write**: append block, update block content, set property, add tag, create page, delete block.

Splitting by R/W lets users disable writes while keeping reads on.

### `ToolRegistry` trait

`src-tauri/src/mcp/registry.rs` defines a `ToolRegistry` trait with two impls (`ReadOnlyTools`, `ReadWriteTools`). To add a tool:

1. Add the `TOOL_*` constant + tool-description factory in the matching `tools_ro.rs` / `tools_rw.rs`.
2. Implement the dispatch arm in the registry's `call_tool`.
3. Register it in the per-registry `list_tools` enumeration.

Every tool argument schema requires `space_id`; scope is enforced at the tool boundary.

The MCP `search` tool takes `parent_id`, `tag_ids`, and `space_id` as **top-level** arguments (alongside `query`, `cursor`, `limit`) — `space_id` is required, the other two are optional. Everything else is carried by an optional structured `filter` arg that mirrors the user-facing `SearchFilter` minus those three already-top-level slots: `include_page_globs`, `exclude_page_globs`, `state_filter`, `priority_filter`, `excluded_state_filter`, `excluded_priority_filter`, `due_filter`, `scheduled_filter`, `property_filters`, `excluded_property_filters`, `block_type_filter`, `case_sensitive`, `whole_word`, `is_regex`. (`SearchFilterArgs` in `src-tauri/src/mcp/tools_ro.rs` is `deny_unknown_fields`, so passing `parent_id`/`tag_ids`/`space_id` *inside* `filter` is rejected.) Inline filter syntax (`tag:` / `state:` / `prop:`…) is **not** re-parsed from `query` at the MCP boundary — agents pass structured arguments. Omitting `filter` preserves the prior query-string-only behaviour.

### `ActorContext` plumbing

Task-locals carry the agent identity through every IPC. The agent name comes from the MCP client's `clientInfo.name`, sanitized once at the trust boundary (`sanitize_agent_name` in `src-tauri/src/mcp/rmcp_adapter.rs`, #1569): control chars stripped, trimmed, truncated to 128 chars on a char boundary, empty → the `unknown` placeholder. Purposes:

- **PII redaction** in logs (the agent name never leaks into telemetry).
- **`op_log.origin`** column gets stamped so user vs agent edits are distinguishable in History view + Activity Feed. A *named* client stamps `agent:<name>`. An *anonymous* client (absent/empty `clientInfo.name`) is **not** stamped a bare `agent:` — it stamps `agent:unknown:<session-ulid>` (`durable_agent_name`, #1545), folding the per-connection session ULID in so two simultaneous anonymous agents stay distinguishable in the append-only log. Both forms keep the `agent:` prefix, so any `LIKE 'agent:%'` consumer still matches. Agent ops are revertable like any other op.
- **Activity feed emission** — every tool call writes a privacy-safe summary to the in-memory ring buffer (no block content, no page titles, no property values).

### Lifecycle

`McpServer` holds a small set of atomics: enabled gate, disconnect notify, in-flight connection counter, task-running flag. The marker file (`mcp-ro-enabled` / `mcp-rw-enabled`) is the on-disk gate — checked at boot. Disabling wakes the accept loop and lets in-flight calls finish with a short grace period before the socket closes.

### Activity feed

`useMcpActivityFeed` consumes a bounded ring buffer of recent tool invocations. The privacy contract: **summaries never contain block content, page titles, or property values** — only tool name, target id, op count, and an `Ok`/`Err` outcome with a redacted error message. Not persisted (per-device). Bounded so old entries roll off.

### Session revert

`SessionRevertControls` exposes a one-click "undo everything this agent did since connect". The grouping key is the **per-connection session ULID** (`sessionId`), not the `origin` string — a `origin = 'agent:<name>'` exact-match walk would be wrong (it would over-match every connection sharing a name, and would miss anonymous ops entirely, which are stamped `agent:unknown:<session-ulid>`). Implementation (`src/components/agent-access/ActivityFeed.tsx`): bucket the `opRef`s of every agent + `Ok` activity-feed entry by `sessionId` from the in-memory ring buffer, then submit that exact set to `revertOps`. The revert itself is a normal op log entry, so it's also undo-able.

### Threat model carve-out

Single-user, local-only, kernel-rooted trust. No bearer tokens. No rate limits. No per-agent budgets. If an attacker is the user on the user's box, they already have all the access they need; MCP doesn't widen the attack surface.

### rmcp framing

The migration to the official Rust MCP SDK (`rmcp`) is **complete and unconditional** — there is no feature flag. `rmcp` is a hard dependency (the former `mcp_rmcp_spike` Cargo feature has been retired) and `RmcpAdapter` (`src-tauri/src/mcp/rmcp_adapter.rs`, parameterised on `McpSurface` so it fronts both the RO and RW surfaces, #693) is the sole production dispatcher for `tools/list` and `tools/call`. The hand-rolled JSON-RPC framing that used to live in `src-tauri/src/mcp/server.rs` has been deleted; that module now owns only the connection lifecycle (accept loop, H-2 enable/disable gate, disconnect grace period). Canonical, code-level rules for the framing layer live in [`src-tauri/src/mcp/AGENTS.md`](../../src-tauri/src/mcp/AGENTS.md) — that is the authoritative reference; do not reintroduce hand-rolled framing.

## `agaric://` deep links

External tools can open Agaric to a specific target:

| URL | Effect |
| --- | --- |
| `agaric://block/<id>` | Open the page; scroll the block into view; focus it. |
| `agaric://page/<id>` | Open the page in the active tab. |
| `agaric://settings/<tab>` | Open Settings to a specific tab. |

The OS-side handler is registered on install. The Rust backend parses the incoming URL and emits a Tauri event (`deeplink:navigate-to-block`, `deeplink:navigate-to-page`, `deeplink:open-settings`); `useDeepLinkRouter` on the frontend listens and dispatches into the nav / tabs stores.

`useDeepLinkRouter` also replays the launch URL (the OS-given URL that started the process), which handles the cold-start case.

## Why "integrations" is one file

MCP (inbound tool surface for AI clients) and `agaric://` deep links (inbound OS-level URL routing) have nothing operationally in common, but they're both **integration surfaces with the outside world** and both are opt-in. One file with clearly-divided sections is more navigable than several thin files. If either grows past ~200 lines independently, that's the cue to split.
