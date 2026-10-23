# Session 2889 — a restore is a page-level undo step of its own

#5691 lists one gap in page mode's page-level undo: a block brought back by an editor undo, a restore, recorded no op ref. So the earlier delete stayed on top of `UndoStore`, and a `Ctrl+Z` outside the document took back the delete instead of the restore.

**Change:**
- `restore_block`'s Tauri wrapper returns `WithOps<RestoreResponse>` through `capture_op_refs`, as create, edit and delete do. One `restore_block` op covers the whole cohort, so the response carries one ref, and undoing it re-deletes the cohort.
- Page mode's save returns that ref along with a `restored` flag.
- `PageModeEditor` pushes a save that restored with `merge: false`. Both saves flush at once when the caret leaves the block, so without that the restore merged into the delete's entry, and undoing the pair changed nothing.
- The mock's `restore_block` returns the ref too.
- A new conformance fixture, `restore_block_undo.json`, has the backend author the undo of a restore.

**"After leaving the page" is not where this shows.** Leaving a page clears its stack: `PageEditor`'s cleanup calls `clearPage`, and the tab bar keeps no page mounted in the background. Coming back therefore falls through to the positional `undo_page_group`. The case that reads these refs is leaving page *mode*: switch to Blocks, blur, then `Ctrl+Z`. The new e2e does exactly that. A restore from the Trash view needs nothing: the page's stack is cleared while the Trash is open.

**Shown red:**
- **Rust** `restore_block_op_refs_undo_the_restore_5691`: with the store's capture disabled, it fails at "one op ref, got []".
- **vitest:** with `merge: true`, the stack has 1 entry, not 2. Dropping the refs fails the same way.
- **e2e** `page-mode.spec.ts`: with `merge: true`, block 31 stays live beside "block 30block 31", and that fails 3 of 3 runs.

**Suites:**
- Rust: clippy, and nextest over restore, undo, conformance, bindings and op refs (482 passed).
- vitest over page mode, the mock, the stores and `src/__tests__`; typecheck; lint.
- The builder ran the whole Playwright lane and the whole real-backend lane (93/93).
- Seven Playwright tests fail in this container, and fail the same way on main: diagram legibility, PDF annotation, the pdfjs smoke test and a line-break case.
