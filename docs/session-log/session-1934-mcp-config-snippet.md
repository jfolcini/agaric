# Session 1934 — Agent access snippets wire both MCP sockets (#5374)

Setting up the Agaric MCP for Claude Code this session showed the client
had only the read-only socket configured, so turning on read-write access in
the app reached nothing. The Agent access tab copied a single `agaric` entry
built from the read-only status alone.

What shipped:

- The Claude Desktop JSON lists `agaric-ro` and `agaric-rw`, each with its own
  socket. The read-write entry is left out only when its status failed to
  load.
- A "Copy Claude Code commands" button copies one `claude mcp add -s user`
  line per surface, passing the socket as a quoted `--socket` argument (an
  `Application Support` path has a space; a Windows pipe path survives the
  quotes).
- The flat "generic" snippet is gone: it could only describe one server, which
  was the bug. `docs/features/agent-access.md` describes the new snippets.

Verified: both snippet tests went red with the read-write half broken
(builder and reviewer, each on a copy, restored and `cmp`-checked);
`AgentAccessTab` tests 60 passed; `npm run typecheck` exit 0; oxlint and
oxfmt clean. Playwright (`e2e/agent-access.spec.ts`, one renamed button) runs
in CI.
