# Session 3920 — A duplicate block from the mirror's choice of base text

#5363: main's CI failed `mirror_convergence::edits_from_both_sides_converge_with_no_duplicate_and_each_ingest_undoes` with a duplicated block. This session pins that case and fixes it.

## The cause

An ingest reads a file against the shadow (one of the last texts the mirror wrote for the page) that `closest` picks. `closest` counted blank lines. Every text shares blank lines, so a file line that only the newest text holds could tie with an older text. The tie went to the older text, which lacks that line, so `pair_unanchored_lines` paired the file's lines positionally against it. The line was renamed onto another block while its own block stayed: the same text in two blocks.

The case from CI: the shadows were `w0 w1 w2` and `w0 w1 w2 s0 s1`, and the file read `s7 s1 s8`. With blank lines counted, both shadows left three of the file's lines unexplained, and the older one won. Against it, `s1` was paired with `w1` while the `s1` block stayed.

## The change

- `closest` (`src/mirror/ingest.rs`) compares non-blank lines only. The newest text explains `s1` and wins.
- `docs/architecture/data-and-events.md` (*Ingest*) says so.

## Sibling paths

- `create` reads a new page's file against an empty buffer and makes no choice of shadow.
- `renamed_from` matches by anchors or exact bytes.
- The read-back confirmation goes through the same `ingest`, so the fix covers it.

## Tests

- **Unit (`src/mirror/ingest_tests.rs`):** `a_save_keeping_a_line_only_the_newest_text_holds_is_read_against_it`. A page `a b c` is written, then `d e` added and written; the file saved as `x e y` reads in as `x e y`.
- **Named regression (`tests/command_integration/mirror_convergence.rs`):** `deleted_lines_around_an_agaric_edit_then_an_edited_and_added_line_duplicate_none`, the step list from main's CI. It was red on `origin/main` (a021d8c). An earlier green run of main had drawn different random cases.
- **Main's earlier failure (run 43078442203, 01947394f)** was a different step list. It passes on a021d8c with or without this change, since #6571 landed in between, so no test for it is added: none could fail here.
- **Falsified:** with the blank-line filter removed, in one command that restored the file, both tests went red on their predicted assertions. The unit test read `x e y d e`, and the regression duplicated `s1`.
- **Results:**
  - `cargo nextest run -p agaric -E 'test(/mirror/)'`: 120 passed;
  - the convergence proptest at `PROPTEST_CASES=500`, under `cargo test` since nextest stops a test at 60 s: passed;
  - `cargo clippy --workspace --all-targets -- -D warnings`: clean.
