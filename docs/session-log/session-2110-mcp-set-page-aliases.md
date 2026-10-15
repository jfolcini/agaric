# Session 2110 — MCP set_page_aliases; activity summaries never echo a name

The last open tool of #5378, now that aliases are ops (#5563).

`set_page_aliases { page_id, aliases, space_id }` replaces a page's alias list
through `set_page_aliases_inner`, so one call is one activity entry whose Undo
restores the previous list. `page_id` takes a ULID, title or alias like its
siblings; a page of another space is refused, and an alias another page holds
is refused with `DuplicatePageAlias` and nothing written. A non-page id answers
`NotFound`, as the app's own command does. The summary counts aliases and reads
the page id from the result, never the alias text.

Writing that summary showed the privacy contract had a hole: since #5397 an
id argument may be a page title or tag name, and seven summary arms printed an
8-character prefix of the argument, so the start of a title or tag name could
reach the activity feed. `move_page_to_space`, `append_block`, `add_tag`,
`remove_tag` and `move_blocks` now take the id from their result;
`append_markdown` and the history tools, whose results do not carry it, print
a prefix only when the argument parses as a ULID. The privacy guard now uses
name-shaped arguments and rejects an 8-character prefix of a secret, not just
the whole string; it went red on the old code (`page_history — 1 op on
SECRET_T`), as did each arm's own test.

Each new tool test was shown red (cross-space check removed, taken list
ignored, live-page check bypassed, appends drained before the adapter). Gates:
nextest over `mcp::`, `alias`, `summarise`, `conformance` and
`ts_bindings_up_to_date` (581 passed), clippy, `cargo check`, `cargo fmt`;
bindings unchanged.
