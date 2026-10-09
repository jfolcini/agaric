# Session 1965 — MCP append_markdown

Issue #5376: `append_block` creates one block per call, so writing a structured page from an agent took dozens of calls. The new RW tool `append_markdown { parent_id, markdown, position?, space_id }` appends a whole outline under any live parent in one call and one transaction.

`append_markdown_inner` (`commands/pages/markdown.rs`) runs paste's own pipeline with the parent as the placement:
- `parse_pasted_text`, the grammar that import, Edit as Markdown and paste share;
- property lines, and `[[Name]]` / `#name` resolution, which creates any page or tag with no match in the parent's space, as the maintainer decided;
- `create_parsed_blocks` with the op cap that one undo can revert.

Paste and append now share the property-and-name step through `read_pasted_blocks`, and paste behaves exactly as before. Undoing every op ref of the call removes the blocks and any pages or tags it created.

Traps:
- A `key:: value` line must sit at its item's content column.
- A value the property definition refuses stays as text, as in paste. The seeded `effort` is a select, so tests need a valid option.

The RW tool lists in `sync_events.rs` and `useSyncEvents.ts` comments no longer enumerate the tools, so the next tool won't make them stale.

Suites that ran:
- nextest over `append_markdown`, `paste_blocks`, the MCP modules and property lines;
- `SQLX_OFFLINE` check of every target;
- clippy over every target.
