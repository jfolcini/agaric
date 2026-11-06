# Session 3622 — embeds are written as Obsidian embeds (#6277 F1)

A block that is one embed is now written as Obsidian's embed, through the one writer, so every Document surface changes at once.

- **Writer:** `as_obsidian_embed` in `src-tauri/src/commands/pages/markdown_links.rs` turns a named `{{embed [[target]]}}` into `![[target]]`. It does so only when `import::rewrite_obsidian_note_embeds` reads the `![[…]]` back as exactly that text, so a target named like a file (`paper.pdf`), one holding a `|`, or one with padding stays `{{embed …}}`. Both naming passes call it, and only on a block whose text a name changed:
  - `resolve_ulids_for_export` (`Names::Always`): the export, page copy and ZIP write `![[Title]]`, `![[Title#^ULID]]`, or `![[#^ULID]]` on the page's own block;
  - `humanise_refs_for_source` (`Names::ReadBack`): the buffer, block copy, the mirror's file and MCP `get_page_markdown` write a page embed as `![[Title]]` when the name reads back. They write a block embed as `{{embed ((ULID))}}`, since `ReadBack` writes every block ref by id. A code block is left alone.
- **Readers:** no reader changed. `normalize_foreign_forms` already reads `![[…]]` back on every surface it is now written to:
  - Markdown import;
  - paste and MCP writes (`resolve_pasted_names`);
  - the buffer save (`resolve_buffer_names`, edited blocks only, while unedited blocks keep their stored text);
  - a re-import of the mirror's file (`merge_into_page` → `apply_page_source_inner`).

  `paste` and `import.rs` are untouched.
- **Mirrors:** none. The mock writes no names, so its export and buffer keep `{{embed [[ULID]]}}` as before. `name-tokens.ts` mirrors the inbound scan, which did not change.
- **Not changed:**
  - an embed among other text (still `{{embed [[Title]]}}`);
  - an embed whose target has no name that reads back;
  - Duplicate and template copies, which write ids raw.
- **Tests, shown red on main for the written form:**
  - two unit tests in `markdown_source_tests.rs`;
  - four round trips in `tests/commands/obsidian_embed_tests.rs`: export → import, buffer → save, copy → paste, mirror file → re-import;
  - a `document-lines.vectors.json` row for an embed with no name, written as stored;
  - two embed blocks added to the `markdown_documents` fixture's page.

  The two vector and fixture additions were re-authored with `CONFORMANCE_UPDATE=1`, and the reformatting the re-author left on every other fixture was restored.
- **Falsified:** dropping the read-back check, writing unnamed embeds, and dropping the `ReadBack` call each turned the predicted tests red.
- **Docs:** `editor-and-content.md` (the Document-form row and the `Names` bullet) and `import-export.md` (the export's embed line).
- **Ran:**
  - `cargo fmt --check`, `cargo clippy --workspace --all-targets -D warnings`, and `cargo nextest run --workspace` in two partitions;
  - vitest over `src/editor`, `src/lib/tauri-mock`, the name-tokens and conformance tests;
  - `npm run typecheck` and `npm run lint`;
  - `scripts/e2e-related.sh`, which picks no Playwright spec. The WebdriverIO specs it picks (`@markdown @pages`) need the native build and did not run.
