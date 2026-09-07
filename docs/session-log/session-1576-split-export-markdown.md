# Session 1576 — splitting the markdown export path (#4639)

## What

`src-tauri/src/commands/pages/markdown.rs` had ten
`#[expect(clippy::too_many_lines)]` markers, the largest on
`export_page_markdown_inner` at 590 lines. It is now eight, and that function
is 27 lines of code.

Three commits, each behaviour-preserving with the 130 existing export/markdown
tests as the oracle, and no logic change bundled in:

1. **The render half out.** The read half is the only thing that touches the
   database; everything after it is a pure function of what it resolved. That
   seam becomes `PageExportData` + `render_page_markdown`.
2. **The read half apart.** Each numbered step becomes a function taking the
   #660 snapshot connection: `load_page_row`, `load_descendants`,
   `load_attachments`, `resolve_references` (itself
   `collect_reference_ulids` + `resolve_tag_and_page_names` +
   `resolve_block_refs`), `load_page_properties`,
   `load_descendant_properties`, `resolve_property_ref_titles`,
   `load_frontmatter_lists`. The command body is now the transaction and nine
   calls, and its marker is deleted.
3. **The renderer apart**, plus one duplication removed: the DFS walk and the
   orphan safety net emitted a block through two textually identical bodies at
   different depths, so both now call one `render_block` — at `depth` and at 0.

## The part that was not covered

No export test reached the orphan branch, so step 3's unification was a change
nothing would have caught. `export_emits_a_stray_the_dfs_walk_cannot_reach`
drives a block whose denormalised `page_id` names the page while its
`parent_id` points outside the subtree — the shape the safety net exists for.

Its first draft was worthless. `md.contains("- Stray block\n")` stayed green
against a stray rendered one level too deep, because the deeper line contains
the shallower one as a substring; the falsification run is what showed it. It
now compares whole lines, and the same mutant reddens it.

## Left open

#4639 is a sweep. As of this commit 136 markers remain under `src-tauri/`
across 73 files, eight of them still in this file.
