# Session 4044 — The mirror's change scan compares with a stat taken before the read

Continues `claude/mirror-read-back-race` from the overnight handover (#6667), for the flakes in `e2e-tauri/mirror-inbound.e2e.ts` and `mirror-read-back.e2e.ts` (#5363).

## The race

`Mirror::write_page` kept the page file's stat for `changed_files` by calling `file_stat` after `try_write_page` returned: after the file was read, and on a write after the rename and the state file's save. A save from another editor landing between that read or rename and that stat had its own stat kept as the one seen. The scan then found the file unchanged, the page was neither diverged nor failed, and nothing read the save until something else made the page dirty: an edit of it in Agaric, a sync naming it, a restart or the hourly pass. Both specs save the file as soon as it holds the text they typed, which is at the rename.

`get_mirror_status`'s `pending` list reads the files themselves, not the scan's stats. That is why the read-back spec saw the file listed and still timed out on "never read in".

## The fix

- `write_page` takes the stat before the file is read.
- A write keeps the stat of what it wrote: `store::write_atomic` returns the temporary file's metadata, read by path before the rename, and `Mirror::write_file` keeps it.

Taking the stat before the read in every case was the smaller change. It was not taken because each write would then make the page dirty for one more pass, and a page whose render did not splice to itself would be written every tick.

## Tests

Three in `ingest_tests.rs`, driven by two test-only hooks on `Mirror` (`Races`), each shown red by its own mutation with the other two green:

- `a_save_landing_right_after_a_write_is_read_in`: red on the unfixed code and when a write stats the file after itself (`["two"]`, not `["outside"]`).
- `a_save_landing_right_after_an_unchanged_file_is_read_is_read_in`: red when the stat is taken after the read (`["one"]`).
- `a_write_leaves_its_file_unchanged_to_the_next_tick`: red when a write keeps no stat (the page is listed as changed).

## Left out

- **The read-to-rename window.** `try_write_page` and `read_edit` read the file, then rename their text over it without looking again; a save landing in between is written over. The inherited commit had two tests for it, both red on `main`, and a doc sentence naming a `store::write_atomic_over` that was never written. They are removed: this PR is the stat race. A check before the rename would narrow that window and cannot close it.
- **`mirror_convergence::edits_from_both_sides_…`** hitting nextest's 60 s limit is not this race: its steps run one after another, so no save lands mid-tick. It ran 18 s alone on an idle 4-core container: 64 cases, each with a new database and up to 42 ticks that sync every file they write.

## What ran

- `cargo nextest run --workspace`, in two halves: 4000 and 3995 passed.
- `cargo nextest run --workspace -E 'test(/mirror/)'` at the final tree: 169 passed.
- `SQLX_OFFLINE=true cargo check --workspace --all-targets` and `cargo clippy --workspace --all-targets -- -D warnings`: clean.
- The real-backend specs were not run here: the container lacks `tauri-driver` and `webkit2gtk-driver`. The PR's `e2e-tauri-gate` is their run.
