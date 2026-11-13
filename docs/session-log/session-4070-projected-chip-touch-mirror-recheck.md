# Session 4070 — Projected rows' tag chips take the touch area; a mirror write re-checks its file before the rename

Two items the maintainer decided on 2026-11-13, in one PR because CI was the bottleneck that day (#6667): the variant #6678 left out of #6532, and the window #6686 left in #5363.

## #6532: tag chips on projected repeat occurrences

`ProjectedEntryRow`'s text span was `truncate`, whose `overflow: hidden` clipped the chips' 44 px area to the line. The span now clips sideways only (`overflow-x: clip` with `text-ellipsis whitespace-nowrap`): the text still ends in an ellipsis on one line, and the area reaches above and below it. The span carries `tag-chip-row`, the hook #6678 added.

The reviewer's note on #6678 held, and was worse than stated. On an agenda row whose text wraps, a chip's area lay over the chip on the next line, so a tap on the lower edge of a chip's own drawn box opened the other tag. CSS cannot tell a wrapped row from a single-line one, so the area is not limited to single-line rows; it now lies under the row's own text and chips. `.tag-chip-row` is a stacking context on a coarse pointer (`isolation: isolate`) and the chip's `::before` has `z-index: -1`, so a tap on another line's text or chip reaches that text or chip, and the area keeps only the space the row leaves empty.

Traps:

- `isolate` cannot be shown red in the mock lane. The agenda list is virtualised, and each row's `transform` already makes the row a stacking context. A projected row is not one, so the real-backend spec is what pins the line.
- The lane's webview reported a fine pointer in this container, although `useIsTouch.ts` records WebKitGTK reporting a coarse one. The spec depends on neither: `applyCoarsePointerRules` rewrites the stylesheets' `(pointer: coarse)` conditions. `useIsTouch` still answers as before; the row has no JS touch branch.
- In a 360 px window the page-source save's Undo toast lies over the foot of the page and took the probes below the chips. The spec closes it with `dismissToasts`, now exported from `helpers.ts`.
- Two vitest files found the row's text span by its `truncate` class; they now find it by its `title` attribute. No assertion changed.

Left as it is, and noted on #6532: on a phone the due-date chip's own area (#6606) reaches the bottom few pixels of the text line above it in a `BlockListItem` row, tag chips included. The new mock-lane test leaves those probes out and says so.

## #5363: the read-to-rename window

Every write of a page's file goes through `Mirror::write_file`, which now writes with `store::write_atomic_over`: once the temporary file is synced it stats the page's file again and compares with the stat `write_page` took before the read. When they differ nothing is renamed, the temporary file is removed, and the caller answers `Diverged`. The page stays dirty twice over: its file's stat differs from the one seen (`changed_files`), and a diverged page is retried each tick. The window is narrowed to the gap between that stat and the rename, not closed; a save that keeps the file's length within the timestamp's resolution is not seen either.

`read_edit` had the same shape at both of its writes: an empty page's blank file written back as the render, and the write-back after an ingest, which re-read the file first but then synced a temporary file before renaming. So had `read_new_file`'s write-back, which the #6686 log did not name. All three go through `write_file`; the three that answer for a page do it through `write_and_record`, which exists because the answer's three lines put `try_write_page` and `read_edit` one line over clippy's cap. `read_new_file` takes the stat itself before its re-read, because no pass has seen a new page's file yet, and still records the page's text when the write is skipped, as it did when its re-read differed. `vacate` reads a file and removes it at once, with no sync in between; it is unchanged.

`write_atomic` is back to returning nothing; only `write_atomic_over` returns the metadata #6686 added.

## Tests

Mirror, in `ingest_tests.rs`, driven by the `Races` hooks (`after_read`, and a new `before_write`), no sleeps:

- `a_save_landing_between_the_read_and_the_write_is_kept_and_read_in`
- `a_save_landing_as_an_empty_pages_blank_file_is_written_back_is_kept_and_read_in`
- `a_save_landing_as_an_ingest_writes_back_is_kept_and_read_in`
- `a_save_landing_as_a_new_file_is_written_back_is_kept_and_read_in`

With the re-check removed all four fail on the file's text: the outside save is gone. One mutation at a time, with the others green: `write_and_record` ignoring `write_file`'s answer fails the first three on the diverged list; a skipped write keeping the changed file's stat as seen fails the first on `changed_files`; a skipped write leaving its temporary file fails the first on the folder's listing; `read_new_file` without its stat fails the existing `a_new_file_read_in_otherwise_than_saved_is_written_back_as_read`.

Chips:

- `e2e-tauri/agenda-projected-repeat.e2e.ts`, one new test, run here in WebKitGTK: red with `truncate` back and red with `isolation` off (the four probes above and below the chips reach the row), green on the clean build with the rest of the file.
- `e2e/phone-touch-targets.spec.ts`, one new test for the wrapped row: red with the area's `z-index` back (a chip's bottom edge reaches the chip under it).

## What ran

- `cargo nextest run --workspace`, in two halves on the final tree: 3999 and 3993 passed.
- `SQLX_OFFLINE=true cargo check --workspace --all-targets` and `cargo clippy --workspace --all-targets -- -D warnings`: clean.
- `npx vitest run`: 1100 files, 26768 tests passed; `npm run typecheck`, `npm run lint` and `tsc` over `e2e/` and `e2e-tauri/`: clean.
- `prek run --all-files` and `prek run --hook-stage manual --all-files`: passed.
- Playwright: `e2e/phone-touch-targets.spec.ts`, 10 passed. `--grep "@mobile|@journal"`: 565 passed, 7 skipped, 2 failed. Both failures are `diagram-legibility.spec.ts`'s wide flowchart (a label of 10.99994 px against 11), and both fail the same way on a clean `origin/main` checkout with this container's Chromium, the build `docs/BUILD.md` § Cloud container names for that spec.
- Real backend: `e2e-tauri/agenda-projected-repeat.e2e.ts`, the whole file, green on the final build. The container had no `tauri-driver`, `webkit2gtk-driver` or `openbox`; `cargo install tauri-driver --locked` and apt supplied them.
- Not run here: the rest of both e2e lanes. `just e2e-related` selects both whole lanes because `src/index.css` changed; CI's runs are that check.
