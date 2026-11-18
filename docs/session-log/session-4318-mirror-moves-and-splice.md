# Session 4318 — a file moved out of the space folders keeps its page, a mass change asks first, and a moved page keeps its file's lines

Second of three PRs for #6887 (items C and D).

**C. A file moved out of every space folder trashed its page.** `read_new_files` skipped root-level files and folders that are no space's before rename matching ran, so the page counted missing and went to the Trash after `MISSING_TICKS`. Rename matching now runs first: a moved file anywhere below the root is held like a move into an unmirrored space (`refuse_rename`, listed with how to get out), and an unmatched outside `.md` is listed as not read. Outside files are matched every tick without the two-tick settle, and only while some page is missing its file: caching "unmatched" would miss a file seen before its page's file was noticed gone.

**The mass-change guard.** Nothing capped how many pages one tick could trash or rewrite. More than `read_back::MASS_CHANGE` files of one space folder changed or deleted outside Agaric in one tick now hold reading back (`MirrorState::hold_mass_change`, one call per tick with every file the tick may act on; #6540 routes its subfolder delete through it). The hold lives in memory, so the task still takes no write connection; it is recomputed each tick, lifts when the files are put back, is forgotten on Turn off, and asks again after a restart. The status reports reading back off, the files as pending, and the space folder's line with the reason; confirming through `set_mirror_read_back` lets them through. A reviewer made edits exempt, since an Obsidian rename rewrites the link in every linking file; the maintainer chose instead to count edits and deletes and add *Ask before reading in many changes* (on by default) to turn the question off, with a button to it on the hold's line and in its question. The shared `ConfirmDialog` gained `returnFocusRef` so focus lands on that switch after the question closes.

**D. A page renamed in Agaric lost its file's form** because the splice ran only when the path was unchanged; it now splices against the newest shadow wherever it was, and front matter compares regardless of key order. Built and tested by the #6540 session (its commit kept with its authorship) and re-falsified here.

Also folded in: #6909's reviewer note (`is_behind` is a flag, not a comparison with the pause's text).

Trap: the maintainer merges with Rebase and merge, so the branch was rebuilt linear on main (the D commit cherry-picked, the rest one commit whose tree was checked equal to the reviewed tree merged with main).

## What ran

- `cargo nextest run --workspace -E "test(/mirror/) | test(ts_bindings_up_to_date) | test(conformance)"` (318 passed), `just test-be-related` on the range (4114 passed before the setting), clippy, fmt, `sqlx prepare --check`.
- `just check-fe` with vitest (27443 passed), the i18n catalog and translator-context tests, `prek run --files` and the manual stage, `e2e/mirror-settings.spec.ts` on the mock.
- Every new test shown red first; falsified: the outside-file hold and listing, the guard's boundary, per-folder count and confirm pruning, the hold cleared on Turn off, the setting (ignored, default flipped, hold not cleared), both D fixes, the `behind` flag, the buttons and focus.
- Not run: the new case in `e2e-tauri/mirror-structure.e2e.ts` (no WebKitWebDriver in the container); CI's lane is its first run.
