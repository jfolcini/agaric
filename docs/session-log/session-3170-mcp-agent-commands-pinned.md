# Session 3170 — MCP agent commands pinned in the conformance fixtures

Section D6 of #6054: `create_mcp_agent`, `revoke_mcp_agent` and `list_mcp_agents` were the last commands on the coverage waivers. They are now driven by `conformance/fixtures/mcp_agents_lifecycle.json`, authored by the backend, and both not-yet-pinned lists are empty.

**Harness.**
- Both stacks mint the agent id, so revoke needs an agent both runners can name: a `seed.mcp_agents` section on each runner, inserted raw as `peer_refs` is.
- The harness space is live only on the backend, so the fixture creates its own space and grants that. Granted spaces are listed as `#space_ids=<id>` segments so the existing relabel compares created ids across the stacks.

**Pinned:** name trimmed on store; blank name, empty space list, a page that is not a space, and a duplicate name in another case refused; revoke twice is `not_found`; the list orders case-insensitively.

**Mock:** already agreed on every pinned behaviour. Shown red by five one-command mutations of `handlers/sync.ts` (duplicate check off, byte-order sort, revoke a no-op, every space dead, empty-list check off).

**Not pinned:** control characters in a name, the name length cap, and lowercase space ids (labels cannot spell them).

**Suites:** conformance nextest, vitest over `src/lib/tauri-mock`, typecheck, clippy, fmt. Reviewed by a separate subagent, which re-authored the fixture and found it identical. The merge with main took the arm counters to the sum of both sides (#5841 S3 added arms in parallel).
