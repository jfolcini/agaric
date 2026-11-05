# Session 3527 — A Markdown file reads as a paste, and the export writes the Document layout

#6277 E2 (decisions 1–3, 6). A `Markdown`-dialect import now uses the reader that paste, Edit as Markdown and MCP use. That covers plain `.md`, Obsidian, Notion, Evernote and Joplin. The reader is `parse_markdown_file`: the Document scan, plus front matter and leading `key::` lines as page properties and a trailing `^word` as the block's anchor. A Logseq graph or an `.org` file (`LogseqOrg`) keeps the outline reader. Only that dialect runs #6317's `rewrite_org_blocks`, and a Markdown file keeps `STARTED x` and `#+BEGIN_NOTE` as written (`a_markdown_file_keeps_logseq_keywords_and_blocks_as_written`).

Every render mode now uses the Document layout, so the export is laid out as the Edit as Markdown buffer. The outline arm, its mode parameter and escapes, and `lays_out_document` are gone. `push_export_bullet` always writes names, and anchors a block that something addresses or that leaves a code fence open, which would otherwise swallow the blocks after it on re-import. The mirror's `RenderMode::File` (#6328) keeps its own naming and anchor rules. The mock's export and import follow (`renderPageDocument`, `parseMarkdownFile`). `dropTitleLine` in `export-graph.ts` now finds the title past A1's front matter, so files in an export-all ZIP drop it again.

Review (sonnet, max) blocked on silent loss. A first block written bare was eaten on re-import by `strip_title_heading` (a first `# Plan` on page "Plan", through a ZIP) or by `strip_frontmatter` case 2 (`# Weekly sync`, `---`, `Date: …`, `---`). Main's `- ` prefix had hidden both. In Export and File mode a first block opening with `# ` is now a `+` item, as a first `---` was. The fix covers the mirror's file, which lost the same heading on main. `a_file_opening_with_a_heading_imports_back_to_its_blocks` pins export, ZIP and mirror, and a vitest pins the mock; both were red first. The re-review approved. It also found a proptest whose oracle skipped the import's foreign-form normalisation, failing about 1 in 25,000 cases (`---\(a\)`), now normalised.

Tests changed by decision. Tests built on Logseq or Org syntax import through `import_logseq_inner`. Tests that read a Markdown note expect the Document reading: headings own nothing, a bullet has its `listStyle`. Export tests expect the Document layout. Conformance fixtures were re-authored by the backend. e2e-tauri specs that fed Logseq syntax now import a Logseq graph.

Losses, documented in #6277:
- An unaddressed block ending in ` ^word` loses the tail, as before.
- In a Markdown file, `id::`, `collapsed::` and `heading::` are ordinary properties.
- Lines right after a closing fence stay in that fence's block, as a paste reads them.

Left for the follow-up: re-pointing the vector oracles that still read with `parse_logseq_markdown`, the mock import's missing `listStyle` rows, the import summary counting `listStyle`, and the import bench.
