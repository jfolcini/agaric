# Session 3816 — The Markdown mirror's convergence proptest

#5363's Testing box "proptest over random sequences of Agaric edits and external edits to the same file: it converges, creates no duplicate blocks, and one Ctrl+Z reverts each ingest".

## Premise check

The one generated mirror test, `anchored_and_untouched_blocks_keep_their_ids`, applies outside edits only, never interleaved with Agaric edits or the mirror's ticks. The fixed tests (`a_save_from_a_stale_editor_does_not_undo_what_agaric_wrote_since`, `a_new_line_is_a_new_block_and_saving_the_file_again_adds_no_twin`, the undo test) each pin a single interleaving. Nothing checked convergence across many.

## The change

`tests/command_integration/mirror_convergence.rs`, `edits_from_both_sides_converge_with_no_duplicate_and_each_ingest_undoes`:

- **The steps:** a random sequence of Agaric edits, adds and deletes, edits, adds and deletes to the page's file, and ticks. Every step writes a word no other step writes.
- **The undo check:** a tick may be told to undo the ingest it ran, with `undo_ops_inner` over the event's op refs, as the page's Ctrl+Z does. The page's blocks must then be as they were before that tick.
- **The end state:** ticks run until two in a row read nothing in and write nothing. Then nothing may be diverged or failed, the file's paragraphs must be the page's blocks in order, and no content may appear twice.
- **Deletes from the file:** they always leave one paragraph, because an emptied file is refused by design (`ingest::file_text`; the empty-page case is #6506).
- **Coverage:** instrumented once, the 32-case run read 1 to 4 ingests per case and undid 15 of them. It now runs 64 cases.

## Verification

- The proptest passes, 64 cases in about 7 to 12 s.
- Shown red by three planted defects, each run in one command that restored on exit:
  - an ingest's event carrying only its first op failed "one undo reverts the ingest";
  - the mirror not recording the text it wrote back after an ingest failed "no block is duplicated" (`s0` twice);
  - the mirror writing no render over a file it had written before failed "the file reads as the page".
- `cargo clippy -p agaric --tests -- -D warnings` is clean.
