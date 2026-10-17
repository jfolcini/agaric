# Session 2282 — The read-write MCP server also serves every read-only tool

#5379, held earlier in the night for #5667's agent-token design, now lands
as that design's step 1. An agent that writes needed both server entries to
find the ids it writes to.

**Premise check.** The issue body was out of date:
- RW had 18 write tools plus `list_spaces`, not six.
- The reader-pool wiring had already landed (#5402).
- #5374 was closed.

The maintainer's decision held as written.

**Change.**
- `ReadWriteTools` holds a `ReadOnlyTools`. It reads on the reader pool and
  uses the writer pool for `journal_for_date`'s create.
- RW lists its write tools, then RO's list.
- A name the write tools don't handle falls through to the read-only
  registry, so an unknown tool has one not-found path.
- RW's own `list_spaces` is gone.
- The read guidance comes from one `read_tools_primer!` that both instruction
  sets share. The RW text never says "read-only".
- Two sockets stay; the one-socket cut is #5667 step 4.
- Turning RO off no longer stops an RW client reading. Settings,
  `agent-access.md`, `integrations.md` and two lines of `mcp/AGENTS.md` say
  so. The maintainer approved nested AGENTS.md edits the change makes
  necessary.

**Tests.**
- The tool list: write tools in order, then RO's, with no duplicate.
- RW's `get_page` and `search` equal RO's.
- RW reads its own write on split pools.
- The existing `_5402` test still pins reads to the reader pool.
- Review found `journal_for_date`'s create through RW unpinned. If `reads`
  were built with the reader pool as its writer pool, or ran as the user,
  every `mcp::` test stayed green, while production's first create would
  fail read-only or be stamped `user`.
  `journal_for_date_on_rw_creates_the_day_as_the_agent_5379` now pins the
  pool, the agent origin and the view notification. Each of the three went
  red alone.

The plan said `rw_reads_its_own_write_5379` reds when `reads` is built on
another pool. It does not; only removing the fallback reds it. It stays as
the issue's acceptance item.

Gates: `mcp::` 408, the full workspace suite (3496 + 3488), clippy, check,
fmt, the settings and agent-access vitest files (316), and `npm run
typecheck`.
