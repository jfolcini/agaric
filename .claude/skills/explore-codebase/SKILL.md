---
name: explore-codebase
description: Map an unfamiliar area of the codebase with the code-review-graph MCP tools
---

## Explore Codebase

Needs the optional `code-review-graph` MCP server (declared in `.mcp.json`, started only when `uvx` is installed). If its tools do not respond, use Grep/Glob/Read instead and do not retry.

1. `get_minimal_context(task="…")`, then `get_architecture_overview` / `list_communities` for the shape.
2. `semantic_search_nodes` to find the specific function or class; `children_of` a file for its members.
3. `query_graph` (`callers_of`, `callees_of`, `imports_of`) and `get_flow` to follow relationships.

Use `detail_level="minimal"`; escalate only when it is not enough.
