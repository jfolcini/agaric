---
name: review-changes
description: Perform a structured code review using change detection and impact
---

## Review Changes

> **Requires the optional `code-review-graph` MCP server.** Every tool named below
> (`detect_changes`, `query_graph`, `semantic_search_nodes`, `refactor_tool`, …) comes from
> it. It is declared in [`.mcp.json`](../../../.mcp.json) but is **not** started unless
> `uvx` is installed, and a client may disable it — so confirm the tools respond before
> following these steps. If they do not, fall back to symbol-aware tools if your agent has
> them (see [AGENTS.md § Code Navigation](../../../AGENTS.md#code-navigation)) or to
> Grep/Glob/Read. Do not retry a tool that is simply absent.

Perform a thorough, risk-aware code review using the knowledge graph.

### Steps

1. Run `detect_changes` to get risk-scored change analysis.
2. Run `get_affected_flows` to find impacted execution paths.
3. For each high-risk function, run `query_graph` with pattern="tests_for" to check test coverage.
4. Run `get_impact_radius` to understand the blast radius.
5. For any untested changes, suggest specific test cases.

### Output Format

Provide findings grouped by risk level (high/medium/low) with:

- What changed and why it matters
- Test coverage status
- Suggested improvements
- Overall merge recommendation

## Token Efficiency Rules

- ALWAYS start with `get_minimal_context(task="<your task>")` before any other graph tool.
- Use `detail_level="minimal"` on all calls. Only escalate to "standard" when minimal is insufficient.
- Target: complete any review/debug/refactor task in ≤5 tool calls and ≤800 total output tokens.
