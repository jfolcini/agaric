# Session 4313 — the mirror says what it read back, names deletes, and folds paths like the disk does

Third of three PRs for #6887 (items E–H), after #6909 (A, B) and #6941 (C, D).

**E. Silent read-back.** Only warnings raised a toast. `mirror:ingested` now carries `kind` (edited, created, renamed, trashed), and `useMirrorIngestEvents` raises one deduped toast, counted per page, for pages renamed, created or trashed from the folder. When any page was trashed it is a warning with *Open Trash* that stays until closed, because read-back happens while the user works in another app and sonner pauses its timer only for a hidden document. It deliberately has no Undo: one there would bypass each page's own undo stack and leave its Ctrl+Z pointing at reverted ops. MirrorSection refetches its status on each read-in. A tick that only holds or only writes sends nothing, so the card shows those on its next mount: #6964.

**F. The copy never named deletes.** `MirrorStatus.pending` is now path plus kind (edited, new, gone), which `read_back::pending` already worked out and threw away. The read-in question groups its files by what reading in does, and the confirm still sends exactly the paths shown. The copy says a deleted file moves its page to the Trash (`TOMBSTONE_RETENTION_DAYS`), and "while reading back was off" is gone from the copy and the backend refusal, since it was wrong for the mass-change hold and for a folder chosen again.

**G. Case and Unicode folding.** The layout folds names but the scan compared them raw, so on APFS or NTFS a case-only rename or an NFD name was a new file refused as a duplicate title. `paths::unowned` counts a scanned file as owned when it folds equal to an owned path that still opens a file and is not itself listed; both guards are what keep a case-sensitive disk from merging two files. It is used by `read_new_files` and `read_back::pending`. Only the comparison is tested: Linux is case-sensitive and a casefold mount is refused in the container.

**H.** `check_folder` uses `is_emptied`, so a `git init` folder or one holding `.DS_Store` can be chosen. The marker refusals and pauses say the way out; deleting the other device's marker is not one, so they say to choose an empty folder. One unreadable new file no longer stops the others.

Filed rather than built: #6963 (the attachment-copy record is shared across folders, so A→B→A can overwrite a copy edited in A; needs a per-folder record). Dropped: diverged pages re-render each tick (unmeasured; the retry is also how settling edits are read), and a file refused by the op cap leaves an empty page in the Trash (the documented trade on `ingest::create`).

Two builders worked in separate worktrees stacked on #6941's branch; the second's commit was cherry-picked and a conflict in `read_back::pending` resolved by hand, then the branch was rebased onto main once #6941 merged.

## What ran

- `cargo nextest run --workspace -E "test(/mirror/) | test(ts_bindings_up_to_date) | test(conformance)"` (323 passed), related Rust tests on the range (4124 passed), clippy, fmt, `cargo doc` with the hook's flags, `SQLX_OFFLINE=true cargo check`.
- `just check-fe` and the range's related vitest (27532 passed), `prek run --files` and the manual stage, `e2e/mirror-settings.spec.ts` and `e2e/settings.spec.ts` on the mock (21 passed).
- Every new test shown red first; falsified: the toast's counting and reset, the card's refetch, the pending kinds, the dialog's grouping, `unowned`'s three guards, the unreadable-file carry-on, `check_folder`'s hidden-entry rule.
- Not run: the changed `e2e-tauri/mirror-structure.e2e.ts` and `mirror-read-back.e2e.ts` (no WebKitWebDriver in the container); CI's lane is their first run.
