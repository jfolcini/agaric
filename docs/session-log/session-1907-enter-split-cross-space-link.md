# Session 1907 — Enter-split keeps a cross-space link (#5272)

This is the next batch of the session that logged 1890 and 1902. #5326
(#5287) merged after `validate-all` and `dco` passed; its review had no
notes. `CodeQL / Analyze rust` failed on it while uploading results during
a GitHub outage; the PR changed no Rust, and the job was re-run once.

## #5272

- **The bug.** #5300 fixed every variant of "after Move to space, blocks
  that link across the new space boundary can no longer be saved" except
  Enter-split. Pressing Enter before a `[[link]]` whose target lives in
  another space failed: the split was rolled back and a toast appeared. No
  text was lost.
- **The cause.** The backend accepts such a link when a live block of the
  same page already holds it (`page_holds_token` in
  `cross_space_validation.rs`; `create_block_in_tx` checks against the
  parent's page). Both split paths saved the shortened original first, so
  when the new block was created, no block on the page held the link any
  more, and the create was refused.
  - `handleEnterSave` (`use-block-action-orchestration.ts`), the caret
    split, is the path the issue reproduces.
  - `splitBlock` (`page-blocks-reducers.ts`) is the multi-block flush and
    paste split.
- **The fix.** Both paths now create the after-text block or blocks first,
  then shorten the original. The page-level rule accepts that order with
  no backend change.
- **Failure paths.**
  - A create that fails writes nothing to the original. `splitBlock`
    deletes any blocks it created earlier in the chain.
  - A failed edit of the original deletes the blocks just created.
  - The caret split then re-mounts the full text. It still does so when the
    compensating delete itself throws; that is logged.
  - In every case the user keeps the full unsplit text and no duplicate is
    left behind. Before, a failure on block 3 of a four-line paste left the
    original shortened and blocks 1–2 in place.
- **Undo.** A successful split is still one undo step. The merged entry
  now carries the edit's coalesce key. So typing in the source right after
  a split, with nothing in between, joins the split's entry: one Ctrl+Z
  reverts both, and no text is lost. The more common flow got better: type,
  pause, then Enter used to fold the typing into the split's entry, and now
  stays separate. Changing undo's adopt-the-newest-key rule would change
  the #2600 session model for every window merge, so the trade stays.
- **Not done.** The tauri mock does not model the cross-space rule, so the
  tests pin the order against mock state. Modelling it would take a shared
  token regex in `create_block` and `edit_block`, plus a backend-authored
  conformance fixture.

## Verified

- **Falsification**, each on a backed-up copy, restored and checked with
  `cmp`:
  - Moving the edit back before the creates in `splitBlock` reddened 7
    tests (the ordering, the #730 and #2913 rollbacks, and the
    compensating deletes).
  - Dropping the try/catch around the compensating delete reddened the
    remove-throws test.
- **Full vitest (four shards):** 867 files, 20,438 tests passed (51
  skipped, 1 expected fail). `npm run typecheck` exits 0.
- **On the latest `main`**, after three merged PRs touched the block tree:
  `npm run typecheck` exits 0, and the store, block-tree and editor tests
  pass (189 files, 6,513 tests).
- **Not run:** the Enter-split Playwright specs
  (`block-keyboard-fundamentals`, `draft-autosave`). They poll the last
  `edit_block` and `create_block` calls independently, so the new order
  does not change what they check.
