# Session 3820 — a folder's note and a note with files merge into its page (#6277 G5)

Set out to build G5 item 1, agreed with the coordinator: a folder's note and
an Evernote or Joplin note with files merge into the page of their title, as
a lone Markdown file already did. Until now they imported as `Title (2)`, so
re-importing your own ZIP export to undo a bad edit made a twin of every page.

What shipped:

- `MergeRule` merges any Markdown file. A Logseq or Org file still imports as
  `Title (2)`; the maintainer chose merge-by-re-rendering for it (2026-11-11),
  which is G5 item 3.
- `merge_source`, a pre-pass in `markdown_import_merge_source.rs`, gives the
  buffer save the file in the form it reads. Code fences pass through
  untouched.
  - A folder's links to its other notes become their titles, as the import's
    rewrites write them.
  - A file the page already holds under the same name and bytes is that
    attachment. This covers an export's `assets/<id>/<name>` as well as an
    Evernote or Obsidian file.
  - `template:` and `attachments:` front matter and `attachments::` lines
    come out of the text. Only a file import reads them.
- `finish_merge` runs after the save. It sets the template flag, or clears
  it on `template: false`, whose ops undo with the merge; a file without the
  key leaves the flag alone. It also attaches any new file. A new file goes
  onto the page for front matter, or onto the block whose `^id` an
  `attachments::` line follows. A link in a block's text goes onto that
  block, as an import attaches it.
- The import dialog now asks about folder notes and notes with files too
  (`vault-import.ts`).
- The #6502 review note: two spellings of one later note in ref values no
  longer make two pages.

Regression fixed: since #6496 wrote `template:` and `attachments:` into an
export, re-importing a page's own export on its own had failed with "`template`
is kept by the app". `reimporting_a_template_pages_export_leaves_it_as_it_was`
and `reimporting_the_export_of_a_page_with_files_leaves_it_as_it_was` were red
on main.

Review fixes:

- A plain file merged onto a template page had cleared its flag, which a
  lone-file merge kept on main; only a `template:` key changes it now.
- An `attachments::` line under a new, unanchored block went to the anchored
  block above it, and attached the files the page held a second time. An
  anchor now carries only over blank and `key:: value` lines, and held files
  are filtered out.
- An `attachments::` line following an `^id` of another page (an export
  merged into another space's page of its title) attached its files to that
  page's block a second time. An anchor now names a block only when the page
  holds it.

Traps:

- An `attachments::` line naming a file the page lacks, left in the text,
  traps the block's `^id` anchor inside its content. The line now leaves the
  text with the anchor it follows.
- G4's pairing keeps an edited block's id only between unchanged neighbours,
  so the edited-file test edits a block that has a block after it.
- The `merge_ctx` split keeps `import_markdown_in_run` under the line limit,
  and `Box::pin` keeps its future small.

Existing tests changed:

- `a_file_that_cannot_merge_is_imported_as_title_2` becomes
  `a_logseq_file_is_title_2_and_a_folder_note_or_a_note_with_files_merges`.
  Its folder-note and note-with-files cases now assert a merge.
- The vitest pins of `merges` being undefined for folder picks and notes with
  attachments.
- A `list_import_merges` stub in two DataTab tests, since a folder pick now
  asks.

Shown red:

- The two regression tests, on main.
- The folder round trip, the edited folder note and a file added to an
  `attachments::` line, before the change. The template extraction and the
  held-file match were each mutated off as well.
- The two-spellings test.
- The two review-fix tests: the plain file clearing the flag (and the
  `template: false` arm mutated), and the new block's line, under each fix.
- The export merged into another page of its title, and its own-block
  filter mutated off.
- The new e2e-tauri case, with merging turned off (a folder pick twins every
  page).
