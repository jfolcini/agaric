# Session 3989 — `agaric-mcp call <tool> <json>` runs one tool and exits

`Refs #6555` (the one-shot MCP call item).

The bridge binary was a byte shuttle with no MCP client of its own. `call` reuses its socket
lookup, `--token` and connect step, then runs rmcp's client over the stream: token preamble,
`ClientConfig::serve`, one `call_tool`. rmcp's `client` feature was already on, so there is no
hand-written JSON-RPC. The preamble now has one writer, `present_token`, shared by the bridge.

Decisions and traps:

- A refused token is an error to `initialize`; a tool error, including a write tool on a read-only
  token, is an error to the call. Both print the server's message on stderr and exit 1. Arguments
  that are not a JSON object exit 2 in `parse_args`, before anything connects.
- The result goes out through `writeln!`, not `println!`: `println!` panics when the reader closes
  the pipe early (`| head -c`), and release builds abort on panic. A failed write exits 1 naming it.
- The happy-path test runs `capture`, not the issue's `search`: `search` needs settled full-text
  indexing, and `capture` shows both the arguments going in and the stored block.
- `real_server` and `DEV` moved from `tests_rmcp.rs` into `mcp::test_support` so the binary smoke
  tests serve the real registries.
- `bridge_binary()` prefers `target/debug` over `target/release`: rebuild the debug binary after
  every change, or the smoke tests run a stale one.
- On Windows the release binary is a GUI-subsystem program, so `call` typed at an interactive
  console shows no output unless redirected. Not changed; nothing here builds Windows.

Ran: the `stub_binary_` smoke tests with `ci-smoke`, the binary's own tests, the `mcp::` tests, and
clippy over the workspace.
