# Session 1805 — markdown source mode, phase 0, and review notes

This session fixed an `e2e-tauri` flake, then started #5140, the per-page markdown source mode, in the order the maintainer chose: coherence first.

**The flake (#5141).** On a page that already had content, the virgin-vault fallback in `openJournalBlockEditor` clicked the last static block. That handed the previous block's text to `typeMarkerVerified`, and its retry select-all-deleted it. The fallback now fires only when the last static renders `StaticBlock`'s `.block-placeholder`, the one reliable sign of an empty block. A text check cannot work because the placeholder carries a visible hint. This PR drops the reviewer-flagged emptiness assertion in `addBlockWithMarker`: every reachable path already hands it an empty editor, and the one path that wouldn't (a journal template) would make the assertion throw by mistake. It also drops the second copy of the fallback's rationale.

**Phase 0a (#5145).** Extracted `edit_block_in_tx` and `delete_block_in_tx` from their `_inner` functions, as #2274 did for moves, and made `move_block_in_tx` `pub(crate)`. The later phases apply a whole buffer in one `CommandTx`, and these are the pieces they compose. Behaviour is unchanged. The only visible difference is that an over-length edit is now rejected after the write lock rather than before it, and the reviewer confirmed the `Drop` rewind covers that. The reviewer asked for the `arm_engine_rollback` precondition to be stated once. This PR adds it to `src-tauri/src/commands/AGENTS.md` § `_in_tx` variants rather than repeating it in three doc comments.

**Phase 0b (#5146, open).** `create_blocks_batch` and `move_blocks_batch` now run under `capture_op_refs`, so paste, template insertion and multi-block move undo by exact ref instead of the positional fallback. A multi-level paste is now one undo entry. The builder falsified against copies: dropping one ref reds both Rust tests (2 vs 3), and passing `[]` reds both new frontend tests, which read the real undo store back. The pre-push verify passed on `f035c4c60`.

**Phase 1, re-planned** (comment on #5140). Reading the render and parse paths line by line showed the issue's premise, "the source grammar is the export format, raw", holds only on the render side. The importer strips `((…))`, trims and collapses spaces, and drops blank lines and continuation indentation, so the source mode needs its own lossless parse mode. The code-fence anchor defect the issue marked "unverified" is real (D1), and three more round-trip defects sit on the same lines:

- D2: list-styled code fences never open.
- D3: the exporter and importer each keep their own fence probe, and they disagree.
- D4: a `\- ` continuation line loses its backslash.

Phase 1 splits into 1a (D1–D4, shared) and 1b (the source grammar). The helper and planner that had no Phase 1 caller move to Phase 3, and the task marker is a source-mode rule only, so import and export output stay unchanged.
