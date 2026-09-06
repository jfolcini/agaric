# Session 1522 — "enabled" and "useful" are two different states

The ask was to turn on the code-graph MCP server. The interesting part is that nothing needed
to be *added* — every piece was already present, and each one was independently switched off.

## Three layers, and the answer differed at each

`.mcp.json` has declared `code-review-graph` (`uvx code-review-graph serve`) since May. So the
first-order answer to "is it enabled?" is yes: the server is configured, the binary resolves,
`--help` works. But no `mcp__code-review-graph__*` tool existed in the session, which is the
only evidence that actually matters.

The reason sat one layer down: `.claude/settings.local.json` listed the server under
`disabledMcpjsonServers`. A declared-but-disabled server is invisible in exactly the same way as
an undeclared one — the tool list is identical. Reading `.mcp.json` alone would have produced a
confident wrong answer.

The fix is two edits, and they are not redundant:

- removing the `disabledMcpjsonServers` entry un-disables it **here**, in this checkout's
  untracked local settings;
- adding `"enabledMcpjsonServers": ["code-review-graph"]` to the tracked `.claude/settings.json`
  pre-approves the `.mcp.json` server **for the repo**, so a fresh clone loads it without a
  trust prompt.

Only the second is committable. The first cannot be, by construction — `.gitignore:100` excludes
`settings.local.json` — which is why "enable it for the project in general" needs the tracked
file and is not satisfied by fixing the local one.

## The third switch was the data

With both flags right, `status` still reported `Nodes: 0, Edges: 0, Files: 0`, last built
2026-05-14 at commit `6a4dfef0`. The graph directory existed, the database file existed, and it
held nothing. A server wired up over an empty graph answers every query with silence, which
reads like a working tool with an uninteresting codebase — the same failure shape as an absent
CI check reported as a pass. So the enablement is not done at the flag; it is done when
`build` has repopulated `.code-review-graph/graph.db` (already gitignored at `.gitignore:116`,
so none of that data touches the repo).

Worth keeping: for anything with a declaration, a switch, and a data store, "is it on?" has to
be answered at the store. The first two can both say yes over an empty one.
