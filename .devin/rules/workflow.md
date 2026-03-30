# Agent Workflow Details

Extended guidance for AI agents. Project essentials are in `AGENTS.md` at the repo root.

## Browser Preview (Chrome DevTools MCP)

The Tauri webview doesn't expose CDP. Use the Vite dev server with `chrome-browser` MCP instead.

`src/lib/tauri-mock.ts` mocks all Tauri IPC with an in-memory store. `src/main.tsx` detects `!window.__TAURI_INTERNALS__` and loads it automatically. The mock is dev-only (tree-shaken from production builds) and ephemeral (resets on reload). It does NOT replicate backend logic (op log, materializer, pagination).

### Visual development workflow

```bash
# 1. Start Vite (background)
npm run dev

# 2. Use chrome-browser MCP
mcp_call_tool(chrome-browser, navigate_page, {type: "url", url: "http://localhost:5173"})
mcp_call_tool(chrome-browser, take_screenshot, {filePath: "/tmp/app-screenshot.png"})
# read("/tmp/app-screenshot.png") to view
mcp_call_tool(chrome-browser, take_snapshot)  # a11y tree with uids
mcp_call_tool(chrome-browser, click, {uid: "<uid>", includeSnapshot: true})
mcp_call_tool(chrome-browser, fill, {uid: "<uid>", value: "text", includeSnapshot: true})
```

Always use `chrome-browser` (launches its own headless Chrome, fully autonomous). Use `chrome-devtools` only if you need the user's existing browser session.

## Subagent Details

### Compilation cost awareness

| Command | Incremental time |
|---------|-----------------|
| `cargo fmt --check` | 0.1s |
| `cargo nextest run` | ~1.3s |
| `cargo clippy` | 2.0s |
| `biome check` | 0.2s |
| `tsc -b --noEmit` | 1.0s |
| `vitest run` | 1.0s |
| `cargo tarpaulin` | ~60s |

Cold compile in new worktree: **~15s**.

### Subagent verification

Build subagents verify only their own work: `cargo test` (or relevant module tests). Don't run clippy/fmt/biome/prek — the orchestrator runs prek once after merging all results.

Review subagents that make fixes run `cargo test` to verify. Clippy/fmt issues get caught at commit time.

### When to use worktrees

All three conditions must be met:
1. Two or more subagents running in parallel
2. Each touches different files (no overlap)
3. Each involves 3+ file changes

Skip for: sequential work, single-file edits, review-only subagents.

### Subagent sizing

Prefer fewer, larger subagents (2-5 related tasks in one domain). Each pays ~15s cold-compile overhead. Batch 1-line changes or do them directly as orchestrator.

### Subagent prompts

Keep minimal. Include only:
1. Working directory path
2. `. "$HOME/.cargo/env"` (for Rust subagents)
3. Files to create/modify and what to implement
4. Relevant ADR numbers (not full text — say "see ADR-07")
5. What NOT to modify
6. Verification command

Don't include: file contents, ADR text, environment tables, long checklists.

### Task statuses

| Status | Meaning |
|--------|---------|
| `[BUILT]` | Code written, not yet reviewed |
| `[REVIEWED]` | Reviewed and tested by separate subagent |
