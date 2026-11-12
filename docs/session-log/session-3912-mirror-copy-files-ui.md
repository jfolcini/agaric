# Session 3912 — Copying attachments into the Markdown mirror (the switch)

#5363 slice 4, setting 3, PR B of two: the Settings switch for #6589's backend, and the review notes left on #6589.

## Decisions (coordinator)

- **An edited copy is the user's**, whether copying is on or off: never written over or removed, linked by its page while copying is on, and listed under `diverged`. Recorded on #5363 as a setting 3 decision.
- **No mock-lane Playwright spec.** The feature is bytes on disk, so its one end-to-end spec is in `e2e-tauri/`, and it drives the switch through the UI.

## The change

- **The switch:** *Copy attachments into the folder* in Settings › Data (`MirrorSection`), calling `set_mirror_copy_files`. A refusal is shown and logged, and the switch stays as it was.
- **Edited copies kept:** `Copies::ensure` writes a copy only when it is missing or unrecorded. `Copies::remove_except` never removes a changed copy, and returns it whether or not it is still wanted, so it is listed while copying is on too.
- **Links from what was placed:** `Mirror::placed` copies a page's attachments and builds its `Links` from those copies alone. The render's localization and the ingest's write-back both use it, as does a new file's write-back with the ids its copy links name (`assets::copy_linked`). `Mirror::links` and `Copies::in_space` are gone, and with them the old copy a renamed attachment left recorded until the sweep.
- **Status:** `failed_copies` is chained before the `on` filter, as `kept_copies` is. No test covers it: clearing the folder goes through `MirrorState::restart`, which clears both, so no state reaches the difference.
- **React keys:** the diverged and failed lists key rows by path. Files no page owns, copies among them, carry an empty `page_id`, so two of them shared a key.
- **The vectors vitest** asserts all 25 rows (`toHaveLength(25)`).
- **Docs:** `docs/features/import-export.md`, `docs/architecture/data-and-events.md` (*Copies*) and `docs/FEATURE-MAP.md`.

## Tests

- **Rust (`src/mirror/assets_tests.rs`):**
  - `an_edited_copy_is_kept_and_listed_not_rendered_over_while_copying_is_on`, which replaces the "changed copy" half of the former `a_missing_or_changed_copy_is_written_again`;
  - `a_page_saved_in_the_folder_after_an_attachment_rename_links_the_new_copy`.
- **Component (`MirrorSection.test.tsx`):**
  - the switch on and off, re-queried from the stub;
  - a refused switch;
  - two rows no page owns, rendered without a duplicate-key warning.
- **Real backend (`e2e-tauri/mirror-copy-files.e2e.ts`):** the switch turned on in Settings, the image's copy on disk with the image's bytes, and the page linking it. After the copy is deleted and the app killed, the next start copies it again and the switch is still on.
- **Falsified:** each test failed on its predicted assertion with a planted defect, in one script that restored the files on exit:
  - links taken from every recorded copy failed the rename test;
  - an edited copy rewritten, and a kept copy not listed, each failed the edited-copy test;
  - the switch not calling the command, and the refusal not shown, failed the component tests;
  - keys back on `page_id` failed the rows test, once the warning matcher took React's two arguments. It first survived with a three-argument matcher.
  - The switch not calling the command also failed the real-backend spec (E2E_RED).
- **Results:**
  - `cargo nextest run -p agaric -E 'test(/mirror/)'`: 111 passed;
  - `MirrorSection.test.tsx`: 18 passed;
  - `e2e-tauri/mirror-copy-files.e2e.ts`: passed;
  - CLIPPY_RESULT.
