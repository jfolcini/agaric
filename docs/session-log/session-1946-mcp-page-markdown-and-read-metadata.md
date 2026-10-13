# Session 1946 — MCP reads a page as Markdown and sees its metadata (#5375, #5377)

Agents reading a page through MCP got a paginated block list with raw ULIDs
in links and tags and no properties, tags or aliases, so a whole page cost
several calls and the result still needed decoding.

What shipped:

- `get_page_markdown { page_id }`, an eleventh read-only tool: `# Title`,
  YAML front matter (aliases, tags, properties), then the block outline with
  `key:: value` lines. Links, tags and ref-typed values are written as names,
  and every block ends with `^ULID` so the agent can address it. One reader
  snapshot, no pagination, as the export does (#5375's decision).
- It is a new `Agent` render mode in `commands/pages/markdown.rs` next to
  the export and source modes; `named_block_text` is split out of
  `export_block_text` so a same-page ref target gets one anchor, not two.
- `get_block` and `get_page` return `properties`, `tags` and, for pages,
  `aliases`, from a fixed three reads per call.
- The activity summary is metadata only: `get_page_markdown — <id prefix>
  (N lines)`. The privacy guard now feeds markdown, aliases and property
  values through every summariser.
- `scripts/mcp_smoke.py`, `docs/features/agent-access.md`,
  `docs/architecture/integrations.md` and `COMPARISON.md` list the new tool.

Names resolve vault-wide, as the export and the existing RO tools already do
(`src-tauri/src/mcp/AGENTS.md`, full-vault RO scope).

Verified: builder and reviewer falsified each new test on copies (renderer
fallthrough, double anchor, summary leaking markdown, missing summariser arm,
empty tags, aliases always present, un-normalised id, swallowed errors; all
red, restored and `cmp`-checked). Full `cargo nextest run --workspace` 6731
passed; clippy `-D warnings`, `SQLX_OFFLINE=true cargo check`, `cargo fmt
--check` and `cargo doc` with the hook's flags all clean; bindings test
green, no regen needed.
