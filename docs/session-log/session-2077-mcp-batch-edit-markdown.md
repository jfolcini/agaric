# Session 2077 — MCP batch and edit_page_markdown (#5399 slice 2)

Two read-write MCP tools. `batch { ops, space_id }` applies `append_block`,
`update_block_content`, `set_property`, `add_tag`, `remove_tag`, `move_blocks` and
`delete_block` ops in one transaction: each op is parsed as its tool's own arguments
and validated through that tool's checks (split out as `prepare_*`) before the
transaction opens, because the space check takes the writer on its own connection;
each op's new `_in_tx` half then runs inside one `BEGIN IMMEDIATE` with the engine
rollback armed. A call is one activity entry and one undo, and a batch that would
write more ops than one undo reverts is refused. `edit_page_markdown` saves an agent's
edit of a page's source through `apply_page_source_inner` with `merge: false`; `base`
is required and a stale one is refused with `RequiresRefresh`, because a merge keeps
blocks changed twice and an agent cannot review that. `get_page_markdown` gains
`editable: true`, which returns that source.

The old single-tool entry points now wrap the new `_in_tx` functions; the review
compared each old body with its wrapper pair line by line. `delete_block_inner` calls
`dispatch_deletes` instead of inlining the same post-commit calls. The rebase onto
main took `space_id` on `get_page_markdown` (session 2063) alongside `editable`.

Review fixes: the bulk-equivalence baseline recorded the ten new bulk-named
functions; `at_op` names `ops[i]` on a malformed ULID; tests for the engine rollback,
the post-commit emits and the delete fan-out, each shown red with its code removed.
Gates: clippy on the workspace, the whole workspace under nextest in four partitions
(one conformance test timed out at 60 s under load and passes alone),
`ts_bindings_up_to_date`, the bulk-equivalence guard.
