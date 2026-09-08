# Session 1597 — the eight `too_many_lines` markers in markdown.rs (#4639)

## What

`src-tauri/src/commands/pages/markdown.rs` carried 8
`#[expect(clippy::too_many_lines)]` markers, on functions measuring 156, 130,
168, 96, 106, 164, 153 and 149 code lines against a threshold of 70. All eight
are gone, and so are the markers.

Because an unfulfilled `#[expect]` is a build failure, clippy passing with the
attributes deleted IS the proof each function dropped under the threshold —
there is no separate measurement to trust. Falsified by re-adding one marker to
`apply_frontmatter_tags` on a copy: `warning: this lint expectation is
unfulfilled`, an error under `-D warnings`. Restored, `cmp`-verified.

Two extractions did more than move code. `stamp_space_property` replaced four
copies of the `space` ref stamp, and `ImportCounters` folded the three `u64`
counters threaded through the import phases into one `&mut` struct — that is
what let `insert_blocks`' signature shrink, and with it two of the six
`#[allow]`s that existed only to tolerate the old shapes (one
`too_many_arguments`, one `type_complexity`).

Four remain, on `import_markdown_*`, `resolve_inbound_tags` and `insert_blocks`.
Worth saying because a stale `#[allow]` is invisible: unlike `#[expect]`, it
never reds when the thing it tolerates is gone, so nothing will tell the next
reader they can be deleted.

## The one real logic change

Two branches in the wiki-link loop merged into one. The pair was:

- `block_anchor_id.is_some() && resolved == page_id` → block anchor
- `anchor.is_some() && block_anchor_id.is_none() && resolved == page_id` → heading

`block_anchor_id` is `anchor.and_then(obsidian_block_anchor_id)`, so
`block_anchor_id.is_some()` implies `anchor.is_some()` and the union is exactly
`anchor.is_some() && resolved == page_id`. The block-vs-heading choice moved
into `deferred_anchor`, which dispatches on the same `block_anchor_id` the two
guards were splitting on. The arms are mutually exclusive, so their order never
mattered.

## What was checked rather than assumed

- The two index maps (`anchor_to_block_index`, `heading_to_block_index`) now
  build at the END of `resolve_document_refs` instead of mid-sequence. Safe
  because both are pure functions of `parse_output.blocks` and every phase
  between takes `parse_output` by shared reference, so nothing can have
  mutated it.
- All 20 SQL literals are byte-identical to the originals, so no `.sqlx`
  regeneration. The `#[tauri::command]` surface is untouched, so no bindings
  drift.

No provenance comments were added. Which commit a body came from is git's job,
and "body unchanged" is a claim about one past commit that goes stale on the
next edit with no test to catch it.
