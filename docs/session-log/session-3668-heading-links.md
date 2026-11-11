# Session 3668 — a heading target is written by its heading (#6277 F4)

A ref to a heading whose text no other heading of its page shares is now written `[[Title#Heading]]`, as Obsidian users write it, and a whole-block embed of one `![[Title#Heading]]`; before, F2 wrote `[[Title#^ULID]]` or `[[#^ULID]]`.

- **Writer:**
  - `resolve_heading_refs` in `src-tauri/src/commands/pages/markdown_export.rs` reads the pages holding a heading target through the anchor pass's own `load_anchor_candidates`, and `unique_headings` in `markdown_import_anchors.rs` keeps a heading whose text, compared as `anchor_block` compares it (`normalize_heading_anchor`), no other heading of its page shares.
  - `heading_link_text` in `markdown_links.rs` refuses a text the link would not carry as written: one holding link, anchor, escape or inline markup syntax, `((`, or a `:`, which Obsidian leaves out of the heading links it writes. Such a heading keeps `#^ULID`.
  - The export (`Names::Always`) gets the form through `block_ref_replacement`; the buffer, the mirror's file, Copy blocks and the MCP read (`Names::ReadBack`) through `name_block_refs`, and F1's `as_obsidian_embed` writes the embed.
  - The titled form is written on the heading's own page too: an anchor-only `[[#Heading]]` names no heading once a copy or an agent's read lands under another page, where F2's global `[[#^ULID]]` has a block id to go by.
- **Readers:** import and paste already read `[[Title#Heading]]` (`link_cross_page_anchors`, `anchor_block`). The buffer save reads a held one back through `LinkMatches::anchored_block`, which now finds the snapshot's heading by its text (`LinkMatches::headings`); `humanise_refs_for_source`'s read-back check goes through the same reader, so a link it could not read back stays `#^ULID`.
- **Mirrors:** none changed. The mock writes no names.
- **Tests:**
  - `src-tauri/tests/commands/heading_link_tests.rs`: buffer → save (unchanged save writes nothing, an edited link saves as the ref), copy → paste under another page, the mirror's file → re-import (`merged == Some([])`), export → import, and a heading that gains a twin on its page is written by id from then on. The fixture holds a unique heading, a heading repeated in another case, a heading holding `:` and a unique heading on the ref's own page.
  - `an_appended_read_keeps_a_ref_to_a_heading_of_its_page` in `src-tauri/src/mcp/tools_rw/tests.rs`: an agent's read appended under another page keeps the ref.
  - `e2e-tauri/heading-link-obsidian.e2e.ts`: a ref to a unique heading reads as `[[Title#Heading]]` in Edit as Markdown and saves back, edited, as the ref.
  - Red first: the tests were committed before the change; main writes `[[Other#^ULID]]`, `[[Notes#^ULID]]` and `[[#^ULID]]` where they expect the heading.
- **Falsified**, each mutation in one command with a backup and a trap restore, each red on the predicted tests:
  - the writer's heading branch off: the buffer, copy, mirror, repeated-heading and MCP tests;
  - the export's replacement off: the export test;
  - the uniqueness check off (`>= 1`): every surface test;
  - `:` allowed in a link: the four surface tests that hold the colon heading;
  - the buffer reader's heading branch off: every ReadBack test, since the writer's read-back check then refuses the form.
- **Docs:** `editor-and-content.md` (the Document-form row and `Names`), `import-export.md`, `agent-access.md`, and the `get_page_markdown` description in `tools_ro.rs` with its insta snapshot.
- Not done: no `document-lines.vectors.json` row. The TS mirror and the mock write no names, so a vector row would pin nothing a test above does not.
- **e2e-tauri red on main:** scratch draft #6454 ran the spec alone on main: it failed at `heading-link-obsidian.e2e.ts:87`, which expected `[[…-page#…-heading]]` and received `[[…-page#^01M74C1MEXBATG7X57WYF3KSZ2]]` (job 130310608501). Closed.
- **Ran, on the merged head:** `cargo fmt --all --check`; `cargo clippy --workspace --all-targets -- -D warnings` (clean); the specta bindings check (`bindings.ts` unchanged); `cargo nextest run --workspace` in two partitions: 3867 and 3860 passed, 0 failed; `npm run typecheck`, `npm run typecheck:e2e-tauri`, `npm run lint`, `node --test scripts/e2e-related.test.mjs`. `just e2e-related` selects no Playwright spec and 61 WebdriverIO specs, which run in CI. No SQL changed beyond F4's one new query, whose `.sqlx` entry is committed.
