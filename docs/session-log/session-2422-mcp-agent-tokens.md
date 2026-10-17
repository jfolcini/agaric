# Session 2422 — MCP agents connect with a token, one socket, mode and spaces at dispatch

Step 4 of #5667, the breaking cut, built as a draft PR held for the
maintainer's review. Steps 1–3 (#5687, #5706, #5710) were the base.

**One socket, a token, a refusal.**
- The read-only and read-write sockets, their markers, `McpRwLifecycle`,
  `McpRwToggleGate`, `McpSurface` and the three `mcp_rw_*` commands are gone.
  There is one socket (`mcp.sock`; Windows `\\.\pipe\agaric-mcp`) and one
  marker (`mcp-enabled`). At boot either old marker becomes it.
- `agaric-mcp` requires `--token`; without one it exits 2 naming Settings →
  Agent access. It writes `AGARIC-TOKEN <token>` before any MCP byte.
- `handle_connection` reads that line through a `BufReader` it then hands to
  rmcp, so bytes past the line still reach it. A missing, unknown, revoked or
  malformed token gets one JSON-RPC `-32001` naming Settings, in reply to the
  client's first request, and the connection closes.
- The agent's mode picks the registry: `ReadOnlyTools` or `ReadWriteTools`.

**Dispatch.** `ConnectedAgent::authorize` re-reads the agent on every call,
so a revoke refuses the next call. It refuses a `space_id` or
`target_space_id` outside the agent's spaces, and stamps `last_used_ms` at
most once a minute. `list_spaces` keeps only the agent's spaces. Writes carry
`agent:<agent name>`; `clientInfo`, `sanitize_agent_name` and
`durable_agent_name` are gone. Refusals reach the activity feed.

**Premise corrections to the design's § 5 gaps.**
- A `[[ULID]]` written across spaces is refused by the existing cross-space
  ref guard. Gaps 1 and 3 (a title in rendered Markdown, a backlink target
  in another space) arise only through a page move, and the tests build them
  that way.
- `set_property.value_ref` naming another space's block is refused outright,
  not "kept in scope".
- All five gaps are pinned by `agents/tests.rs`'s `gap_*` tests, and the docs
  say so.

**Settings.** One switch, the socket path, the connections and Disconnect
all. The per-socket copy buttons went; each agent's row has its own config.
The "takes effect in an upcoming update" line went too. The mock, its tests,
the conformance waivers and the Playwright specs follow.

**Tests.** Every new test was shown red by one command that backed the file
up, restored it on exit and confirmed the mutation applied. The handshake
covers a valid, revoked, missing and malformed preamble, plus the preamble
and `initialize` in one write. A proptest checks that a call runs exactly
when mode and spaces allow it. The `ci-smoke` tests drive the real bridge
for a live, a revoked and a missing token; CI now runs `test(stub_binary_)`.
A new real-backend spec, `mcp-agent-token.e2e.ts`, makes an agent in
Settings, reads and writes through `agaric-mcp`, revokes it in Settings and
sees the next call refused. It and `mcp-write-burst-responsive` passed
locally under Xvfb, and the new spec went red with the gate loading the
agent only once.

**Mutation.** `cargo mutants` over `mcp/agents.rs` and the dispatch and
handshake functions: 43 mutants, 33 caught, 9 unviable, 1 missed
(`<` → `<=` at the exact one-minute stamp boundary, accepted). Stryker over
`agent-config.ts`, now enrolled: 27 of 27 killed.

**Bench** (`core_bench -- mcp_dispatch`, 100K blocks, `release-test`
profile, two runs). The gate adds about 25 µs per call: about 20 % on
`get_block` (~123 µs → ~149 µs), outside the noise. On `list_pages`
(~11 ms) it is inside the run-to-run noise of about ±4 %. The token lookup
at connect is about 24 µs. A burst of 100 calls writes `last_used_ms` once.

**Release note:** existing `agaric-ro` / `agaric-rw` client configs stop
working; add an agent per client in Settings → Agent access and use its
config.

The `#[cfg(windows)]` pipe arms were edited by reading only; `release.yml`
compiles them.
