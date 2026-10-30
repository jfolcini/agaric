# Session 3212 — The Source dialect is deleted

Part B of #6190's step 3. Part A (#6212, session 3190) moved Source's last production users to Document; this deletes Source itself, so every Markdown buffer the app writes or reads (*Edit as Markdown*, page mode's switch, paste, Duplicate, templates, the MCP page tools) has one grammar. Import and Export keep their own modes.

**What changed**
- **Engine:** `ParseMode::Source`, `parse_source_outline` / `parse_source_text` and `source_fence_opener` are gone; the fuzz target drops its Source call.
- **App:** `Dialect`, `RenderMode::Source`, `render_page_source` and the `get_page_source` command are gone. `get_page_buffer` and `apply_page_source` lose their `dialect` parameter, and the `*_as` Document functions take the plain names. `duplicate_block_as` folds back into `duplicate_block_inner`, and Duplicate's old-vs-new oracle goes with Source.
- **Mock:** the Source grammar and `parseOutline` are gone. `import_markdown` counts blocks with the mock's Document reader; it now drops the blank lines after a leading `# Title` too, as `strip_title_heading` does, so front matter after the title is still the page's.
- **Tests:** whatever pinned behaviour Document shares (front matter, `^ID` anchors, merge forks, line ids, fences, names) moved to Document, including the 20 corpus snapshots (key `source` → `document`) and about 40 `page_cmd_tests`; Source-only tests went. The converted conformance fixtures kept `expected` and `expected_ops`; only the buffer lines in `expected_queries` changed.

**Decisions and traps**
- **Changed expectations are layout, not regressions:** warning line numbers move by the blank line Document puts between blocks, and an indented reserved `repeat-seq::` line under a plain block keeps its indent as text (a plain block has no content column). It reads back escaped and an unchanged save writes nothing.
- **D4 (`+ ` for a plain child under a marked block) kept its pins** after the oracle went: writing `- ` there reddens the journal template test, three MCP Markdown tests, conformance and a Duplicate test. The builder's "nothing went red" was the fixpoint proptest alone.
- **The mock import is not the backend's Import reader.** A fenced code block under a list item counts one block more than the backend (Document makes the fence a child). `markdown_imports` stays in `DRIFT_SKIP`; the mock's header says so.
- **Old device-local drafts:** a stored Source draft still opens read-only with Copy and never reaches the Document apply; a draft marked `dialect: 'source'` is ignored.

**Red first**
- the buffer read as an import, no page properties read, depth always clamped, no Document checkbox (engine tests);
- the buffer rendered as an export (every moved render, name, anchor and vector test, the apply proptests, integration and conformance); merge keeping no fork; fewest-moves keeping one; no property lines written;
- the mock's merge fork, copied line and page layout (mock save tests and conformance);
- `+ ` written as `- ` under a marked block (the D4 pins above);
- the mock import with the blank lines after the title kept.

**Suites:** nextest over the whole workspace in two partitions (7331 run); clippy, `SQLX_OFFLINE` check, fmt, the bindings regeneration (no change); vitest over `src/lib`, `src/components`, `src/editor`, `src/stores`, `src/hooks`, `src/__tests__`; typecheck, lint, `prek --all-files` and the manual-stage hooks; Playwright `page-source-edit`, `page-mode-markdown-switch`, `import-export`, `block-duplicate`, `templates` and seven paste and clipboard specs. The whole Playwright and WebdriverIO lanes are CI's.
