# Session 2033 — MCP move, remove tag, restore and trash

First slice of #5399: an agent reorganising notes can now move blocks
instead of deleting and recreating them, which kept losing ids, backlinks
and history.

Shipped four tools, each over an existing command and each taking a required
`space_id` (#5415):

- RW `move_blocks { block_ids, parent_id, position?, space_id }` over
  `move_blocks_batch_inner`: one transaction, ids kept, the blocks land in the
  given order. `position` is 1-based like `append_block`; a cycle is refused.
  Its `blocks:changed` covers the pages the blocks left as well as the target,
  so an open view of the old page does not keep showing them.
- RW `remove_tag` over `remove_tag_inner`.
- RW `restore_block { block_id, deleted_at, space_id }` over
  `restore_block_inner`, keeping the app's optimistic `deleted_at` check.
- RO `list_trash`, cursor paginated, parsing `space_id` strictly so a
  non-ULID is refused rather than widened to every space.

Each tool has an activity-feed summariser. Left for a later slice: `batch`
and `edit_page_markdown`.

Trap: the shared summariser fixtures all start `01HZTEST`, so a swapped tag
and block id printed the same string and the first `remove_tag` summariser
test passed vacuously; it now uses distinct ids.

Suites run: the `mcp::` nextest subset of the app crate, clippy over the
workspace, and every new test shown red by breaking its handler on a copy.
