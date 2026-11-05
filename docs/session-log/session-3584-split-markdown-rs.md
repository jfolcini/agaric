# Session 3584 — Split markdown.rs into seam modules

A pure move that breaks `src-tauri/src/commands/pages/markdown.rs` into sibling child modules, so the later #6277 items (E3/E4/E5, F1–F3) each touch their own file and their PRs do not conflict. No function body, signature or doc comment changed.

What moved, declared from `markdown.rs` with `#[path]` like `markdown_properties.rs`:

- `markdown_links.rs` (`link_helpers`): the link and tag text helpers the export, paste and import paths all use (`HUMAN_PAGE_LINK_RE`, `HUMAN_TAG_RE`, `collect_inbound_*`, `rewrite_inbound_*`, `humanise_tag_and_page_refs`, `NameSnapshot`, `folder_path_to_namespace_title`).
- `markdown_export.rs` (`export`): `PageExportData` and its loaders (`load_page_export_data`, `load_descendants`, `load_page_properties`, …), the renderers (`render_page_markdown`, `render_page_document`, `render_clipboard_source`, `push_export_bullet`, `push_block_bullet`, `render_frontmatter`), `PageFile` and `anchor_free`.
- `markdown_paste.rs` (`paste`): `PasteInput`, `PasteSplice`, `copy_page_blocks_in_tx`, `append_markdown_in_tx`, the `*_resolving_names` writers, `resolve_pasted_names` and `create_parsed_blocks`.
- `markdown_import.rs` (`import_core`): `IMPORT_CHUNK_BLOCKS`, `parse_import_payload`, `create_import_page`, `resolve_document_refs`, `ImportCtx`, `NameCtx`, `insert_blocks`, the chunk commits and `finish`.
- `markdown_import_front_matter.rs`, `markdown_import_links.rs`, `markdown_import_anchors.rs` and `markdown_import_attachments.rs`: front matter, link and tag resolution (`match_page_names`, `resolve_link_names`, `resolve_tag_names`), anchors (`link_cross_page_anchors`, `anchor_block`, `resolve_anchor_links`) and attachments (`check_attachment_budget`, `ingest_read_counts`, `ingest_attachments`).

`markdown.rs` keeps the module doc, the `#[tauri::command]` wrappers and the `*_inner` entry points they and the MCP tools call (`export_page_markdown_inner`, `get_page_buffer_inner`, `duplicate_block_inner`, `paste_blocks_inner`, `append_markdown_inner`, `import_markdown_inner`, `import_markdown_with_progress`, `link_import_anchors_inner`, …), and the test module.

The glue, and nothing else:

- Each new file starts with `use super::*;`; `markdown.rs` glob-re-exports each child, so every `pages::markdown::<name>` path still resolves.
- A moved item another module uses became `pub(super)` (fields and methods too); `HUMAN_TAG_RE` became `pub(in crate::commands::pages)`, the reach its old `pub(super)` had.
- The moved bodies name `super::inline_query_md`, `super::aliases`, `super::markdown_yaml`, `super::super::blocks` and `super::super::properties`. One level deeper those paths broke, so `markdown.rs` imports the first three and `pages/mod.rs` imports `blocks` and `properties`.
- `pagination_app_tests.rs` reads the two `query_as!(BlockRow, …)` sites from `markdown_export.rs`, where they now live. Comments that cited `markdown.rs` for a moved symbol now cite its new file.

Ran: `cargo fmt --all --check`; `cargo clippy --workspace --all-targets -- -D warnings` (clean); `cargo nextest run --workspace` in two partitions (3816 and 3807 passed, 0 failed); `specta_tests` (`src/lib/bindings.ts` unchanged); `cargo doc --workspace --no-deps` with `-D warnings`. A purity script compared the old file's non-blank lines with the union of the new files, ignoring `use`/`mod` lines and visibility prefixes. Nothing was lost. The lines that differ are the new module docs, the one glue comment, and rustfmt reflows of signatures that the `pub(super)` prefix pushed past the width. With whitespace removed, the code text of both sides is identical.
