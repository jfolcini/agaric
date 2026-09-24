# Session 1818 — review notes from #5140's sweep

One PR for the non-blocking notes the reviews of #5151, #5153, #5154, #5156, #5157, #5158, #5159 and #5161 left on approved, green PRs. It is #5162, the PR session 1814 promised without a number.

**Fixed where a user could hit it.**
- **At 390 px the page header clipped its kebab** (Edit as Markdown, Export, Delete page) off-screen (1814). The title row now wraps, the PageBrowserHeader pattern; the actions drop to their own line on phones. A Playwright case at 390 px opens Edit as Markdown through it.
- **Focus fell to `body`** after source mode closed and after Cancel in `ConfirmDialog` (1814). Closing source mode focuses the kebab; the dialog returns focus to what had it when it opened. When the opener was a menu row that no longer exists, focus still falls to `body`, as Radix's default does.
- **Pasting an outline over a selection** kept the selection and added the blocks. It now replaces the selection through the default paste, as TaskPaste already did.
- **In a stale Merge save, a block one side only moved lost silently to the other side's delete.** A parent change now counts as an edit in the delete rule, both ways: the block comes back as a new one with a warning, as Overwrite would keep it. A reorder under the same parent still gives way.

**Cleaned up.**
- **Page reads for source, clipboard, duplicate and apply** skip the four Export-only reads (`PageRead`). Scoping the read to the copied subtree is not done: unmeasured, and the ordinal is page-wide.
- **A copied block** renders once and parses once where it rendered up to four times.
- **Smaller changes:**
  - `apply_page_source_inner` takes `SourceSaveFlags` instead of two positional bools.
  - `duplicateBlock` resolves `void`.
  - The mock's caret words follow `BlockId::from_string`: a Crockford ULID or an id the mock holds.
  - #5161's fence re-scan in the anchor heal is gone. It guarded only a bare ULID inside a fence; inline code spans are still skipped.
  - Dead code went (a flush the copy chord could never reach, an unreachable `unwrap_or`, a dead `?.`), and comments that claimed wrong things were corrected.
- **Test helpers:** the test helpers duplicated between `block_cmd_tests` and `undo_redo_tests` now live in the shared `commands::tests::common`, which `tests/commands` already used. `src-tauri/tests/AGENTS.md` still says helpers are module-local and duplication is intentional; that line needs the maintainer.

**Worth knowing.**
- Since #5158 an append under a parent lands before any trailing tombstone, where a slotless append used to land after them. So delete the last child X, append D, undo the delete: X comes back after D. The comment in `block_ops.rs` now says so.
- **Not fixed: a draft typed without blurring** that the blur would classify — an inline `key:: value`, a multi-block split, or a leading task marker — is not seen by Duplicate, copy or Edit as Markdown, which use the stored text. The blur's commit can only run as the editor closes; running it while the editor stays open would put the editor and the store out of step, and a split would duplicate blocks on the next blur. #5160's decision on what a stored line break means (D2) changes this path, so it waits for that phase.

**Verified.**
- Every new or changed test was red first, and every mutation ran against a copy that was restored and `cmp`-checked.
- An independent reviewer merged the item-25 fixture steps with #5161's, checked the step order against the page state each op leaves, and traced every `PageRead` caller. It found no defect.
- `cargo nextest run --workspace`: 6509 passed. Clippy and fmt are clean, and so is `npm run typecheck`.
- vitest: 4052 passed across the changed areas and the mock. Playwright's `page-source-edit` and `journal-add-block-while-editing` passed 7 of 7.
