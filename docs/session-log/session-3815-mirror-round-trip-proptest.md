# Session 3815 — The Markdown mirror's round-trip proptest

#5363's Testing box "proptest round trip over random block trees, reusing the `markdown-corpus` fixtures".

## Premise check

- Agaric's own buffer is already covered: `saving_a_pages_own_document_by_its_line_ids_writes_nothing` saves generated pages by their buffer's line ids.
- The mirror reads back by another path, and nothing generated covers it. `ingest::ingest` reads the *file* form (names, a `^ID` only on an addressed block), pairs unanchored lines against the shadow, and saves against the shadow's buffer. Before this session, only the fixed two-block `a_file_saved_with_crlf_and_a_bom_reads_as_its_page` covered it.
- Bytes equal to the shadow never reach the ingest, so the test re-encodes each file, as an editor that writes CRLF or a BOM would, to send it through.
- The box "Rust integration tests for the outbound writer" is already covered in `src/mirror/tests.rs`, apart from the empty root (slice 3's delete PR) and a debounce the mirror does not have (it polls every `TICK`). Nothing was added for it.

## The change

- `tests/command_integration/mirror_round_trip.rs`, `every_mirrored_file_re_encoded_reads_back_with_no_op`:
  - imports every corpus document, then adds a generated tree whose blocks copy their contents, so a line has twins to be paired with;
  - lets the mirror write every page, then re-saves each non-empty file with CRLF, a BOM or both;
  - asserts that every file is read back, no op is appended, nothing is diverged or failed, and every file is written back byte for byte.
- `.config/nextest.toml`: the test joins the slow-test leash in both profiles. Each case imports the whole corpus, and a case runs about 3 s on a dev box.

## Found, not fixed here

The mirror code belongs to the slice 3 and 4 session, so this was reported to the coordinator.

- An empty page writes an empty file. If an editor saves that file with a final newline or a BOM, `ingest::file_text` refuses it as an emptied save, and `Mirror::read_edit` keeps refusing those bytes.
- The page's file then never takes another write: a block added in Agaric does not reach it, and the page stays listed as failed. A repro test was red.
- The proptest leaves empty files out for this reason.

## Verification

- The proptest passes, 8 cases.
- Shown red by two planted defects in `ingest.rs`, each run in one command that restored on exit:
  - `file_text` keeping CRLF failed the written-back assertion;
  - unanchored lines left unpaired failed "reads back as its page, yet saved … created: 6, deleted: 6".
- `cargo clippy -p agaric --tests -- -D warnings` is clean. Only a test file was added, so no other crate is affected.
