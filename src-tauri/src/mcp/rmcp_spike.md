# MAINT-111 spike — `rmcp` vs hand-rolled JSON-RPC dispatch

> **Verdict: GO (modest scope)** — `rmcp 1.6` cleanly adapts onto the
> existing `ToolRegistry` trait without owning the registry; the
> activity-feed, `ActorContext`, and `LAST_APPEND` integration points
> survive intact; ~250 LOC of pure framing/dispatch in `server.rs`
> would collapse. The accept loop, lifecycle gate, and per-connection
> bookkeeping stay agaric-specific. Recommended next step: convert
> MAINT-111 from "spike" into a concrete 3-milestone migration ticket.

This file documents the MAINT-111 spike. It is co-located with
`rmcp_spike.rs` so the prototype, the test, and the assessment travel
together. `cargo build` ignores `.md` files; this is purely orchestrator
input.

## Numbers

### Compile-time delta (cold, `cargo check`, x86_64-linux)

| Build | Wall time |
| ------- | ----------- |
| `cargo check` (default) | **1m 17s** |
| `cargo check --features mcp_rmcp_spike` | **1m 18s** |

≈ +1 second cold. The spike compiles ~5 small extra crates against an
already-large dependency graph; the impact is in the noise.

### Transitive dependency delta (`cargo tree -e normal`)

| Build | Direct + transitive crates |
| ------- | ---------------------------- |
| Default | **471** |
| `--features mcp_rmcp_spike` | **477** |

**+6 crates**: `rmcp`, `rmcp-macros`, `pastey`, `ref-cast`,
`ref-cast-impl`, `futures` (the broad `futures` umbrella; `rmcp`
depends on it directly even though we already had
`futures-util` / `futures-core` / `futures-channel` /
`futures-task` / `futures-io` in the graph transitively). All
Apache-2.0 / MIT — no `deny.toml` updates needed.

### `agaric-mcp` binary size (release, x86_64-linux, stripped)

| Build | Size |
| ------- | ------ |
| Default | 2,488,504 B (2.37 MiB) |
| `--features mcp_rmcp_spike` | 2,488,536 B (2.37 MiB) |

**+32 bytes** — effectively dead-code-eliminated. `agaric-mcp` is a
stdio↔socket bridge that consumes only the `APP_IDENTIFIER` /
`MCP_RO_PIPE_PATH` constants from `agaric_lib::mcp`; it never
references the spike module, so the linker drops it. A *real* migration
that routed agent traffic through `rmcp` from inside the main `agaric`
binary would add roughly the size of the rmcp object code (rough
estimate ~200-400 KiB optimised).

### LOC that would collapse from `mcp/server.rs`

`mcp/server.rs` is **1126 LOC** (production + inline tests). The pure
framing + dispatch layer that `rmcp` would own is ~**250 LOC**:

| Function / construct | Lines | Verdict |
| --------------------- | ------- | --------- |
| `JSONRPC_*` error code constants | 51-77 (~28) | **collapse** — `ErrorData::invalid_params` / `internal_error` / `method_not_found` / `resource_not_found` ship with the same spec codes. |
| `make_success` | 159-165 (~7) | **collapse** — rmcp builds responses internally. |
| `make_error` | 168-177 (~10) | **collapse** — rmcp builds error envelopes from `ErrorData`. |
| `ParsedRequest` / `IncomingRequest` / `IncomingNotification` enums | 181-197 (~17) | **collapse** — rmcp parses into typed `ClientRequest` / `ClientNotification`. |
| `parse_request` | 199-241 (~43) | **collapse** — rmcp's transport layer owns line-framing + envelope shape validation. |
| `handle_initialize` | 247-288 (~42) | **collapse** — rmcp drives `initialize` automatically; `clientInfo` lands in `context.peer.peer_info()` which the spike adapter reads. |
| `handle_tools_list` | 290-299 (~10) | **partially collapse** — replaced by `ServerHandler::list_tools` impl that just maps `ToolDescription` → `Tool`. |
| `handle_notification` | 580-601 (~22) | **collapse** — `notifications/initialized` is owned by `rmcp`'s state machine; unknown notifications surface via `ServerHandler::on_custom_notification` (overridable). |
| `dispatch` | 557-572 (~16) | **collapse** — rmcp dispatches by method name internally and routes `tools/call` to `ServerHandler::call_tool`. |
| `truncate_params_preview` | 608-625 (~18) | **collapse** — only used by `handle_notification`, which itself collapses. |
| Per-line write framing in `handle_connection` (`payload.push(b'\n'); write_half.write_all(&payload).await?` etc.) | 685-690 (~6) | **collapse** — `transport-async-rw` ships the wire framing. |
| `wrap_tool_result_success` | 359-382 (~24) | **collapse** — replaced by `CallToolResult::structured(value)`, which produces the identical `{ content, structuredContent, isError: false }` envelope (verified in the spike test). |
| `app_error_to_jsonrpc` | 327-334 (~8) | **stays** — application-level mapping from `AppError::NotFound` / `Validation` / `InvalidOperation` to JSON-RPC codes. rmcp has helpers but the mapping rule is agaric-specific. |
| `handle_tools_call` *body* | 390-555 (~165) | **stays** — ACTOR scope, LAST_APPEND scope, summariser dispatch, activity-feed emission, agent-name fallback. The `wrap_tool_result_success`/`make_error` *output* steps shrink by ~30 LOC. |
| `handle_connection` *outer loop* | 640-691 (~52) | **stays** — owns the per-connection state and the bookkeeping around `rmcp::serve`. With rmcp it shrinks to ~10 LOC: build the adapter, hand the duplex/stream to `adapter.serve(...)`, await `service.waiting()`. |
| `serve` / `serve_unix` / `serve_pipe` | 716-894 (~180) | **stays** — Unix-domain socket bind, Windows named-pipe `first_pipe_instance` lock, FEAT-4e disconnect signal, M-83 successor-instance management. **agaric-specific**. |
| `run_connection` | 902-962 (~61) | **stays** — RAII connection counter, L-113 grace period for in-flight `tools/call` to complete before the disconnect signal tears the stream down. **agaric-specific**. |
| `lifecycle_disabled` | 739-741 (~3) | **stays**. |
| `MCP_DISCONNECT_GRACE_PERIOD` / `MCP_PROTOCOL_VERSION` / `MCP_SERVER_NAME` / `MCP_SERVER_VERSION` constants | 39-88 | **stays / partially collapse** — the protocol version + server name move to `ServerHandler::get_info`; the grace period stays. |

**Sum:** ~250 LOC of `server.rs` would disappear; the remaining
~870 LOC is genuinely agaric-specific (lifecycle, transport, scope
threading) and rmcp has nothing to say about it. Net `server.rs` size
post-migration: **~870 LOC** (vs 1126 today).

This is short of the "300-500 LOC" estimate in the original MAINT-111
entry — the entry overcounted because it conflated framing, dispatch,
and the L-113/H-2/M-83 transport machinery. The **framing + dispatch
slice** is genuinely ~250 LOC and is the only part rmcp can own.

## Structural fit table

| MAINT-111 question | Verdict | Note |
| --- | --- | --- |
| **Q1: How much of `server.rs` collapses?** | **Pass** | ~250 LOC of pure framing/dispatch (parse, framing helpers, initialize/notification/dispatch/list dispatchers, JSON-RPC constants, line framing) — see table above. |
| **Q2a: Activity-feed emission survives?** | **Pass** | `ServerHandler::call_tool` is overridable; the spike replicates `handle_tools_call`'s post-call `emit_tool_completion` exactly, gated on the same `ActivityContext`. Test `rmcp_spike_search_round_trip_emits_activity_and_actor` asserts both the ring entry and the `RecordingEmitter`'s Tauri-event payload. |
| **Q2b: `ActorContext` threading survives?** | **Pass** | `context.peer.peer_info().client_info.name` is the rmcp equivalent of `ConnectionState::client_info.name`. The spike wraps the registry call in `ACTOR.scope(...)` exactly like `handle_tools_call`; the test asserts `current_actor()` returns `Actor::Agent { name: "spike-test-agent" }` inside the registry's `call_tool`. |
| **Q2c: `LAST_APPEND` tracker survives?** | **Pass** | The spike wraps the registry call in `crate::task_locals::LAST_APPEND.scope(RefCell::new(Vec::new()), ...)` and harvests with `take_appends()` exactly like `handle_tools_call`. Mock RO registry produces no appends in the spike test, but the threading is structurally identical. |
| **Q3: Spec-conformance delta** | **Pass** | rmcp gives us **for free**: protocol-version negotiation, `notifications/initialized` state-machine, `notifications/cancelled` + `notifications/progress` handling, `ping`, `tools/listChanged` (when the registry changes), `_meta` field propagation, `CallToolResult::structuredContent` field. Hand-rolled stubs all of these. Prompts / resources / sampling / completions are also available behind the same trait; we'd add them by overriding more methods. |
| **Q4: rmcp stable enough?** | **Pass** | v1.6.0 (post-1.0). Apache-2.0 (already on `deny.toml` allow-list). Maintained by the Model Context Protocol org. Tied to tokio (we use tokio). +6 transitive crates total. |

## Spec-conformance delta

What `rmcp` would land "for free" that `mcp/server.rs` currently stubs
or omits:

- **Protocol version negotiation** — hand-rolled ignores client's
  `protocolVersion` and unconditionally returns the server's pinned
  `"2025-06-18"`. `rmcp` compares the client's version against the
  set of versions the server knows and downgrades to a common one
  per spec.
- **`tools/listChanged` notification** — hand-rolled hard-codes
  `"listChanged": false` in the capabilities bag. `rmcp` exposes a
  `peer.notify_tool_list_changed()` API and the capability bit
  flips on automatically when registered tools change.
- **`notifications/cancelled` + `notifications/progress`** —
  hand-rolled logs them as "unknown notification" at warn level
  (I-MCP-3). `rmcp` has typed handlers (`on_cancelled` /
  `on_progress`) that we can override.
- **`ping`** — hand-rolled returns `-32601` for any `ping`. `rmcp`
  has a typed `ServerHandler::ping` with a default Ok impl.
- **`_meta` propagation (SEP-1319)** — hand-rolled drops the
  `_meta` field on every request. `rmcp` parses it into typed
  `Meta` and threads it through.
- **Prompts / resources / sampling / completions** — all
  available as `ServerHandler` methods we can opt into when we
  want them. Hand-rolled has none of these.

## Risk / cost estimate (full migration if pursued)

Three milestones, each independently shippable behind the
`mcp_rmcp_spike` feature flag (or a successor `mcp_rmcp` flag once
the spike feature graduates):

### Milestone 1 — route `tools/list` through `rmcp` (S, ~4h)

- Replace `RmcpSearchAdapter` (the spike's single-tool filter) with a
  full `RmcpReadOnlyAdapter` that maps every `ToolDescription` from
  `tools_ro::list_tool_descriptions` into `Tool`.
- Drop `handle_tools_list` from `server.rs`.
- Risk: tool-schema serialisation parity — the spike already proved
  that `ToolDescription.input_schema` (a `serde_json::Value`) maps
  cleanly into `Tool::new`'s `Arc<JsonObject>`; verify
  byte-for-byte via the existing `tool_descriptions` insta snapshots
  in `tools_ro/snapshots/`.

### Milestone 2 — route `tools/call` through `rmcp` (M, ~6h)

- Override `ServerHandler::call_tool` with the spike's pattern:
  `peer_info().client_info.name` → `ActorContext` → `ACTOR.scope` +
  `LAST_APPEND.scope` → registry dispatch → `emit_tool_completion`.
- Replace `wrap_tool_result_success` with `CallToolResult::structured`.
- Translate `AppError` → `ErrorData` via the existing
  `app_error_to_jsonrpc` mapping (`NotFound` → `ErrorData::resource_not_found`,
  `Validation`/`InvalidOperation` → `ErrorData::invalid_params`,
  everything else → `ErrorData::internal_error`).
- Drop `handle_tools_call`'s outer dispatch; keep the activity/actor
  wrapper.
- **Validation gate**: every existing `mcp/server/tests.rs` and
  `mcp/tools_ro/tests.rs` test must still pass when run through the
  rmcp adapter (run them twice — once against `handle_connection`,
  once against `RmcpReadOnlyAdapter::serve`).

### Milestone 3 — drop hand-rolled framing (S, ~3h)

- Once milestones 1 + 2 land, `parse_request`, `make_success`,
  `make_error`, `handle_initialize`, `handle_notification`,
  `dispatch`, `truncate_params_preview`, and the JSON-RPC error
  code constants are dead code.
- Delete them.
- Replace the `handle_connection` body with `adapter.serve(stream)`.
- Keep `serve_unix` / `serve_pipe` / `run_connection` /
  `McpLifecycle` plumbing untouched — they own the
  agaric-specific transport-and-lifecycle layer that rmcp does
  NOT replace.

### Total risk / cost

- **Cost:** S + M + S ≈ 12-14h end-to-end (single session feasible).
- **Risk:** **Medium** — every test in `mcp/server/tests.rs` /
  `mcp/tools_ro/tests.rs` / `mcp/tools_rw/tests.rs` must still pass
  byte-equivalent over the rmcp adapter. The wire format is
  identical (rmcp targets the same MCP spec we hand-roll), but
  edge cases (empty `arguments`, malformed `id`, non-string
  `jsonrpc` field, snapshot-tested error messages with their
  exact code numbers) need explicit verification. A behind-flag
  shadow-mode (run both adapters in parallel, compare responses
  byte-for-byte for one release) would mitigate.
- **Surface impact:** `agaric-mcp` external binary is unchanged
  — it stays a pure stdio↔socket bridge.
- **Coupled-dep impact:** `rmcp` is a NEW crate. It is NOT part
  of any existing coupled stack (Tauri, React, TipTap, Radix,
  SQLx, specta) so it does not require lockstep updates with
  anything we already pin.

## Why "GO" (not just "ABANDON because the existing code is well-tested")

The MAINT-111 entry says: *"If `rmcp` wants to own the registry,
abandon — the current code is well-tested and not a maintenance
burden."* The spike confirmed `rmcp` does **NOT** want to own the
registry — `ServerHandler` is a thin trait we override, the
existing `ToolRegistry` survives unchanged. The integration is
genuinely thin (one adapter struct, ~200 LOC including docs).

The case for GO:

1. **Spec-conformance.** The hand-rolled stubs (`tools/listChanged`,
   `protocolVersion` negotiation, `_meta` propagation, the
   not-yet-implemented prompts/resources/sampling slots) all become
   free with rmcp. We currently ignore client-side capabilities
   like cancellation; agents that try to cancel a long-running
   `search` get a `-32601` and bail.
2. **Forward-compat.** MCP keeps moving (the spec is dated
   `2025-06-18`; rmcp tracks `2025-11-25`). With rmcp we follow
   spec bumps via `cargo update`; without it, every bump is a
   manual diff against the upstream JSON-Schema.
3. **Adapter stability.** rmcp is post-1.0 (v1.6.0 published);
   the public API (`ServerHandler`, `ServiceExt::serve`,
   `ToolRouter`) is settled. The migration guide lists the
   1.0 breaking changes and they are surface-level
   (renamed methods, not architectural).
4. **Cost is bounded.** 12-14h split across 3 milestones, each
   reversible. The transitive-dep delta is +6 crates, all
   permissive-licensed and already on the `deny.toml`
   allow-list.

The case against GO is the existing tests — `mcp/server/tests.rs`,
`mcp/tools_ro/tests.rs`, and `mcp/tools_rw/tests.rs` lock down the
byte shape of every JSON-RPC error message. Re-running them against
rmcp's framing is the only real risk and is straightforward to
verify in a behind-flag shadow-mode.

## Recommended next step for the orchestrator

Convert MAINT-111 from "spike" to a concrete migration ticket with
the milestone list above. Keep the `rmcp_spike` feature + module +
test in the tree (default build is unchanged); the prototype
serves as a reference implementation for milestones 1 + 2.

When the migration ticket is opened, link the milestone
checkpoints back to this file and to `rmcp_spike.rs`. The spike
test `rmcp_spike_search_round_trip_emits_activity_and_actor`
should be promoted to a regression-test harness — every
production tool routed through rmcp must still pass an equivalent
"actor flows + activity emits" round-trip.
