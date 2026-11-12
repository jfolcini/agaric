# Session 3857 — a merged file's Obsidian `^name` anchors (#6277 G5)

G5 item 2, agreed with the coordinator: a file merged into the page of its
title keeps an Obsidian `^name` marker out of its block's text and makes the
file's links to it refs to that block, as an import does. Until now the save
left the marker in the text and turned each `#^name` link into a page link, so
importing such a file twice changed the page.

What shipped (`markdown_import_merge_anchors.rs`):

- `strip_named_anchors` takes each `^name` marker off the block it ends, by the
  Document reader's own parse, before the lines pair, so a marked line pairs
  with its stored block by its text. A page's own `^ULID` is left to
  `anchor_free`.
- `link_named_anchors` makes `[[#^name]]` and `[[Title#^name]]` refs to the
  block the name's line pairs with, and the lines pair again as refs: a file
  imported twice changes nothing. A name on a new block carries a minted
  placeholder id through the save.
- `link_new_named_blocks`, after the save, finds the block the save made of
  that content in the page's buffer and writes its id over the placeholder; a
  name no one block holds becomes a link to the page, with a warning. Its
  edits undo with the merge.

Also, from the #6502 and #6508 reviews, each its own commit:

- A bare ref value naming a note in a subfolder (`owner:: [[Beta]]` for
  `Ns/Beta.md`) named no note, so the value was dropped, where the link
  `[[Beta]]` reaches the note's page. `create_note_targets` falls back on the
  links' bare-name map (`vault_note_titles`) and keys the page by the note's
  title.
- `merged_line` no longer clones the line it reads attachment refs from.

Shown red:

- `a_file_with_an_obsidian_anchor_reimports_unchanged` and
  `a_merged_files_obsidian_anchor_on_a_new_block_is_its_ref`, before the
  change. The link rewrite and the new-block pass were each mutated off.
- `a_merged_files_obsidian_anchor_on_a_repeated_new_block_links_its_page`,
  with the fallback leaving the placeholder.
- The e2e-tauri case in `import-reimport-merge.e2e.ts`, with the link rewrite
  mutated off.
- `a_bare_ref_value_names_a_later_note_in_a_subfolder`, before its fix.
