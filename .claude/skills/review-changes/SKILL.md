---
name: review-changes
description: Risk-rank a diff and its test coverage with the code-review-graph MCP tools
---

## Review Changes

Needs the optional `code-review-graph` MCP server (declared in `.mcp.json`, started only when `uvx` is installed). If its tools do not respond, use Grep/Glob/Read instead and do not retry.

1. `get_minimal_context(task="…")`, then `detect_changes` for the risk-scored change list.
2. `get_affected_flows` and `get_impact_radius` for what the change reaches.
3. `query_graph` with `pattern="tests_for"` on each high-risk function.

Report blocking defects first (a concrete failure), then what the ladder in `AGENTS.md` § How we work would have skipped: helpers, options, abstractions, and paragraphs the change did not need. Follow the review posture in `AGENTS.md` § How we work: no speculative hardening, no tests for unreachable cases. Use `detail_level="minimal"`.
