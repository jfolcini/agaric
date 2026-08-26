---
name: refactor-safely
description: Plan and execute safe refactoring using dependency analysis
---

## Refactor Safely

> **Requires the optional `code-review-graph` MCP server.** Every tool named below
> (`detect_changes`, `query_graph`, `semantic_search_nodes`, `refactor_tool`, …) comes from
> it. It is declared in [`.mcp.json`](../../../.mcp.json) but is **not** started unless
> `uvx` is installed, and a client may disable it — so confirm the tools respond before
> following these steps. If they do not, fall back to symbol-aware tools if your agent has
> them (see [AGENTS.md § Code Navigation](../../../AGENTS.md#code-navigation)) or to
> Grep/Glob/Read. Do not retry a tool that is simply absent.

Use the knowledge graph to plan and execute refactoring with confidence.

### Steps

1. Use `refactor_tool` with mode="suggest" for community-driven refactoring suggestions.
2. Use `refactor_tool` with mode="dead_code" to find unreferenced code.
3. For renames, use `refactor_tool` with mode="rename" to preview all affected locations.
4. Use `apply_refactor_tool` with the refactor_id to apply renames.
5. After changes, run `detect_changes` to verify the refactoring impact.

### Safety Checks

- Always preview before applying (rename mode gives you an edit list).
- Check `get_impact_radius` before major refactors.
- Use `get_affected_flows` to ensure no critical paths are broken.
- Run `find_large_functions` to identify decomposition targets.

## Token Efficiency Rules

- ALWAYS start with `get_minimal_context(task="<your task>")` before any other graph tool.
- Use `detail_level="minimal"` on all calls. Only escalate to "standard" when minimal is insufficient.
- Target: complete any review/debug/refactor task in ≤5 tool calls and ≤800 total output tokens.
