# Session 2055 — MCP: names in place of ids, links in written content

#5397. Agents had to search before every write ("append to Project X") and
stored `[[Project X]]` or `#work` as plain text that looked linked but was
not.

- Page, tag and parent arguments take a ULID or a name. A ULID is the id, as
  before; anything else resolves in the call's `space_id` (#5415) with the
  paste resolver's rule: exact title, else one case-insensitive title, else an
  alias; tags by normalized name. A tie gives `Validation` naming up to five
  candidates; an unknown name gives `Validation`. Block ids stay ULID-only,
  and `get_page` / `get_page_markdown` take no `space_id` yet, so they take
  ids only.
- `append_block` and `update_block_content` now run content through
  `resolve_pasted_names`, as paste, `append_markdown` and `capture` already
  did: `[[Name]]` and `#name` are stored as tokens, creating the page or tag
  when nothing matches. A page title or tag name passed to
  `update_block_content` is kept as written. A name left as text (a tie)
  comes back in a `warnings` array.
- New RO `resolve { names, space_id }` looks many names up in one page
  snapshot and one tag snapshot.

Trap: a mutation that skipped uppercasing a ULID argument survived the whole
MCP suite, because a lowercase ULID slipped past the cross-space check; a
dedicated test now pins it. The rebase onto #5535 also dropped that PR's
instruction line-cap test, as its review asked.

Suites run: the `mcp::`, paste, markdown and capture nextest subsets, clippy
and fmt over the workspace, each new test shown red by a mutation on a copy.
