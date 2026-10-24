# Session 2904 — the MCP guide says what create_tag emits

`src-tauri/src/mcp/AGENTS.md` said that a tool touching no page, such as a top-level tag, emits no `blocks:changed`. Since #6102, `create_tag` emits it and names the tag itself. An empty page set would make the frontend reload every mounted page, and the targeted form still drops the `#` picker's tag list. The line now says so, so nobody removes the emit again.

The maintainer approved this edit (2026-10-24).
