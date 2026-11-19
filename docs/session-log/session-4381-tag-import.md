# Session 4381 — Imports and [[Tag/x]] links pair a tag with its page (#6755)

This is slice 3 of #6755, the last. Slice 1 (#6945) and slice 2 (#6973), with the follow-up #6983, are merged.

**What the maintainer decided:**
- An imported `Tag/x` page also creates tag x, so the pair always exists.
- A Logseq graph's tag pages import as `Tag/x`, and its `[[x]]` links point there.
- Midway through the slice, the maintainer widened the rule: "Typing, imports and MCP should work the same way: `[[Tag/x]]` creates the tag if it doesn't exist and links to its page, same as #tag" (#6755 comment 6994449438). This replaces slice 2's "typing `[[Tag/x]]` does not create one".

**What shipped:**
- `import_tag_page_title` (`tag_pages.rs`) finds or creates tag x in the caller's transaction. It runs at the four places an import makes a page: the file's own page, a `[[Tag/x]]` link stub, a folder ref target and a bibliography entry. Paste, Edit as Markdown and the MCP writes share the link-stub code.
- The editor's `[[` Create row, its typed `]]` rule and page mode go through a new command, `create_tag_page_titled(space_id, title)`. In one transaction it finds or creates the tag, then the page.
- A name holding whitespace becomes the dashed tag name (`Tag/deep-work`), with an import warning or an editor toast. A legacy spaced page or tag keeps its spelling.
- A plain *New page*, MCP `create_page` and renames off the path keep #6973's refusals.
- Logseq: `logseqTagPages` maps a graph's Markdown tag pages to `Tag/<title>` (`a___b.md` becomes `Tag/a/b`). Links, a translated `(page x)` query and the note names follow; `#[[x]]`, `tags::` and `alias::` items do not.

**Traps:**
- Org pages in a graph are titled by `#+TITLE`, so mapping them by file name made stray tags. Only Markdown pages map.
- The merge path rolled back the transaction that had just recreated a deleted tag. `create_import_page` now commits it first.
- `list_import_merges` looked up the title as written, so a dashed re-import merged without being listed. It now names the same title the import will use (`import_tag_page_naming`).
- A padded name such as `[[Tag/ x]]` kept its title, so tag x never found it as its page. The title is now `Tag/x` (review note).

**Not done:** the `#` picker's in-session tag cache doesn't learn a tag made by a typed `[[Tag/x]]`. Its Create resolves to the existing tag in the backend, so nothing is duplicated.

**What ran:**
- Rust: workspace nextest (4274 + 4267) before the last rebase. After it: clippy `-D warnings`, 1329 targeted tests, the sqlx check, bindings and `cargo doc`.
- Frontend: vitest across lib, block-tree and pages (10131); typecheck.
- e2e on the bridge: `import-formats` and `tag-page-notes` (33). On the mock lane: 22.
- Every fix and feature was shown red first.
