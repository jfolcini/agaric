# Session 2063 — MCP: the last space-free reads take a required space

The MCP half of #5415. #5538 made every app command take one space; four
MCP reads still took none and spanned the vault: `list_pages`, `get_page`,
`get_page_markdown` and `get_block`. Each now requires `space_id`.
`list_pages` lists that space's pages (`list_pages_inner` takes the space;
the unscoped `get_page_unscoped_inner` and its `.sqlx` entry are gone), and
the three id-addressed reads refuse a target in another space through
`validate_block_in_space`, as the history tools already did.

`list_property_defs` stays space-free alongside `list_spaces`: property
definitions have no space column and the app's own `list_property_defs`
takes none, so a required `space_id` would be read and ignored. This departs
from the issue's "every tool" acceptance line, so the PR leaves the issue for
the maintainer to close.

Review caught two agent-facing texts: `validate_block_in_space` told a reader
its "cross-space write" was denied (it now names the block's space and the
requested one), and the RO instructions still said `list_backlinks` and
`get_agenda` span every space when `space_id` is omitted. The docs
(`agent-access.md`, `integrations.md`, `threat-model.md`, `spaces.md`,
`src-tauri/src/mcp/AGENTS.md`) and `scripts/mcp_smoke.py` follow.

Merging `main` brought #5542's `query` tool, which already takes a space;
both branches had appended tests at the end of `tools_ro/tests.rs`.

Suites run: whole-workspace nextest in four partitions before the merge;
after it, the `mcp` and `list_pages`/`get_page`/`get_block` subsets and
clippy over the workspace with `SQLX_OFFLINE`; each new refusal test shown
red with its space check removed on a copy.
