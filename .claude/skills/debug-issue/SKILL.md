---
name: debug-issue
description: Trace a bug through callers, callees, and recent changes with the code-review-graph MCP tools
---

## Debug Issue

Needs the optional `code-review-graph` MCP server (declared in `.mcp.json`, started only when `uvx` is installed). If its tools do not respond, use Grep/Glob/Read instead and do not retry.

1. `get_minimal_context(task="…")`, then `semantic_search_nodes` for the code involved.
2. `query_graph` with `callers_of` / `callees_of` to trace the call chain; `get_flow` for the full path.
3. `detect_changes` to see whether a recent change introduced it.

Use `detail_level="minimal"`; escalate only when it is not enough.
