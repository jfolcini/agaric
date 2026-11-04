# Session 3319 — pair unanchored lines

#6277 G4: `pair_unanchored_lines`, beside `apply_page_source_inner`. Decision 6
writes a `^ID` anchor only on a block something addresses, so a file edited
outside Agaric carries no id on most blocks; this gives each of them the id it
had when the text was last written. The #5363 ingest (slice 2) and the
re-import merge (G5) will call it; nothing does yet.

The plan's signature was `(base_text, base_line_ids, text) -> line_ids`. The
function also takes `text`'s own `line_ids`, the ids its anchors gave as
`anchor_free` returns them, because the save reads no `^ID` from text: both
sides are in the form `apply_page_source_inner` takes.

Blocks are read with `parse_document_text`, as the save reads them, and
compared by content and properties, not depth, so a block nested under its
neighbour keeps its id. Three passes: the longest common subsequence (common
head and tail trimmed first, since the table is quadratic), then identical
content elsewhere as a move, then, between two subsequence pairs, a run of
changed blocks as long as the run it replaced, block for block. A block moved
and edited in one save, or one of several identical blocks, comes back new;
that loss is the one #5363's 2026-11-04 comment accepts.

Ran: `cargo test --lib -p agaric -- source_apply::pair` (11 tests, three
proptests). Disabling the gap fill, the move pass and the anchored-id exclusion
each turned the tests that name them red. `cargo clippy --workspace
--all-targets -- -D warnings`.
