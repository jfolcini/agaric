# Session 4373 — Undo after a paired tag rename, and page undo without a second writer (#6971, #6976)

This follow-up to #6973, slice 2 of #6755, holds what that PR's review asked for after it merged.

**#6971.** A paired rename (a tag and its `Tag/x` page) appends two `edit_block` ops. Undo on the tag's page counted both against that page's `undoDepth`, so once the session stack ran out, positional undo skipped an op.
- The backend now marks each half of a pair on its `UndoResult`, as `paired_rename_of`, with the block it renamed.
- The store counts a result against the page only when it isn't another page's half, and redo gives back the decrement it took for that half.

**#6976.** `revert_ops_in_tx` held the command's write transaction while `compute_reverses_newest_first` read through the write pool. That takes the second writer, and when it was busy, a page undo waited out the 10 s acquire timeout and undid nothing. The reverse batch (`compute_reverse_batch`, `get_op_records_batch`, `reject_replicated_targets`) now reads through the transaction's connection, and `revert_ops_in_tx` lost its pool parameter.

**#6973's review notes:**
- `with_tag_path_partners` pairs ops only within one space; a rename in another space with the same new name was pulled in.
- `undo_op_inner` answers the result of the ref the caller named, not the partner's.
- The mock's `undo_op` now reverts the partner too, as the backend does.

**The bridge.** `e2e/tag-page-notes.spec.ts` joins `REAL_BACKEND_SPECS`. It was stable on the bridge across 40 runs at 1 and 3 workers, and went red when the tag rename's page move was broken in the backend.

**Trap.** The session-log number reserved for this PR, 4370, fell below main's max (4372) before the commit. Reserve-and-commit-at-once is the only safe order.

**What ran:**
- Rust: targeted nextest for undo, revert, redo, restore, tag pages, conformance and bindings (753); clippy `-D warnings`; the sqlx check.
- Frontend: vitest across stores, the mock, pages and history (4346); typecheck.
- e2e: the bridge and mock runs of `tag-page-notes`, and the related undo and history mock specs.
- Every fix was shown red first.
