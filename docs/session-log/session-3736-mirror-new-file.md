# Session 3736 — #6277 H3: a new mirrored file becomes a page

#5363 slice 3a: a new `.md` file in a space's folder is read onto a new page of that space. H2 (#6474) merged first in the same session; its log is 3693.

- **Finding new files.**
  - Each tick lists the folders below the mirror's. A folder is re-read only when its modification time changed, and every folder again on a full pass.
  - A `.md` file that is no page's file, and not a path the layout is about to write, is new. Hidden entries (the marker, temporary files) are skipped.
- **Reading one in** (`ingest::create`).
  - The file is read once two ticks read the same bytes, with H2's text checks.
  - `create_page_in_space_inner` makes the page, titled `folder_path_to_namespace_title` of the path below the space folder.
  - `apply_page_source_inner` then saves the file over the page's empty buffer, so every line is a new block, read in the dialect the mirror writes.
  - Both commands' op refs go in one `mirror:ingested` event, so one undo removes the page.
- **A title the space already holds.** `create_page_in_space_inner` resolves an existing title to that page and appends nothing, so the ingest refuses when the create returned no op refs, and never writes over that page.
- **A save the op cap refuses** deletes the page it made, so only a Trash entry remains. The file stays listed as failed until it changes; a failure drops off the list once the file is gone.
- **The written file is the page's file at its path.** If the layout puts the title elsewhere (sanitised, or a collision), a later pass moves it, as a rename does.
- **Not in this slice:** external delete, external rename or move, and the pause guards (the rest of 3a and 3b).
- **Ran:**
  - `cargo nextest run -p agaric --lib -E 'test(/mirror::/)'`: 67 passed.
  - 10 breaks of the new code, one at a time, each red. The re-read before the write-back first survived and got its test.
  - The e2e-tauri spec `mirror-new-file.e2e.ts` can't run here; it was shown red on main in scratch PR #6479.
- **Disk.** The red runs filled the session's disk twice. Stale `.dwo` files and old `target/debug/incremental` caches freed it.
