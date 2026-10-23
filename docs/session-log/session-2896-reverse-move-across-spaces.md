# Session 2896 — a reverse move across spaces is refused, and the SQL-only fallback is loud

#6047. An MCP agent moves block X from P1 to P2, both in space A. The user then moves P2 to space B, and later reverts the agent's move from the Activity Feed. SQL put X back under P1 in space A, but X's engine stayed in B's doc. `converge_reverse_move_engine` only warned. Every later edit to X took the SQL-only fallback, which counts and logs at debug level, so X silently stopped syncing.

**The refusal:** `reverse_move_preflight` refuses (`NonReversible`) when the block and its prior parent both resolve to a space and the two differ.
- It is the one gate every reverse move passes: History revert, the Activity Feed and MCP `undo` (`revert_ops`), `undo_op` / `undo_ops`, `undo_page_op`, `redo_page_op`, `undo_page_group`, and `restore_page_to_op`, which skips and counts the refused op.
- A batch that also reverts the page's space move runs that reverse first, so the move reverse then passes.
- Refusing rather than re-homing is the issue's call; re-homing waits for a second instance.
- A plain forward `move_block_inner` across spaces strands a block the same way. No caller reaches it today: the frontend moves within one page tree, and MCP `move_blocks` is space-guarded.

**The fallback is loud:**
- `sql_only_fallback::record` warns. Its custom tracing target was removed, because the default filter (`agaric=info`) dropped any target outside the crate.
- The App health panel shows `sql_only_fallback_count` and `descendant_fanout_dropped`. Both should stay at zero, so the counter now skips the expected cases:
  - a parentless page or tag create, which every creator follows with `SetProperty(space)` in the same transaction;
  - the `is_space` op that registers a space;
  - edits to the two seeded space blocks, which are in no doc by design (#4775).
- A first session — bootstrap, renaming and recolouring the seeded space, `create_space`, a page, a tag, a journal day, a block and an edit — now reads 0, pinned by a Rust test and by the real-backend App health spec.

**Shown red:**
- With the space check off, the refusal test, the redo test and the reworked forward-move test fail at their `expect_err`.
- With the page/tag exemption off, `no_space_creates_take_sql_only_fallback` reads 4, not 2. Its nested-page arm pins the `parent_id` half.
- With the `is_space` or seeded-space exemption off, the first-session test reads 3 and 4.
- With the seeded-space exemption off, the App health spec fails on the real backend.

`apply_reverse_move_block_refreshes_space_id_657` asserted that a cross-space reverse succeeds, and is deleted. Within one space a reverse cannot change `space_id`, and the `page_id` re-derivation stays covered.

**Not here:**
- the proptest undo arms, which need a materializer driver and a second page;
- naming the cause in the refusal toast, which needs a reason on `NonReversible`.

**Suites:**
- the whole workspace under nextest;
- clippy and `SQLX_OFFLINE` check;
- bindings unchanged;
- vitest over the agenda components, the mock and the stores;
- typecheck and lint;
- Playwright: settings, history and undo;
- the real-backend App health spec.
