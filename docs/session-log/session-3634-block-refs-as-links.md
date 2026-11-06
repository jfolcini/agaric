# Session 3634 — block refs are written as Obsidian links (#6277 F2)

The surfaces that come back to Agaric (`Names::ReadBack`) now write a block ref as an Obsidian block link, and a whole-block block embed as Obsidian's embed, where the link reads back as the same block.

- **Writer:** `name_block_refs` in `src-tauri/src/commands/pages/markdown_links.rs`, called by `humanise_refs_for_source`:
  - `[[#^ULID]]` for a block of the page in the buffer, MCP `get_page_markdown` and the mirror's file;
  - `[[Title#^ULID]]` for another page's block, and for the page's own in Copy blocks, which leaves its page (`Anchors::Needed` in `push_bullet`);
  - `{{embed ((ULID))}}` becomes `![[#^ULID]]` or `![[Title#^ULID]]` through F1's `as_obsidian_embed`;
  - a ref stays `((ULID))` when its block is not one the anchor pass finds on the page the link names: deleted, in another space, a page, or on a page whose title reads as another page. An escaped ref stays too, and the whole-block read-back check still covers the rest.
- **Snapshot:** `LinkMatches` gains `blocks` (each block a `^id` may name, with its page) and `own_page`, read by `read_ref_blocks` in `markdown_export.rs` through the reader's own `load_anchor_candidates`, for the pages the targets' titles name and the page itself. `resolve_block_refs` also returns each target's page title for the lookup. They sit on `LinkMatches`, not `NameSnapshot`, so no existing test's struct literal changes.
- **Readers:** `NameSnapshot::page_links` reads an anchored name as the block (`LinkMatches::anchored_block`), so a buffer save reads a held `[[#^id]]` / `[[Title#^id]]` back. A new `[[Title#^id]]` already resolved through `link_cross_page_anchors`. A new anchor-only `[[#^id]]`, which the name pass leaves to an import's anchor pass, now resolves in `resolve_buffer_names` (`own_anchor_links`). Paste (`markdown_paste.rs`) and `import.rs` are unchanged.
- **Anchors:** the buffer anchors every block; the mirror's file anchors the page's own ref targets (`resolve_block_refs`) and every target with an inbound `block_links` edge (`load_addressed_blocks`), so another page's file carries the `^id` its link names; Copy blocks names a page, never `[[#^id]]`.
- **Known limit:** a `[[#^id]]` read with `get_page_markdown` and appended under another page with `append_markdown` stays text; `agent-access.md` says so.
- **Mirrors:** none changed. The mock writes no names and does not model block anchors.
- **Tests:**
  - unit tests in `markdown_source_tests.rs` (written forms, raw cases, block embeds);
  - `a_buffer_holding_block_refs_saves_as_nothing` in `markdown_source_apply_tests.rs`;
  - `tests/commands/block_ref_link_tests.rs`: buffer → save, copy → paste, mirror file → re-import (`merged == Some([])`), a deleted target;
  - a raw `document-lines.vectors.json` row;
  - `e2e-tauri/block-ref-obsidian-link.e2e.ts`.

  The integration tests were red on main for the written form. Four mutations (drop the page check, drop the own-page reader, drop the snapshot's anchored reading, write `[[#^id]]` in a copy) each turned the predicted tests red.
- **Re-authored:** the vector row, `markdown_documents.clipboard.txt` (`see ((S3))` → `see [[Field Notes#^S3]]`) and its hash, and the `get_page_markdown` tool-description snapshot.
- **Left red for approval:** `obsidian_embed_tests::the_buffer_writes_a_page_embed_as_obsidians_and_saves_it_back`, `obsidian_embed_tests::a_copied_embed_pastes_back_as_the_embed`, `page_cmd_tests::get_page_buffer_writes_in_space_names` and `page_cmd_tests::get_blocks_source_writes_names_and_raw_block_refs_without_anchors` each assert that a block ref or block embed stays raw.
- **Docs:** `editor-and-content.md` (the Document-form row and `Names`), `import-export.md`, `agent-access.md` and the `get_page_markdown` description in `tools_ro.rs`.
