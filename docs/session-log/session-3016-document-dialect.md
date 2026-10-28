# Session 3016 — A Document dialect for Edit as Markdown's grammar, beside Source (#5691 G1)

Set out to build G1 of the line-split Markdown format: the Rust writer and reader for a `Document` dialect, following the maintainer's D1–D4. It is additive. Every Tauri command still passes `Source`, so the UI, the bindings and the mock are unchanged; G2 exposes the dialect.

**Shipped:**
- **`ParseMode::Document` on the shared `Scan`** in `agaric-engine/src/import.rs`, with `parse_document_outline` and `parse_document_text`. Every new branch sits behind a mode check, so Import, Source and paste read exactly as before.
- **`Dialect { Source, Document }`** in `commands/pages/markdown.rs`, with `anchor_free_as`, `get_page_buffer_as` and `apply_page_source_as`. The commands call these with `Source`.
- **The Document format:**
  - a blank line between blocks;
  - `- x` / `* x` read as a bullet and `1. x` / `1) x` as numbered;
  - a task is `- [ ] x`, a third list kind;
  - `+ x` is a plain child of a list block;
  - a `\` line is an empty block.
- **Both-kinds blocks.** A block with a task state and a list style is written as a task. Its hidden list style goes only when that block, or one of its property lines, is edited. Save with no edit appends no ops.
- **`conformance/document-lines.vectors.json`** is authored by a Rust test, for G2's TypeScript reader.

**Deviations from the design, accepted in review:**
- There is no `dialect` field on `SourceSaveFlags`. Struct literals of it sit in existing tests, so the dialect is a parameter instead.
- A first block starting `---` is written `+ ---`, so it cannot read as front matter. The `+` escape needs no reader change.
- A paragraph runs to the next blank line, so a heading, fence or `---` line under a paragraph continues it. This follows D1's letter, "no blank line stays one block", and the writer depends on it, because a fence is written verbatim. D1's rationale ("how import and paste already read Markdown") disagrees: Import and Source make each of those lines its own block. The question goes to the maintainer before G2 and G3 put it in front of users.
- An empty `1.` inside a list item starts a child, because its anchor-free line has no text.
- A task state with no checkbox marker is written as a plain line plus `todo_state::`, the only spelling that cannot read back as a bullet.

**Proofs:**
- Three proptests mirror the Source ones: render then read, the same with ids, and a byte fixpoint. A table test covers each row of the format.
- An apply test shows the page's own buffer saves as zero ops, including a both-kinds block.
- Review added a run of ten numbered items (the content column of `10. `) and a test pinning the property-line terms of the edit check. Each was shown red.
- Every escape and rule was shown red alone, eleven mutations in all.
- A differential against the base commit's reader and writer was byte-identical for Source, Import, paste, Clipboard, Agent, Export and subtree output, over 4,000 generated pages and 16,000 typed buffers.

**Suites:**
- the full nextest workspace in four partitions (7,204 tests);
- the markdown, import, page-source and document filter (545);
- conformance (99);
- clippy with `-D warnings`, `SQLX_OFFLINE` check, `cargo fmt --check` and `cargo doc`.
