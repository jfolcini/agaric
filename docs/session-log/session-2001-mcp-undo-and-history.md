# Session 2001 — MCP undo and history tools

Set out to give agents a way to take back their own writes and to read what
changed (#5400).

Shipped: every write tool's result now carries the `op_refs` it appended,
added once in the MCP adapter rather than per tool. A new read-write `undo`
takes those refs and reverts them through the same path the activity feed's
Undo uses, refusing any op the calling agent did not write and any block
outside the given space. Two read-only tools, `page_history` and
`block_history`, page through a page's or block's ops with origin, op type
and a clipped before/after text, wrapping the existing history functions
without changing their signatures, since #5478 rewrites one of them.

Traps: the history rows had no origin, so one batched lookup by op ref
fills it for both the history tools and `undo`. The page history function
treats `__all__` as the whole vault, so the tools parse ids strictly and a
test pins the refusal. The space check opens a write transaction, so the
read-only history tools run it on the writer pool.

Left as is: undoing a property write refreshes the page but not the
property autocomplete cache, and a read-only `journal_for_date` that
creates the day also returns `op_refs`, which is harmless there.

Suites run: the MCP, revert and history nextest subsets, clippy over the
workspace, and `SQLX_OFFLINE=true cargo check`.
