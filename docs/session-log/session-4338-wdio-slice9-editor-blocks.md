# Session 4338 — WebdriverIO shrink, slice 9: editor blocks part 1 on the bridge

Slice 9 of #6926. Seven editor-block Playwright specs join `REAL_BACKEND_SPECS`, and seven WebdriverIO specs are ported into them and deleted.

## What shipped

- **Promoted:** `block-keyboard-move`, `block-line-break`, `block-duplicate`, `block-paste-outline`, `editor-lifecycle`, `draft-autosave` and `checkbox-typing`. On the bridge they run 66 tests; on the mock, with hooks withheld, 67.
- **`block-keyboard-move` reads the stored order after every move.** It polls `list_blocks` for the page and each parent's children, instead of asserting `move_block`'s slot shape, which the mock accepted where Rust would not. The recorder now only pins one `move_block` per key and none for the no-op moves.
- **Deleted from `e2e-tauri/`:**
  - `block-edit-persist` was a duplicate.
  - Ported into the promoted files: `block-duplicate`, `block-duplicate-repeat`, `block-line-break-persist`, `block-persist-reload` and `draft-blur-persist` (as one journal-day test in `editor-lifecycle`), and `block-structure-roundtrip`.
- **One `@mock-only` tag:** editor-lifecycle's "mock resets on page reload". Its asserts were swapped so the negative check runs after the seed rows show. Before, it passed vacuously.

## Decisions and traps

- **No real backend divergence.** The bridge is about 40 ms per IPC call, and that exposed races the mock's same-tick answers hide:
  - **Test-only:** the row count was read before render, there were one-shot reads after a blur, and `get_block` on a split's provisional client id threw inside `expect.poll`. Playwright does not retry a callback that throws. `splitOffStatusLine` now waits until the split block exists, and the reads poll.
  - **Two app bugs, filed:**
    - #6952: a paste into an empty block, then Escape before `paste_blocks` answers, loses the first item.
    - #6953: a typed `#name` shows as text after a quick reopen, before the tag rewrite lands.

    Both fixes (#6955, #6958) merged while this PR was open, so the specs no longer wait past them. They leave at once, and pass 20 of 20 on the bridge at 6 workers.
- **Coverage judged and kept:**
  - `block-duplicate-repeat`'s Edit-as-Markdown text check: the repeat rule is pinned on the bridge, in Rust's duplicate test and in the markdown source tests.
  - Desktop Shift+Enter typing: the keymap is tested in vitest, and the toolbar's New line runs on the bridge through the same `setHardBreak`.

## What ran

- **Bridge and mock:**
  - All seven files: 3× on the bridge and 3× on the mock.
  - The reviewer's flake probes: about 200 more bridge runs at 4–8 workers. After the fixes, `block-line-break` ran 10× at 6 workers, 100/100.
- **Reds:** every new bridge test was shown red against a Rust mutation in `move_ops.rs`, `split_merge.rs`, `markdown.rs`, `tags.rs` or `crud.rs`, each in one restore-on-exit command. The reviewer reproduced the `move_ops.rs` red.
- **Gates:** `npm run typecheck`, `typecheck:e2e-tauri`, `npx vitest run e2e-tauri`, `node --test scripts/e2e-related.test.mjs`, oxlint and oxfmt.
