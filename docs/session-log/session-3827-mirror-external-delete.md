# Session 3827 — the mirror trashes a page whose file was deleted, behind the empty-folder pause

#5363 slice 3, PR 2 of 2, with #6511's three review notes.

- **External delete.** A page whose file stays missing through the hold, claimed by no rename, goes to the Trash (`ingest::trash`, `delete_block_inner`). The op refs ride a `mirror:ingested` event, so one undo restores it, and a restore writes the file again. It happens only while reading back is on.
- **In front of every delete:**
  - the marker;
  - a folder that holds more than its marker once pages were written to it (`Mirror::emptied`; the same check pauses the whole tick, so an emptied folder is neither read nor written);
  - the page's space folder. Without it the file is written again, so an `rm -r` of one space or an unmounted link trashes nothing.

  A page whose rename was refused stays held and is never trashed.
- **The premise check found a data-loss path:** the state files survived a folder change, and their paths are relative to the folder they were written in. With deletes in, picking a new empty folder would have trashed every page. Each folder now keeps its own states (`StateDir::bind`, set aside under `mirror/folders/<hash>`). Moving away and back finds the old folder's files as left, and a folder with none starts as new.
- **#6511 review notes:**
  1. The confirm sends the files the dialog showed, and the backend refuses while any pending file is not among them. That is race-free, and needs no partial read-in. Of the coordinator's two options, it is the one that cannot read in an unshown file.
  2. While reading back is off, a vanished file is held and listed, not written again. Turning reading back on then reads it in as the rename it was, not as a twin page, or as the delete it was.
  3. The mock's `set_mirror_folder` keeps `read_back` while mirroring, as the backend does, and the card sends `readBackChoice` plainly.
- **Traps:**
  - A background mutation loop and a commit hook both touch the working tree. The hook stashes and restores unstaged files, so the loop's results from that window were re-run.
  - A merge of `main` brought new callers of changed signatures (a bench, a sync spec, a convergence proptest) that only `cargo check --workspace --all-targets` and the e2e typecheck see.
- **Tests:** Rust tests in `ingest_tests.rs`, each red first, with every guard falsified by a mutation. Two real-backend specs in `mirror-structure.e2e.ts`: an external delete restored from Trash, and an unmounted folder trashing nothing. Neither could run here (no `tauri-driver`); this PR's gate is their first run. The Playwright mock spec covers note 3.
