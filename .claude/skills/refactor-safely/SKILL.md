---
name: refactor-safely
description: Preview and apply renames and dead-code removal with the code-review-graph MCP tools
---

## Refactor Safely

Needs the optional `code-review-graph` MCP server (declared in `.mcp.json`, started only when `uvx` is installed). If its tools do not respond, use Grep/Glob/Read instead and do not retry.

1. `get_minimal_context(task="…")`, then `get_impact_radius` on the target.
2. `refactor_tool` with `mode="rename"` or `mode="dead_code"` to preview the edit list; `apply_refactor_tool` with the returned id to apply.
3. `detect_changes` afterwards to confirm the impact matches the preview.

Use `detail_level="minimal"`; escalate only when it is not enough.
