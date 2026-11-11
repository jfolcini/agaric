# Session 3818 — the mirror follows a file renamed or moved outside Agaric

#5363 slice 3, PR 1 of 2.

- **Before:** a file renamed outside Agaric was written back at its old path on the next tick, and the new file became a second page. A file moved into another space's folder did the same. A deleted file was written back too.
- **Matching (maintainer decision of 2026-11-11, recorded on #5363):** Decide 4's anchor-majority rule alone misses most files, because since #6277 A3 a block carries a `^ID` only when something addresses it. A new file is a vanished page's file renamed when its settled bytes equal one of that page's shadow texts, or when most of its anchors name that page's blocks. If several pages match, it is a new page. No fuzzy matching.
- **Hold:** a page whose file vanished is held for `MISSING_TICKS` ticks instead of being written again. That covers the new file's two-read settle. Until PR 2 an unclaimed file is then written again; PR 2 trashes the page instead, behind the empty-root pause.
- **Rename:** `ingest::rename` moves the page with `move_blocks_to_space_inner`, acknowledging nothing, then sets the new title with `edit_block_inner`, one undo step. If the rename is refused after the move succeeded, the move is undone. A refusal is listed against the new file until it changes.
- **Ordering:** `read_new_files` now runs before the pass. Obsidian writes a link and the note it names together; when the linking file was read first, `resolve_new_names` created an empty page of that name, and the note, or the renamed file, was then refused as a duplicate title. This also fixes the merged H3 (#6483).
- **Tests:** Rust tests in `ingest_tests.rs`, each shown red first and falsified by mutation (matcher, hold, hold expiry, undo of the move, state path). The spec `e2e-tauri/mirror-structure.e2e.ts` could not run here (no `tauri-driver`); its first run is CI's real-backend lane.
