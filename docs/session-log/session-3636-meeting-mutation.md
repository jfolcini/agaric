# Session 3636 — mutation testing for the meeting code

The ninth PR of #5364 slice 2, tests only. It mutation-tests the code slice 2 added (#6401 to #6420) and triages every survivor.

## Frontend: enrolled

`meeting-dialog` (`MeetingDialog.tsx`) and `meeting-link` (`meeting-link.ts`) join `stryker.modules.mjs`, each scoped to its own test file, with `setup: true`.

- `meeting-dialog` went from 64.3% to 80.7% with nine new tests: a page title that only holds a day, the default date read after the page arrives, the remembered template among several and "no template" remembered, the title trimmed, written text not sent once the summary is a file, whitespace as no summary, the saving state (one send, no Escape), Escape closing, the toast's title, and Undo's reload and its failure.
- What still survives is equivalent or covered elsewhere:
  - the title trim, which the backend does too;
  - writing `'none'` for no template, which matches no template id;
  - `invalidateDerivedCaches`, which the mock e2e spec reds without (#6411);
  - log, i18n and label strings; the optional chaining on `files`; `preventDefault`; the null-space guard behind a disabled button; the effect's stale-response guard.
  - A gap left open: `summary_file` sent in text mode, and the text arm of the toggle guard, both reachable only by picking a file and switching back to text.
- `meeting-link` is at 84.6%. The two survivors are the log message's strings.

## Rust: a one-off run, not enrolled

`src-tauri/.cargo/mutants.toml` keeps the weekly lane to the invariant core, and `check-mutants-scope.mjs` guards it, so the meeting code was mutated once here instead.

- The run: `cargo mutants --workspace --no-config --file src/commands/meeting_attachments.rs --file src/mcp/tools_rw.rs --file src/mcp/summarise.rs --re '…meeting…'` (56 mutants), with `--test-tool cargo -- --lib --test commands meeting`.
- Deviations, each for this container:
  - `--test-tool cargo`, not the config's `nextest`, which cannot be installed here. A mutant only a test outside the `meeting` filter kills would show as missed, so each miss was checked against the tests outside it.
  - `--no-config`, because the config's `examine_globs` are added to `--file`.
  - A symlink from `/tmp/conformance` to the checkout's `conformance/`. Tests read `../conformance/*.vectors.json`, and cargo-mutants copies only `src-tauri/`.
- The first attempt filled the disk mid-run, which turned 50 mutants "unviable". That run was thrown away. Cleaning the worktree's target and building without debuginfo fixed it.
- Result: 34 caught, 19 unviable (every one a `Default::default()` the type does not implement), 3 missed:
  - `ends_with_ignore_case`, `-` to `/` in the char-boundary guard: a real gap. `role_filename("aéxy", Transcript)` would slice from byte 2, inside `é`, and panic. Pinned by `role_filename_keeps_a_name_whose_tail_splits_a_character_5364`.
  - `meeting_target`, `||` to `&&`: a real gap. Only `title` with a target was tried, so `date` or `template` alone with `page` or `block_id` was not refused. Pinned by `add_meeting_refuses_a_date_or_a_template_alone_with_a_target_5364`.
  - `cleanup_written` emptied: left untested. It runs only when a disk write fails between two files' writes. Every validation refusal comes before the first write, and there is no seam to make the second write fail.
- Both new tests were shown red against their mutant and green without it.
