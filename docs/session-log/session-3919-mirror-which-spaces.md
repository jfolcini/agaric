# Session 3919 — which spaces the Markdown mirror writes, and #6570's review notes

#5363 slice 4, setting 2, with the four non-blocking notes from #6570's reviews.

- **Setting 2.** Every space is mirrored by default, a new one included; Settings › Data has a switch per space (`set_mirror_space`, `app_settings` key `mirror.unmirrored_spaces`, a JSON array). A space turned off is neither written nor read: its unchanged files are removed, its changed ones kept and listed, new files in its folder left alone, and a file moved into it is left where it is with its page held, neither moved nor trashed. Its files are never pending for reading back.
- **Rebuilt on main after #6589** (attachment copies, `mirror.copy_files`): both settings sit side by side in `Settings`, `MirrorStatus` and the mock; the settings query reads four keys.
- **#6570 review notes:**
  1. The pause on a folder holding nothing but its marker had no way out. Choosing that folder again now drops its states (`MirrorState::start_fresh`), so every page is written there as new and none is trashed; chosen again while it holds its files, it keeps them.
  2. `forget_folder` cleared nine maps by hand. They are one struct, `Seen`, reset as one.
  3. and 4. `StateDir::bind` moved the bound folder's states aside and the new folder's in, then recorded the folder, so a crash between the steps could lose a folder's states. Each folder's states now live in their own directory, `mirror/folders/<key>`, and binding moves nothing. The earlier layout (`mirror/state`, named by `mirror/folder`) is adopted by its folder in steps a crash repeats. This replaces the narrower crash fix in this PR's third commit.
  - The call-shape assertion in `MirrorSection.test.tsx` was already gone: that test waits on the stored status.
- **Tests:** each new Rust test was shown red by a mutation of the code it covers (the way out off, the way out on for any folder, one directory for every folder, the legacy owner ignored). A real-backend spec for the space switches (`mirror-spaces.e2e.ts`) and a mock spec for the card (`e2e/mirror-settings.spec.ts`).
- **Trap:** the mutation runs rebuild the crate each time and filled the disk once; each run now drops `target/debug/incremental` after it.
