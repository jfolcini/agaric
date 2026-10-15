# Session 2102 — MCP: reads never wait for the writer, one transaction per write

#5402. The MCP is on the agent's critical path, and every tool call is a round
trip:
- `get_block`, `get_page_markdown`, `page_history` and `block_history` checked
  space membership with a rolled-back `BEGIN IMMEDIATE` on the writer;
- the RW `list_spaces` ran on the writer pool;
- every write tool opened a separate rolled-back transaction for its space check
  before its own.

What changed:
- **Reads check on the reader pool.** `journal_for_date` returns its probe hit
  without touching the writer, and the RW `list_spaces` reads too.
- **One transaction per write.** Each write tool's space check runs inside its
  own command transaction (`with_space_guard`, checked by
  `CommandTx::begin_immediate`).
- **Byte caps.** `get_page`, `list_backlinks` and `get_page_markdown` stop at a
  64 KiB content budget. They always return at least one unit, and say
  `truncated` with a cursor that continues without losing blocks.
  `get_page_markdown` with `editable: true` is never cut, because
  `edit_page_markdown` needs the whole source as its base.

Merging `main` brought #5554's `batch` and `edit_page_markdown`, which kept the
separate pre-transaction space check. The merge moves `batch`'s per-op check
inside the batch's one transaction, on its own connection, so N ops open one
transaction, not N+1. It also wraps `edit_page_markdown` in `with_space_guard`.
`prepare_update_block_content` and `prepare_delete_block` went away once they
only normalised an id.

New `interactive_slo` probes cover MCP `get_page_markdown`, `get_journal`,
`resolve` and `query` in the 30 ms tier, and `search` report-only. The
before-run passed every budget (2.67, 0.93, 0.21, 2.35 and 1.28 ms), so the
probes pin the budgets. The gains are in contention with the writer, which the
tests pin.

Tests:
- `each_write_tool_opens_one_command_transaction_5402` counts transactions per
  write tool, now including a five-op `batch`;
- tests hold the writer to prove the reads take no write connection;
- byte-cap continuation tests check that the pages join with no gaps or
  repeats.

Falsified on copies in the lane:
- an extra transaction before `run_batch` turned the count test red at
  `("batch", 2)`;
- dropping the per-op check turned `batch_op_on_another_space_is_refused_5399`
  red.

Suites run:
- nextest on mcp, command_tx, markdown, get_page, `_5402`, `_5399`, bindings
  and conformance: 567 passed;
- clippy, after a `Box::pin` in the count helper for `large_futures`;
- `cargo doc` with the CI lint flags.
