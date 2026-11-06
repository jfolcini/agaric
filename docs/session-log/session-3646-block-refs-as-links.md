# Session 3646 — block refs are written as Obsidian links (#6277 F2)

The surfaces that come back to Agaric (`Names::ReadBack`) now write a block ref as an Obsidian block link, and a whole-block block embed as Obsidian's embed, where the link reads back as the same block.

- **Writer:** `name_block_refs` in `src-tauri/src/commands/pages/markdown_links.rs`, called by `humanise_refs_for_source`:
  - `[[#^ULID]]` for a block of the page in the buffer, MCP `get_page_markdown` and the mirror's file;
  - `[[Title#^ULID]]` for another page's block, and for the page's own in Copy blocks, which leaves its page (`Anchors::Needed` in `push_bullet`);
  - `{{embed ((ULID))}}` becomes `![[#^ULID]]` or `![[Title#^ULID]]` through F1's `as_obsidian_embed`;
  - a ref stays `((ULID))` when its block is not one the anchor pass finds on the page the link names: deleted, in another space, a page, or on a page whose title reads as another page. An escaped ref stays too, and the whole-block read-back check still covers the rest.
- **Snapshot:** `LinkMatches` gains `blocks` (each block a `^id` may name, with its page) and `own_page`, read by `read_ref_blocks` in `markdown_export.rs` through the reader's own `load_anchor_candidates`, for the pages the targets' titles name and the page itself. `resolve_block_refs` also returns each target's page title for the lookup. They sit on `LinkMatches`, not `NameSnapshot`, so no existing test's struct literal changes.
- **Readers:** `NameSnapshot::page_links` reads an anchored name as the block (`LinkMatches::anchored_block`), so a buffer save reads a held `[[#^id]]` / `[[Title#^id]]` back. A new `[[Title#^id]]` already resolved through `link_cross_page_anchors`. A new anchor-only `[[#^id]]`, which the name pass leaves to an import's anchor pass, now resolves in `resolve_buffer_names` (`own_anchor_links`). Paste (`markdown_paste.rs`) and `import.rs` are unchanged.
- **Anchors:** the buffer anchors every block; the mirror's file anchors the page's own ref targets (`resolve_block_refs`) and every target with an inbound `block_links` edge (`load_addressed_blocks`), so another page's file carries the `^id` its link names; Copy blocks names a page, never `[[#^id]]`.
- **Paste and append** (maintainer's option a): an anchor-only `[[#^ULID]]` has no file page to name a block on, so it stayed text. `link_global_block_anchors` in `markdown_import_links.rs` now links it to the live content block of that id in the paste's space, a block id being global; a block of another space keeps its link as text, since the create would refuse a ref to it. Red first: `an_anchor_only_link_pasted_under_another_page_is_the_ref` (paste, embed, and a foreign block) and `an_appended_read_keeps_a_ref_to_a_block_of_its_page` (MCP read appended under another page), both keeping `[[#^ULID]]` before the fix. Falsified: the space filter made always true writes the foreign link as `((FOREIGNBLOCK))`.
- **Mirrors:** none changed. The mock writes no names and does not model block anchors.
- **Tests:**
  - unit tests in `markdown_source_tests.rs` (written forms, raw cases, block embeds);
  - `a_buffer_holding_block_refs_saves_as_nothing` in `markdown_source_apply_tests.rs`;
  - `tests/commands/block_ref_link_tests.rs`: buffer → save, copy → paste, mirror file → re-import (`merged == Some([])`), a deleted target;
  - a raw `document-lines.vectors.json` row;
  - `e2e-tauri/block-ref-obsidian-link.e2e.ts`.

  The integration tests were red on main for the written form. Four mutations (drop the page check, drop the own-page reader, drop the snapshot's anchored reading, write `[[#^id]]` in a copy) each turned the predicted tests red.
- **Re-authored:** the vector row, `markdown_documents.clipboard.txt` (`see ((S3))` → `see [[Field Notes#^S3]]`) and its hash, and the `get_page_markdown` tool-description snapshot.
- **Existing-test edits (approved by the maintainer, option a):** `get_page_buffer_writes_in_space_names` expects `[[#^SOURCE_TARGET]]`, `get_blocks_source_writes_names_and_raw_block_refs_without_anchors` expects `[[Source#^SOURCE_TARGET]]`, and the two `obsidian_embed_tests` expect `![[Other#^theirs]]` for a block embed; each message or doc comment says the same.
- **Mirror:** a block ref's other end is mirrored in the same pass (`Mirror::block_ref_pages`): the target's page gains its `^ID`, and a rename or move of the target rewrites the referring page. Red first: three tests in `src-tauri/src/mirror/tests.rs`.
- **Docs:** `editor-and-content.md` (the Document-form row and `Names`), `import-export.md`, `agent-access.md` and the `get_page_markdown` description in `tools_ro.rs`.
- **Ran, on the merged head:** `cargo fmt --all --check`; `cargo clippy --workspace --all-targets -- -D warnings` (clean); the specta bindings check (`bindings.ts` unchanged); `cargo nextest run --workspace` in two partitions: 3864 and 3857 passed, 0 failed; `npm run typecheck`, `npm run typecheck:e2e-tauri`, `npm run lint`; vitest over the mock, the Document reader and conformance: 2039 passed. `just e2e-related` selects no Playwright spec and the whole WebdriverIO lane, which runs in CI. An independent review of the mirror fix, the paste fix and the merge with F3 approved with no blocking defect; its stale-wording notes are fixed.
