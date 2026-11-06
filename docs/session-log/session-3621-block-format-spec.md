# Session 3621 — the block format spec (#6277 E6)

`docs/architecture/editor-and-content.md` § Storage format and § Custom serializer now spec the block format as main writes and reads it, after #6277's E2 and E4.

- **Storage format** covers three things:
  - the stored content of one block: marks, tokens, in-block constructs, escapes, and the backend's readers of it;
  - the Document form, as a table of construct, what is written and what is also read;
  - the `LogseqOrg` dialect, whose outline reading moved here from `docs/features/import-export.md`.
- **Custom serializer** covers who owns each part:
  - the editor;
  - the Rust readers (`parse_markdown_file`, `read_pasted_text`, `parse_document_outline` / `parse_document_text`, `parse_logseq_markdown`) and the writer, with its `Names` / `Anchors` policies and which surface uses which;
  - HTML paste;
  - the TypeScript and mock mirrors;
  - the vector, fixture, corpus and property-test files that pin them, each named by path.
- **Removed as false:**
  - "the only backend interaction with the content format is the FTS strip";
  - "the full grammar is parsed by the FE serializer";
  - "one block = one top-level construct (… list item …)";
  - the fixed callout type list;
  - `rejected.md`'s "the custom serializer is FE-only".
- **Describes main, not the plan:** embeds, block refs in buffers, ref-typed values, heading links and block attachments are written as main writes them. #6277's F1–F4 and G3 change those.
- **HTML paste** is described in one subsection (`### HTML paste`), so #6277 E5, which makes it send Document text, rewrites it in one place.
- **Review:** an independent accuracy review checked every claim against the code. It found three false ones, all fixed:
  - `markdown_imports.json` runs a Markdown and a bibliography import, not two dialects;
  - the editor writes a callout type upper case;
  - an export names an embed's target.
- **Ran:** `npx markdownlint-cli2` and `prek run --files` on the changed files.
