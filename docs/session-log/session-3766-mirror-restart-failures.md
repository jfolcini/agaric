# Session 3766 — the mirror forgets a new file's failure with its folder

The #6483 review's one user-visible note. `MirrorState::restart`, run when *Choose folder…* sets a new mirror folder, cleared the diverged and failed pages but not the new-file failures H3 added (`failed_files`). The old folder's refused new files then stayed listed in Settings until a tick reached `read_new_files`, and for as long as the new folder stayed paused. `restart` clears them too.

- Red first: `choosing_another_folder_forgets_the_old_folders_new_file_failures` failed at its assertion before the one-line fix.
- Ran: `cargo nextest run -p agaric --lib -E 'test(/mirror::/)'`, 68 passed; `cargo clippy --workspace --all-targets -- -D warnings`, clean.
- The review's other note, the per-tick folder scan's cost, is in the follow-up batch, as the coordinator asked.
