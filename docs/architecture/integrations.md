<!-- markdownlint-disable MD060 -->
# Integrations

External-facing surfaces: MCP for AI agents, `agaric://` deep links.

## MCP (agent access)

Local-only MCP server for AI clients (Claude Desktop, Cursor, Continue), on one socket. Each client connects as an agent made in Settings, with a token, a mode (read-only or read-write) and the spaces it may use (#5667).

### Transport

- **Linux / macOS**: Unix domain socket, mode `0600`.
- **Windows**: named pipe created with an explicit per-user security descriptor
  (`D:P(A;;GA;;;<user SID>)(A;;GA;;;SY)(A;;GA;;;BA)`) via
  `win_security::create_secured_pipe_instance`. The default named-pipe DACL grants read access to
  `Everyone` and `Anonymous`, so Agaric deliberately does not rely on it (#2720).
- **Never** a TCP port.

The `agaric-mcp` binary is a stdio↔socket bridge bundled with the app. Agents spawn it with `--token <agent token>`; it writes `AGARIC-TOKEN <token>` before any MCP byte, then forwards JSON-RPC frames over the socket. Configuration snippets live in [`docs/features/agent-access.md`](../features/agent-access.md).

### Agents and tokens

Agents are device-local rows of `mcp_agents` (migration 0125): a name, a mode, the spaces (`NULL`: every space) and a plain-text `agt_` token. No op type: a token only works against this device's socket. `handle_connection` (`src-tauri/src/mcp/server.rs`) reads the token line, refuses a connection without a live agent's token with one JSON-RPC `-32001` naming Settings → Agent access, and serves the rest through the registry the agent's mode picks. Every `tools/call` re-reads the agent (`ConnectedAgent::authorize`), so a revoke refuses the next call, and refuses a `space_id` or `target_space_id` outside its spaces. The token guards against an agent's mistakes, not an attacker.

### Registries

One socket, one marker file (`mcp-enabled`):

- **Read-only agents**: list pages, get page, read a page as Markdown, search, get block, list backlinks, list tags, list property definitions, get agenda, fetch journal page by date, list spaces.
- **Read-write agents**: append block, update block content, set property, add tag, create page, delete block, …, then every read-only tool.

`list_spaces` returns `{ id, name, is_default }` for every space the agent may use; it is the discovery surface for the `space_id` every tool but `list_spaces` requires. Wire names live as `TOOL_*` constants in `src-tauri/src/mcp/registry.rs`; the authoritative advertised and dispatched sets are `list_tool_descriptions()` and the `call_tool()` match arms in `tools_ro.rs` / `tools_rw.rs`.

### `ToolRegistry` trait

`src-tauri/src/mcp/registry.rs` defines the `ToolRegistry` trait; `ReadOnlyTools` and
`ReadWriteTools` implement it in `tools_ro.rs` and `tools_rw.rs`. To add a tool:

1. Add its `TOOL_*` wire-name constant in `src-tauri/src/mcp/registry.rs`.
2. In the matching `tools_ro.rs` / `tools_rw.rs`, add the tool-description factory and register it
   in `list_tool_descriptions()` (the `list_tools()` enumeration), or, for a write tool, in
   `write_tool_descriptions()` in `tools_rw.rs`, whose `list_tool_descriptions()` appends the read
   tools.
3. In that same tools file, add the `call_tool()` dispatch arm and handler implementation.
4. Add a field-filtered `summarise_<name>` function and its `summarise()` match arm in
   `src-tauri/src/mcp/summarise.rs`.
5. Add validation, success, and error coverage for the tool in `tools_ro::tests` or
   `tools_rw::tests`, as appropriate.
6. Refresh the matching `tool_descriptions` insta snapshot and add or refresh the tool's response
   snapshot when its test pins a response envelope.

Every tool requires `space_id` except `list_spaces`. Reads are confined to that space, a tool
that addresses a block or page by id rejects a target in another space, and `create_page` uses it
to select the destination space. An agent limited to some spaces is refused any other; this guards
against mistakes and is not isolation. See [Agent Access → Space scoping](../features/agent-access.md#space-scoping) for
the full contract and the gaps it accepts.

The MCP `search` tool takes `parent_id`, `tag_ids`, and `space_id` as **top-level** arguments (alongside `query`, `cursor`, `limit`) — `space_id` is required, the other two are optional. Everything else is carried by an optional structured `filter` arg that mirrors the user-facing `SearchFilter` minus those three already-top-level slots: `include_page_globs`, `exclude_page_globs`, `state_filter`, `priority_filter`, `excluded_state_filter`, `excluded_priority_filter`, `due_filter`, `scheduled_filter`, `property_filters`, `excluded_property_filters`, `block_type_filter`, `case_sensitive`, `whole_word`, `is_regex`, `last_edited`. (`SearchFilterArgs` in `src-tauri/src/mcp/tools_ro.rs` is `deny_unknown_fields`, so passing `parent_id`/`tag_ids`/`space_id` *inside* `filter` is rejected.) Inline filter syntax (`tag:` / `state:` / `prop:`…) is **not** re-parsed from `query` at the MCP boundary — agents pass structured arguments. Omitting `filter` preserves the prior query-string-only behaviour. Its `tag_ids` also match inline `#tag` references and inherited tags (`SearchFilter::tags_match_inline_and_inherited`), which the app's search does only for an `under:#tag` query.

Block rows in every tool result leave out their null fields (`to_tool_result` in `handler_utils.rs`); other objects keep theirs, because some tools document a null.

### `ActorContext` plumbing

Task-locals carry the agent identity through every IPC. The name is the agent's, from its row; the MCP client's `clientInfo` is not read. Settings validated it when the agent was made (trimmed, no control characters, at most `MAX_AGENT_NAME_LEN` chars). Purposes:

- **PII redaction** in logs (the agent name never leaks into telemetry).
- **`op_log.origin`** column gets stamped `agent:<name>` so user vs agent edits are distinguishable in History view + Activity Feed. Agent ops are revertable like any other op.
- **Activity feed emission** — every tool call writes a field-filtered summary to the in-memory ring
  buffer. Summaries may contain structural counts, dates, property keys, non-text property values
  (number / date / bool), and eight-character ULID/reference prefixes. They never contain block
  content, page titles, tag display names, search query strings, or text property values
  (`value_text`).

### Lifecycle

`McpLifecycle` holds a small set of atomics: enabled gate, disconnect notify, in-flight connection counter, task-running flag. The marker file (`mcp-enabled`) is the on-disk gate — checked at boot, where either pre-#5667 marker (`mcp-ro-enabled`, `mcp-rw-enabled`) becomes it. Disabling wakes the accept loop and lets in-flight calls finish with a short grace period before the socket closes.

### Activity feed

`useMcpActivityFeed` consumes a bounded ring buffer of recent tool invocations. The field-filtering
contract is explicit: summaries may contain structural counts, dates, property keys,
number/date/bool property values, and shortened ULID/reference prefixes. They never contain block
content, page titles, tag display names, search query strings, or `value_text`. Each entry also
carries the tool name, operation references, and an `Ok`/`Err` result (errors are clipped); the
feed is per-device, not persisted, and bounded so old entries roll off.

### Session revert

`SessionRevertControls` exposes a one-click "undo everything this agent did since connect". The grouping key is the **per-connection session ULID** (`sessionId`), not the `origin` string — an `origin = 'agent:<name>'` exact-match walk would be wrong: it would over-match every connection of the same agent. Implementation (`src/components/agent-access/ActivityFeed.tsx`): bucket the `opRef`s of every agent + `Ok` activity-feed entry by `sessionId` from the in-memory ring buffer, then submit that exact set to `revertOps`. The revert itself is a normal op log entry, so it's also undo-able.

### Threat model carve-out

Single-user, local-only, kernel-rooted trust. Agent tokens keep each agent to its mode and spaces, against an agent's mistakes; they are not secrets kept from an attacker (anyone who can read `notes.db` reads every note). No rate limits. No per-agent budgets. If an attacker is the user on the user's box, they already have all the access they need; MCP doesn't widen the attack surface.

### rmcp framing

The migration to the official Rust MCP SDK (`rmcp`) is **complete and unconditional** — there is no feature flag. `rmcp` is a hard dependency (the former `mcp_rmcp_spike` Cargo feature has been retired) and `RmcpAdapter` (`src-tauri/src/mcp/rmcp_adapter.rs`, one per connection, over the registry its agent's mode picks) is the sole production dispatcher for `tools/list` and `tools/call`. The hand-rolled JSON-RPC framing that used to live in `src-tauri/src/mcp/server.rs` has been deleted; that module now owns only the connection lifecycle (accept loop, token handshake, H-2 enable/disable gate, disconnect grace period). Canonical, code-level rules for the framing layer live in [`src-tauri/src/mcp/AGENTS.md`](../../src-tauri/src/mcp/AGENTS.md) — that is the authoritative reference; do not reintroduce hand-rolled framing.

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
