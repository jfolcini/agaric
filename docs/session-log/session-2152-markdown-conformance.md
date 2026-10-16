# Session 2152 — the markdown commands pinned by conformance (#5071)

Five commands were left unpinned because the row token grammar cannot carry a markdown document: `#` is the token's attribute separator. They were `export_page_markdown`, `get_page_source`, `get_blocks_source`, `import_markdown` and `import_bibliography`. The maintainer's decision (2026-10-08) was an out-of-band comparison against a backend-authored sibling file, not a TypeScript port of `render_page_markdown`, so the grammar keeps its one Rust implementation.

**Reads.** `document_result` in `conformance_query.rs` handles a render step.
- In update mode it writes the render to `<fixture>.<step>.txt`.
- Otherwise it compares the render with that file using `assert_eq!`, so a failure shows both documents.
- The step's row is `<file>#blake3=<hex>`, which goes through the usual expected-queries comparison. A hand edit of the `.txt` without re-authoring still fails.
- `export_page_markdown`, `get_page_source` and `get_blocks_source` all use it.

**Writes.** `apply_op_via_command` dispatches `import_markdown_inner` and `import_bibliography_inner`. Their `RETURN_SHAPE`s read the counts and ids and leave out `warnings`, which is prose that can contain `#`.

**The mock** cannot produce the backend's bytes without the port the decision rules out, so it does not compare documents.
- The three render steps are declared backend-only (`QUERY_STEPS_BACKEND_ONLY`), each with its reason.
- `markdown_imports` stays in `DRIFT_SKIP`. The mock's importers are labelled approximations: flat blocks, and a bibliography importer that parses nothing.
- The skip is not vacuous: un-skipping the documents fixture fails with "not wired in the TS runner".
- Both not-yet-pinned lists are now empty. The commands left them by being pinned, not waived.

**Fixtures:**
- `markdown_documents.json` is one page covering:
  - a heading, two levels of nesting and a two-line block;
  - inline marks;
  - a same-page block ref, a page link and a tag, applied through `edit_block` so `block_links` is derived as the app derives it;
  - front matter with a property, an alias and a tag;
  - a block attachment and a page attachment.
- It comes with three sibling documents.
- `markdown_imports.json` spells its inputs as multi-line content:
  - an `import_markdown` input with front matter, a section heading over three nested levels, a continuation line, a checkbox, a link, a tag and a property;
  - an `import_bibliography` input with two BibTeX entries and a repeated key, which gets skipped.

**Falsified** on copies:
- Swapping two sections of `render_page_markdown` fails the export step, showing both documents.
- Capping import depth in `push_block`, or dropping the `journal` field from the bibliography importer, fails the imports snapshot.
- Removing a command from the backend-only list, or the bibliography op from the fixture, fails `conformance-coverage.test.ts` naming that command.

Ran:
- `cargo nextest run --workspace -E 'test(conformance)'` (107);
- `cargo clippy --workspace --all-targets -- -D warnings`;
- `cargo fmt --check`;
- `npx vitest run src/lib/tauri-mock` (1134 passed, 3 skipped as above);
- `npm run typecheck`;
- `oxlint`, `oxfmt --check`.
