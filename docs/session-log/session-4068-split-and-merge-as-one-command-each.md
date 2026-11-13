# Session 4068 — Enter and merge as one backend command each (`split_block`, `merge_blocks`)

#6531, after the maintainer's go-ahead of 2026-11-13: a design note on the issue first, then the build it left with no open decision.

## What shipped

- **`split_block` and `merge_blocks`** (`src-tauri/src/commands/blocks/split_merge.rs`). Each opens one `CommandTx`, arms the engine rollback and runs the helpers the single commands run: a split is `create_block_in_tx` then `edit_block_in_tx`; a merge is `edit_block_in_tx`, `move_blocks_batch_in_tx` over the merged-away block's live children, then `delete_block_in_tx`, with `dispatch_deletes` after the commit. No new op type, table, store, queue or sync message.
- **The backend decides placement.** A split reads the block's parent and slot in the transaction; a merge picks the children and appends them to the target. The caller's snapshot of the tree no longer decides either, so a child the store has not loaded is moved, not cascaded into the trash.
- **Both pass `base_text` to `edit_block_in_tx`**, so a split or a merge from an editor that has not seen a peer's edit is rebased as `edit_block` is. A split used to send none.
- **Store actions `splitOff` and `mergeInto`**, optimistic and rolled back by reference. The map of blocks whose create is in flight became `heldBlocks`: a split holds its two blocks and a merge its target, so a later edit of them, and a `load()`, wait for the command. That closes the reorder #6559's status comment left open (text typed at the join and saved before the merge answered).
- **`handleEnterSave`'s caret split and both merge handlers** call them. Deleted: `mergeBlocksAndHandle` with its `revertEdit`, the split's delete-the-sibling rollback, and the hook's `edit` parameter.
- Mock handlers in `src/lib/tauri-mock/handlers/split-merge.ts`, wrapped in `allOrNothing`, pinned by backend-authored `split_block.json` and `merge_blocks.json`.

## Decisions

- **Request structs, not positional arguments.** The design note listed positional arguments; `split_block_inner` would have had eight, one over clippy's limit, and `src-tauri/src/commands/AGENTS.md` says to collapse into a request struct. Both commands take one, for symmetry and because two adjacent block ids in `merge_blocks` are easy to transpose.
- **Not migrated:** Enter at the end of a block (its flush and its create are independent), the several-paragraph split at blur (`splitBlock`, N creates and an edit), Backspace on an empty block with children (a move, then a delete), the `listStyle` write after Enter in a list, and page mode, whose save is a diff of the document and has no split or merge to send.
- **Sync convergence is unchanged.** Two devices splitting or merging the same block still duplicate the moved text; doing better needs an op the engine understands as one operation.

## Traps

- **A ULID is Crockford base32.** `01SPLITNEW…` reads like an id and is refused (`I`, `L`), by `create_block_in_tx` and not by `BlockId::from`.
- **`CONFORMANCE_UPDATE=1` rewrites every fixture.** After `oxfmt` four unrelated fixtures still differed, by key order only; they were restored from `HEAD`.
- **A mutation that makes the mock loop hangs its test and keeps the mutation on disk**, because the restoring `trap` runs only when the command exits. Removing the mock's "target is the block's own child" refusal moved a block under itself; the run was killed by hand and the file checked. Falsification runs now go under `timeout`.
- **A span field needs the PII allowlist.** `#[instrument(fields(into_id = …))]` passed clippy and failed `span_fields_stay_on_the_pii_allowlist` in the second nextest half. `block_id` is on the list and is the only field kept.
- **The pre-commit `tsc` hook checks the staged tree plus every untracked file**, and prek stashes unstaged changes while it runs. A commit of one slice fails on an untracked test of the next (it was moved aside for that commit), and a commit made while a subagent or a build works in the tree hands them a tree that changes under them. The backend and the mock are one commit for the first reason: the bindings alone fail `satisfies TypedHandlers`.
- **The mock-parity guard read a handler module only when `satisfies Pick<` was followed by a line break**, which oxfmt writes only when the key list does not fit one line. Its regex now accepts both.
- **Moving `edit`'s list-style clear into a helper changed what its `try` covered.** `contentShowsListMarker` had been inside it, and a test that mocks the Markdown parser relied on that: outside, the predicate threw and rolled the edit back. One existing test caught it; the predicate is inside the `try` again.
- **Undoing a split restores the text the block last stored.** Text typed and split before the idle commit was never stored whole, so one Ctrl+Z takes the typing with the split, as it did with two commands. The real-backend spec re-opens the page before splitting for that reason.

## Review

An independent read of the transaction and op sequence found no atomicity or ordering defect: both commands arm the rollback before the first engine write, `i64::MAX` as the batch move's slot is clamped to an append before any op carries it, and the split's `index + 1` counts live siblings as the create does. Taken from it: the fixture `split_merge_keep_moved_link.json`, which pins the op order #5272 needs by behaviour (only the op-type list did), four Rust tests that repeated fixture steps were deleted, and assertions that restated their setup were removed. Left: the mock's batch move refuses neither a move past the depth cap nor a target deeper inside the moved block, as before this change; a merge can reach both only near depth 20.

## What ran

On the tree with `main` merged in (eleven commits; one conflict, in `e2e/error-scenarios.spec.ts`, both sides kept): `cargo nextest run --workspace` in two halves (4032 and 4026 passed), `cargo clippy --workspace --all-targets -- -D warnings`, `SQLX_OFFLINE=true cargo check --workspace --all-targets`, `just gen-sqlx` and `just gen-bindings` with no diff, full vitest (1108 files, 26874 passed), `npm run typecheck`, `npm run typecheck:e2e-tauri`, `npm run lint`, `prek run --all-files` and the manual stage, and the seven Playwright specs closest to Enter and merge (50 passed).

Before the merge the whole Playwright lane ran locally on three workers: 1973 passed, 9 skipped, and the two `diagram-legibility.spec.ts` cases session 4057 names failed on this container's older Chromium. An earlier second nextest half failed once, on the span allowlist above.

The first run of the Rust gates after the merge filled the disk allowance: `target/debug/incremental` had grown past 10 GB. It was deleted and the gates re-run with `CARGO_INCREMENTAL=0`, as `docs/BUILD.md` says to; the `gen-sqlx` killed with that run left `.sqlx` entries deleted, restored with `git checkout`.

The real-backend lane did not run here (no `tauri-driver`): the new test in `e2e-tauri/block-structure-roundtrip.e2e.ts` has its first run on the PR.

Two subagents moved the tests that pinned the old call shape (vitest, Playwright), each showing its edits red by mutation; a third read the transaction and op sequence. The list of edited assertions is in the PR body.
