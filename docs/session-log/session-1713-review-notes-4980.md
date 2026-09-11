# Session 1713 — review notes from #4980

The three non-blocking notes the reviewer left on #4980 (block History
ordered by time, merged as `3ab77cd`), batched into one PR after the merge
per AGENTS.md § How we work.

- **Session log 1711 described a state that never merged.** Its "left in
  place" paragraph said `Cursor::for_history_seq` and two comments
  (`conformance_query.rs`, mock `blocks.ts`) were deferred to a follow-up
  sweep; the PR as merged deleted the function and rewrote both comments.
  Merged logs are immutable, so the correction lives here: nothing from
  that paragraph is outstanding.
- **`history.rs` duplicated its cursor binding.** The 15-line
  `(cursor_flag, created_at, seq, device_id)` match and the
  `Cursor::for_history_full` closure were verbatim in `list_block_history`
  and twice in `list_page_history`. Both are now one private helper each
  (`history_cursor_binds`, `history_cursor`); the refusal message is the
  shared `cursor missing created_at for history query`, since no test or
  caller pinned the per-query wording.
- **Mock `blocks.ts` comment said "both queries".** Three queries refuse a
  cursor without the `deleted_at` slot since #4980; the comment now names
  all three and the shared message.

## Verified

`SQLX_OFFLINE=true cargo check -p agaric-store --all-targets` clean;
`cargo nextest run --workspace -E 'test(history)'` 102 passed. Falsified
against a copy: with `history_cursor_binds` returning the no-cursor
sentinel for a present cursor, `list_page_history_pagination_works` and
`list_page_history_all_returns_ops_from_all_pages` went red; restored,
`cmp` clean. The mock change is a comment; `oxfmt` ran on the file. The
pre-push verifier was skipped: the box was at 99 % disk after the sibling
PR's full-suite run, and CI runs the same gates on the PR.
