# Session 4078 — the Enter and merge bench times `split_block` and `merge_blocks`

A follow-up to #6709 (#6531), left over when it merged.

#6706 landed while #6709 was in CI. It added `bench_enter_split_and_merge` to `interactive_slo`, timing a split as `create_block` then `edit_block` and a merge as `edit_block` then `delete_block`, "as the block editor sends them". #6709 made the editor send one command for each, so on `main` the bench timed a sequence nothing sends and its comment was false.

The probe now calls `split_block_inner` and `merge_blocks_inner`. Its assertions are unchanged and say the same thing about the commands: one create, two edits and one delete per pair, the block ending with the joined text, the page's child count back where it began, and no SQL-only fallback. The assertion that the delete tombstoned one block is gone with the response field it read; the child count covers it. It stays measurement only.

## Traps

- **A PR can merge between a check and a push.** #6709 merged at the head it was opened with, twenty minutes after it opened, while a merge of `main` and this change were being checked locally. The push was refused with "cannot lock ref": the branch was gone. The branch was restarted from `main` and the one file carried over; the edit made to session 4068's log in that window was dropped, because that log had merged.
- **`bench` is not a commit type** the Conventional Commit hook accepts; this is `test(bench)`.

## What ran

`cargo clippy --workspace --all-targets -- -D warnings` and `SQLX_OFFLINE=true cargo check --workspace --all-targets` on this tree. Neither runs a bench, and `src-tauri/benches/AGENTS.md` says not to build the release bench graph locally: `bench-slo` was dispatched on the branch, and its result is on the PR.
