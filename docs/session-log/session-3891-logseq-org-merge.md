# Session 3891 — a Logseq or Org file merges into the page of its title (#6277 G5)

G5 item 3, the last of #6277: re-importing a Logseq page or an Org file now
updates the page of its title in place, as a Markdown file already did, where
it used to import as `Title (2)`. The maintainer chose merge by re-rendering
(2026-11-11): no second save path, and the readers unchanged.

Premise check first, agreed with the coordinator:

- A Logseq `id::` uuid is not stored: the import uses it only to resolve the
  file's `((uuid))` refs. So a re-rendered block pairs by its text, and its
  uuid's refs become refs to the block its line pairs with.
- Collapse is not stored either: the import returns the folded blocks to the
  frontend. A merge now returns them too.

What shipped (`markdown_import_merge_outline.rs`):

- `render_outline` puts the outline reader's blocks into a `PageExportData` as
  an import would store them (task state, priority as the import maps it,
  planning dates, list styles, the rest as rows; aliases, tags and page
  properties as front matter), each block under a minted placeholder id, and
  renders it with `render_page_document`. A `((uuid))` to a block of the file
  becomes a ref to that block's placeholder.
- `link_outline_ids`, after the lines pair, writes the id of the block each
  placeholder's line paired with over the placeholder, and the lines pair
  again; a placeholder on a new block is resolved after the save, by content,
  as #6580's `^name` is. The folded blocks come back the same way (`fold_ids`).
- `MergeRule` merges every dialect; its Logseq-or-Org warning is gone.
- The import dialog asks about a Logseq page or an Org file too: its title is
  read from its text (`title::`, `#+TITLE`), so `ImportUnit.merges` may be a
  function, resolved one file at a time.

Traps:

- A Rust `\` line continuation eats the next line's indent: the first
  fixtures lost their nesting and planning lines and passed without covering
  them. The fixtures are `concat!` now, and the Logseq test asserts each shape
  was stored before it re-imports.
- The backend never sees Org text: the frontend's `orgToMarkdown` sends
  Logseq-style Markdown (`ID::`, `((uuid))`), so the Org twin's fixture is that
  output.

Existing tests changed, each pinning the rule this replaces (a Logseq or Org
file never merges):

- `a_logseq_file_is_title_2_and_a_folder_note_or_a_note_with_files_merges`
  becomes `a_logseq_file_a_folder_note_and_a_note_with_files_merge`; its
  Logseq case asserts a merge.
- The vitest pins of `merges` being undefined for an Org file and a Logseq
  page, in `vault-import.test.ts` and `vault-import-merges.test.ts`.

Shown red:

- `a_logseq_file_imported_twice_leaves_its_page_as_it_was`,
  `an_org_file_imported_twice_leaves_its_page_as_it_was` and
  `an_edited_logseq_file_updates_its_page_in_place`, before the change. The
  priority mapping, the pre-save placeholder rewrite and the fold ids were
  each mutated off.
- The vitest `merges` tests, with the title not read from the text.
- The e2e-tauri case in `import-reimport-merge.e2e.ts`, with outline files
  refused a merge (the page came back as `(2)`).
