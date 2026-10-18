# Session 2636 — the real-backend agent spec covers a read-only agent held to Work, and Disconnect all

#5887's two Agent access items, added to `e2e-tauri/mcp-agent-token.e2e.ts`
so they share its app boot.

- **Read-only, Work only:** the agent made in Settings as Read only with Work
  ticked is refused `append_block` (`-32001`, unknown tool: a read-only agent
  is served the read-only tool set), `list_spaces` returns exactly Work, and
  `get_page` on a Personal page is refused (`-32602`, may not use space).
- **Connections, attribution, Disconnect all:** a read-write agent connects
  and the tab reads "1 active connection."; the block it appends shows origin
  `agent:<name>` in `block_history`; Disconnect all drops the backend's count
  to 0, and the bridge's next call gets no reply and it exits.

Where the product differs from the issue text:
- There is no connections list, only a count with Disconnect all.
- The History view shows no origin; `agent:<name>` is visible in the activity
  feed and the MCP history tools. `docs/features/agent-access.md` claimed
  History showed it in one line and denied it in another; the first is fixed.
- Disconnect all keeps serving the connection for its grace period
  (`MCP_DISCONNECT_GRACE_PERIOD`), so the spec waits for the count to drop.

Shown red per scenario by breaking the code behind it: read-only agents served
the read-write tools, `disconnect_all` a no-op, the origin written as
`agent-<name>`, and `retain_spaces` returning early; each failed at its
predicted assertion.

Ran: `just e2e-real e2e-tauri/mcp-agent-token.e2e.ts` (1 spec file, 3 tests,
about 56 s), `tsc -p tsconfig.wdio.json`, `oxlint e2e-tauri`,
`vitest run e2e-tauri` (46), `node --test scripts/e2e-related.test.mjs` (10).
