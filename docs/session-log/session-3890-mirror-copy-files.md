# Session 3890 — Copying attachments into the Markdown mirror (backend)

#5363 slice 4, setting 3, PR A of two: the backend, with the setting unreachable from the UI until PR B adds the control.

## Decisions (coordinator, recorded on #5363)

- **What is copied:** what pages link, per space, as the export does. An attachment linked from two spaces is copied into both. The file render (`PageRead::File`) loads no attachment rows, so the copy set is exactly the `attachment:<id>` links in the rendered file.
- **Where copies go:** the export's layout, `<space>/assets/<id>/<name>`. The page links a copy by a path relative to its file, one `../` per namespace folder.
- **The scan:** the mirror's new-file scan and `read_back::pending` skip only folders shaped `<space>/assets/<26-char id>/`. A copied `notes.md` is never read as a page, and a page titled `assets/x` is still read back.
- **Names:** the export's TS naming moved into an exported `assetName` (`src/lib/export-graph.ts`) and is ported to Rust as `assets::asset_name`. `conformance/asset-names.vectors.json` (25 rows: `/`, `\`, `:`, reserved names, trailing dots, BOM, NEL, CJK) is asserted by a vitest and a Rust test. Page paths keep `paths::sanitize_segment`, so no page file moves.
- **Turning it off:** a full pass puts `attachment:` links back. Copies still as written are removed; a changed one stays and is listed under `diverged`, with an empty `page_id`.
- **Read-back:** only `(../)*assets/<id>/…` naming a live attachment maps back to `attachment:<id>`, before `apply_page_source_inner`. Anything else stays text, and a file dropped into `assets/` is never read.

## The change

- **`src/mirror/assets.rs`:**
  - the name sanitizer;
  - `Links`, the link rewrite per page;
  - `delocalize`, the read-back mapping;
  - `is_copy_dir`;
  - `Copies`, the record of copies written, `mirror/copies.json` in the app's data. A copy is rewritten when it is missing or its length or modification time changed since. It is removed, while unchanged, once its attachment is gone, once no page of its space links it after a full pass that rendered every page, or once copying is off.
- **`mod.rs`:**
  - a page's render is localized before it is compared or written;
  - each pass ends with a sweep of the copies no longer wanted;
  - turning the setting on or off makes the next tick a full pass.
- **`ingest.rs`:** `ingest` and `create` delocalize before saving and write back localized. Their shared write-back moved into `rendered_back`, which keeps `create` under the 70-line limit.
- **The setting:** `mirror.copy_files` (`"true"` only), the `set_mirror_copy_files` command, and `MirrorStatus.copy_files`. The command has a mock handler and a waiver in both waiver lists, beside `set_mirror_read_back`.

## Tests

- **`src/mirror/assets_tests.rs`:**
  - the vectors;
  - the copy-folder rule;
  - the link rewrite at two depths and with `<…>` destinations;
  - `linked`;
  - tick tests for: off by default; on, copy and link; a missing and a changed copy rewritten; off, removing unchanged copies and listing a changed one; a deleted attachment's copy removed; an edit beside a link read back as `attachment:`; and the `assets/` scan cases.
- Each falsified by a planted defect, in one script that restored the files on exit; each failed the test it targets:
  - no link rewrite;
  - an existing copy never rewritten;
  - a changed copy removed;
  - dead attachments counted live;
  - no read-back mapping;
  - copy folders not skipped;
  - copying on by default.
- Copying on by default first survived: the default test stored `false` explicitly. Its fixture now leaves the setting unset.
- **Existing tests edited for the new required `MirrorStatus.copy_files` field:** the `get_mirror_status` stubs in `DataTab.test.tsx` (two) and the `status()` fixture in `MirrorSection.test.tsx`.
- **Results:**
  - `cargo nextest run -p agaric -E 'test(/mirror/)'`: 108 passed;
  - vitest over the settings, the mock and the vectors: 69 files passed;
  - `npm run typecheck` and `cargo clippy -p agaric --all-targets -- -D warnings` are clean.

## Bench

`mirror_bench.rs` gains two cases. The numbers come from `cargo bench` with `CARGO_PROFILE_BENCH_LTO=false CARGO_PROFILE_BENCH_CODEGEN_UNITS=16`, not the shipped profile, on a shared cloud box at load 1.5 to 3.9; each is Criterion's [low, mean, high]:

- `mirror_copy_first/500`: the first full pass, 500 pages each copying a 64 KiB attachment (32 MB), took 2.04, 2.15 and 2.26 s.
- `mirror_copy_unchanged/500`: a full pass with every copy in place took 423, 441 and 458 ms.

The unchanged pass costs about what a plain full pass of 500 pages does (`mirror_startup_pass` measured about 0.7 ms a page), so checking copies in place adds little. Both run on the mirror's background task, a tick after boot, so neither delays first paint.
