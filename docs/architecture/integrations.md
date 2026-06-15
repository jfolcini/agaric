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

- **Read-only**: list pages, get page, search, get block, list backlinks, list tags, list property definitions, get agenda, fetch journal page by date.
- **Read-write**: append block, update block content, set property, add tag, create page, delete block.

Splitting by R/W lets users disable writes while keeping reads on.

### `ToolRegistry` trait

`src-tauri/src/mcp/registry.rs` defines a `ToolRegistry` trait with two impls (`ReadOnlyTools`, `ReadWriteTools`). To add a tool:

1. Add the `TOOL_*` constant + tool-description factory in the matching `tools_ro.rs` / `tools_rw.rs`.
2. Implement the dispatch arm in the registry's `call_tool`.
3. Register it in the per-registry `list_tools` enumeration.

Every tool argument schema requires `space_id`; scope is enforced at the tool boundary (PEND-24).

The MCP `search` tool accepts an optional structured `filter` arg (PEND-65) that mirrors the user-facing `SearchFilter`: `include_page_globs`, `exclude_page_globs`, `state_filter`, `priority_filter`, `excluded_state_filter`, `excluded_priority_filter`, `due_filter`, `scheduled_filter`, `property_filters`, `excluded_property_filters`, `block_type_filter`, `case_sensitive`, `whole_word`, `is_regex`. Inline filter syntax (`tag:` / `state:` / `prop:`…) is **not** re-parsed from `query` at the MCP boundary — agents pass structured arguments. Omitting `filter` preserves the pre-PEND-65 query-string-only behaviour.

### `ActorContext` plumbing

Task-locals carry the agent identity (`agent:<name>`) through every IPC. Purposes:

- **PII redaction** in logs (the agent name never leaks into telemetry).
- **`op_log.origin`** column gets stamped `agent:<name>` so user vs agent edits are distinguishable in History view + Activity Feed. Agent ops are revertable like any other op.
- **Activity feed emission** — every tool call writes a privacy-safe summary to the in-memory ring buffer (no block content, no page titles, no property values).

### Lifecycle

`McpServer` holds a small set of atomics: enabled gate, disconnect notify, in-flight connection counter, task-running flag. The marker file (`mcp-ro-enabled` / `mcp-rw-enabled`) is the on-disk gate — checked at boot. Disabling wakes the accept loop and lets in-flight calls finish with a short grace period before the socket closes.

### Activity feed

`useMcpActivityFeed` consumes a bounded ring buffer of recent tool invocations. The privacy contract: **summaries never contain block content, page titles, or property values** — only tool name, target id, op count, and an `Ok`/`Err` outcome with a redacted error message. Not persisted (per-device). Bounded so old entries roll off.

### Session revert

`SessionRevertControls` exposes a one-click "undo everything this agent did since connect". Implementation: walk the op log filtered by `origin = 'agent:<name>'` and `created_at >= session_start`; reverse each op in reverse order. The revert itself is a normal op log entry, so it's also undo-able.

### Threat model carve-out

Single-user, local-only, kernel-rooted trust. No bearer tokens. No rate limits. No per-agent budgets. If an attacker is the user on the user's box, they already have all the access they need; MCP doesn't widen the attack surface.

### rmcp migration

A migration to the official Rust MCP SDK (`rmcp`) is in progress, gated by the `mcp_rmcp_spike` Cargo feature. **M1** (route `tools/list` through `rmcp`'s `ServerHandler::list_tools` via `RmcpReadOnlyAdapter`) has landed; the parity test pins byte-for-byte equivalence with the hand-rolled `handle_tools_list`. **M2** (route `tools/call` through `rmcp`) and **M3** (delete the hand-rolled JSON-RPC framing entirely) remain. All milestones stay behind the feature flag until M3 flips production over.

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
