# Session 4043 — the edit rebase reads the engine's text

`Refs #6533` (the first follow-up the maintainer decided on 2026-11-13).

`edit_block` rebased a stale editor's text onto the `blocks` row. A sync import reaches the engine
before it takes the writer lock to project, so a save that won the lock in between saw a row equal
to its base, was not rebased, and its diff against the engine's text deleted the peer's edit. The
rebase now reads the text the edit is diffed against: the engine's
(`loro_apply::engine_block_content`), falling back to the row when no doc holds the block.

Decisions and traps:

- The engine is read only when the caller sent a base; the callers without one are unchanged.
- The read goes through `registry.with_engine`, which marks a space dirty only when its op log
  moved, so it costs no snapshot write.
- The test stands in for the gap by importing a peer's export into the engine with nothing
  projected. It lives in `session_save_tests.rs` for its two-device harness.
- The fallback arm is held by the rebase tests in `block_cmd_tests.rs`, whose blocks have no space
  and so no doc.
- The reviewer's note on the rebase PR (#6677) is taken here: `rebased_onto` and the mock's
  `rebasedOnto` no longer compare the base with the current text first, since `rebase_edit` gives
  the text sent when they are equal (`a_base_the_block_still_holds_gives_the_text_sent`).
- Not covered (read in `find_prev_edit_in_tx`, not run): what the op records as overwritten still
  comes from the row, so undoing a save made in that gap writes the row's earlier text and takes
  the peer's edit with it, as the save itself did before.

Built by an earlier session on the pre-squash rebase branch; this one merged `main` (#6677 is the
squash of that branch) and kept `main`'s side of every conflict outside this change's own hunks.

Ran, on the merged tree: the new test red on each arm (`abcY` for `XabcY` with the row read alone;
the two rebase tests of `block_cmd_tests.rs` with the fallback removed), then the workspace nextest
in two halves, the `SQLX_OFFLINE` check and clippy over the workspace with all targets; the mock
and conformance vitest files, typecheck, lint, and `e2e/reload-keeps-editor.spec.ts`. No SQL
changed. `just e2e-related` selects both whole lanes, left to CI.
