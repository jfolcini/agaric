# Session 4282 — the mirror no longer rolls its folder back after a restore, and asks before reading a returning folder in

First of three PRs for #6887, the data-loss paths two reviews found in the Markdown mirror. This one is items A and B.

**A. A restored or new vault rolled the folder back.** The mirror's per-page states live in the app data dir, outside `notes.db`, so after a backup restore (or a new vault given the old folder) its first full pass removed every file of a page the vault lacked and wrote older text over files edited since. After each completed pass the mirror now saves a `head` file in the folder's state dir: this device's durable op head (`next_seq_for_device - 1`, which survives compaction, unlike `MAX(seq)`) and the hash of the op there. A vault behind that head, or holding another op at it, pauses the mirror before anything is read or written. The hash check matters: without it a restored vault that minted a few ops past the gap lifted the pause. The pause is sticky (`older` in the head file) so compaction pruning that op cannot lift it either. The way out is choosing the folder again, which starts fresh: states and head forgotten, and attachment copies whose attachment the vault lacks unrecorded so the sweep never removes them (dropping the whole record would overwrite a copy the user changed). A fresh start that fails part way keeps its flag and runs again; clearing it first left no head and the old states, the rollback again.

**B. Choosing a folder again read in changes made meanwhile unasked.** The settings switch showed a local `true` while the mirror was off, and `set_mirror_folder` never ran the pending gate. Now the switch shows the stored setting, and any folder choice that lands on a folder with pending changes (turning on, switching folders while on, or a fresh start) stores reading back off; the card opens the existing confirm at once when the user had it on. For a fresh start `pending` ignores the states, since the tick forgets them only on its next run.

Traps: the `tests.rs` fixture has no `Ingest`, so read-back cases there are invisible; the fresh-start read-in was found only with one attached. A new vault needs the folder picked twice (the first pick shows the pause). The in-app restore (#6744) carries the high-water mark forward and keeps its own guard; this one is for a restore done outside the app.

## What ran

- `cargo nextest run --workspace -E "test(/mirror/) | test(ts_bindings_up_to_date)"` (193 passed) and the rdeps of `agaric` (4064 passed); clippy and fmt clean.
- `just check-fe`; vitest for MirrorSection and the tauri-mock (1856 passed); the 40 `@settings` Playwright specs on the mock (234 passed); `prek run --files` and the manual stage on the changed files.
- Every new test shown red first, and each guard falsified (older-vault guard, hash arm, `older` flag, copies, the B gate, the fresh-start gate, the auto-ask).
- Not run: the new case in `e2e-tauri/mirror-read-back.e2e.ts` (no WebKitWebDriver in the container); CI's lane is its first run.
