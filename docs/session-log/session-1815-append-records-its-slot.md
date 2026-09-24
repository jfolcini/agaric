# Session 1815 — an append records its slot, so moving the block undoes

#5155 was found while building Phase 4a of #5140 (session 1813). Undoing a move of a block that an append created failed with `NonReversible`.
- **Cause.** Since #400, `create_block_in_tx` records a create op as `CreateBlockPayload { position: None, index }`, and an append passes `index: None`, so the op recorded neither. Both reverse-move builders read `(None, None)` as a payload with no recoverable slot: `find_prior_position` for `undo_page_op`, and `build_reverse_move_block` for `undo_ops`, `revert_ops`, `undo_page_group` and `restore_page_to_op`.
- **Who was hit.** Every append-created block: a page's first block, template blocks, import, paste and Duplicate children, recurrence siblings and MCP appends. Its first move couldn't be undone, and `undo_page_group` aborted the whole group.

**Fix.**
- **The slot.** A parented append now resolves to the parent's live child count and records it as `index`. The engine already put the block at that slot, since `live_tree_slot(parent, L)` lands before any trailing tombstone. Top-level creates are unchanged.
- **The SQL-only fallback** writes `index + 1` as the position. After tombstones, that sorts before the live tail, so the bare-append fix-up now also runs when the position is below the next free one. On the engine path the rank already equals it, so the fix-up is a no-op there.
- **The mock** records the same slot for `create_block` and `create_blocks_batch`. A new fixture, `append_create_undo.json`, pins append → move → undo on both sides.
- **Old logs.** Appends already in a log stay non-reversible on their first later move. Their slot can't be recovered without replaying the parent's history, and guessing "the end" would silently reorder blocks. That move's op records its slot, so later moves undo.

**Checked by the reviewer.** The recorded slot is the one the engine consumed, through the same payload. Where SQL and the engine could disagree (the #1257 window), undo lands where the create did. `apply_page_source` never appends: it passes explicit slots. So 4a's fixture and every other fixture are byte-unchanged. Recovery now reads a slot instead of NULL for appends, which orders them better.

**Also fixed: a lost "Add block" click.** The real-backend smoke `search-bm25-order` went red on this PR, but not because of it: the backend placed and listed the blocks correctly under probes, and the same failure shows in a run from before it. Pressing the mouse on "Add block" blurred the editor, which swapped the edited row for the shorter static row. The button moved up under the pointer, so the release missed it and no block was created. The button now keeps the editor through the click (`preventDefault` on mousedown, as the inline block controls do). `e2e/journal-add-block-while-editing.spec.ts` injects IPC latency and a human-sized press. It went red twice against a copy without the fix and passes three times in a row with it.

**Verified.**
- `cargo nextest run --workspace` ran 6474 tests with 0 failures, split into two partitions to fit the tool limit.
- Clippy, fmt, the offline `sqlx` check and the rustdoc link check are clean, and the mock suite passed 1020 tests.
- T1 and T2 failed with `NonReversible` before the fix, and so did the fixture.
- Falsified against copies:
  - restoring `None` reddens T1–T4 and the fixture;
  - counting tombstones reddens T4;
  - an off-by-one reddens T1;
  - reverting the fix-up reddens T5;
  - leaving the mock alone reddens the fixture on the TS side.
