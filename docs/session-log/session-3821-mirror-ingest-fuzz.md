# Session 3821 — A fuzz target for the Markdown mirror's ingest

#5363's Testing box "cargo-fuzz target in `src-tauri/fuzz` for the ingest path (file bytes with arbitrary `^ID` anchors through `parse_source_outline` and the apply plan)".

## Premise check

- The box names `parse_source_outline`, which does not exist. The grammar the ingest reads with, `parse_document_outline`, is already fuzzed by `import_parse`.
- The apply plan is `apply_page_source_inner`, which needs a database and so is not a libFuzzer target; the mirror's proptests cover it.
- What the ingest runs on raw file bytes, before the save, had no fuzzing:
  - `ingest::file_text`;
  - `anchor_free_kept`, which strips anchors by line arithmetic;
  - `pair_unanchored_lines`, with its `line - 1` indexing;
  - `splice::splice` on the way back out.

  A panic in any of them ends the mirror's task. The target fuzzes these four.

## The change

- `fuzz/fuzz_targets/mirror_ingest.rs`:
  - The input is the text last written, a NUL, then the file's bytes. The text last written gives an id to every line that starts a block, as the render does.
  - The steps run in `ingest::ingest`'s order, and the target asserts one id slot per edited line and per written line.
- A `[[bin]]` entry, which is how the weekly lane enrolls a target. This makes eight, the count its timeouts are sized for (`BUDGETED_TARGETS`).
- Three seeds under `fuzz/corpus/mirror_ingest/`:
  - an edited line;
  - an anchored block beside a new line;
  - front matter with nesting, saved with CRLF and a BOM.
- `fuzz/Cargo.lock` did not move: no dependency changed.

## Verification

- `SQLX_OFFLINE=true cargo +nightly fuzz run mirror_ingest --target x86_64-unknown-linux-gnu -- -max_total_time=120`: 415,787 runs, no crash.
- A planted off-by-one in `pair_unanchored_lines` (`out[line]` for `out.get_mut(line - 1)`) was found within the same budget: "index out of bounds: the len is 1 but the index is 1".
- The restore in that falsification command used a relative path after the command had changed directory, so it failed. The file was restored by hand and `git status` checked clean. Next time, give the restore an absolute path.
