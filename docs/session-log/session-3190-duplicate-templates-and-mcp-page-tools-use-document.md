# Session 3190 — Duplicate, templates and the MCP page tools use the Document dialect

Part A of #6190's step 3: the last writers and readers of the Source dialect outside tests move to Document, the dialect paste, *Edit as Markdown* and `append_markdown` already read. Before this, `get_page_markdown` wrote `- x ^ID` for every block, so an agent that copied a read into `append_markdown` got every block back bulleted (the #6197 bug).

**What changed**
- **Duplicate** (`duplicate_block_inner`) and **journal templates** (`copy_page_blocks_in_tx`) render and read the copied subtree as Document.
- **MCP:** `RenderMode::Agent` lays out as Document. `get_page_markdown` writes each block as `append_markdown` reads it, with its `^ID`; `edit_page_markdown` reads and applies Document. Tool descriptions and their snapshots say so.
- **Mock:** `duplicate_block` drops `listStyle` on a block with a task state, as the backend does; `duplicate_block.json` re-authored by the backend.
- **Left for part B:** the buffer commands' `dialect` default stays Source because only tests and fixtures omit it; `get_page_source` has no production caller. Part B deletes `ParseMode::Source`, `Dialect::Source`, `get_page_source`, the oracle module and the mock's Source grammar.

**Decisions and traps**
- **A legacy task with a list style copies without the style** (D3: the checkbox wins; the Document writer has no syntax for both). Nothing shows while the copy is a task. After both tasks are cleared, the original shows its bullet and the copy is plain. New data gets the pair only through MCP `set_property`, an interrupted second write, an older device, or Export then Import (Export writes `- - [ ] x`).
- **Paging:** `get_page_markdown` stretches are slices of one uncut render, so a stretch is not standalone, as with the old outline. Sending one stretch as `markdown` against a full `base` deletes the rest of the page; the descriptions send edits through `editable: true`, which is never cut.
- **Survivor found in review:** `edit_page_markdown` applying Source instead of Document passed every test, because only a plain closed code block reads differently (Source takes its `^ID` line for a block of its own, so an unchanged read saved as delete + create). `edit_page_markdown_of_an_unchanged_code_block_writes_nothing_6190` pins it.

**Red first**
- the oracle `a_document_duplicate_copies_what_a_source_duplicate_copied` with the list arm of `DocumentLayout::place` narrowed to depth 0;
- the Duplicate and template list tests with Source read back in, and with `+ ` written as `- `;
- the template test extended with a legacy task, red with the template path reverted to Source;
- the MCP round trip with `RenderMode::Agent` taken out of the Document layout, the paging test with a stretch's leading newline dropped, and the unchanged-read tests with the apply dialect set to Source;
- the mock and conformance with `listStyle` copied unconditionally;
- `e2e-tauri/block-duplicate.e2e.ts` on a build that read Duplicate's buffer as Source.

**Suites:** nextest over the whole workspace (7317 run); clippy, `SQLX_OFFLINE` check, fmt; CI's `mcp-tests` stub run; vitest over `src/lib`, `src/components`, `src/editor`, `src/stores`, `src/hooks`, `src/__tests__`, `src/workers`; typecheck, lint, the manual-stage hooks; Playwright `block-duplicate`, `templates` and three paste and menu specs; `e2e-tauri/block-duplicate.e2e.ts` on the real backend. The whole Playwright and WebdriverIO lanes are CI's.
