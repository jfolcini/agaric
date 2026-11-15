# Session 4215 — a `key::` line valued by a no-break space is text

`a_saved_buffer_renders_back_to_what_was_saved` failed on #6809's CI (run 43706129039), which does not touch Edit as Markdown: `"\t\t\t\t\t\u{a0}\u{a0}- \na::\u{a0}\n* \n"` (seed `cc 438e11e9…`).

Mechanism: `split_property_line` read the value as empty when `rest.trim()` was empty, a Unicode trim, but took a value only after an ASCII space or tab. So `a::\u{a0}` was a clearing `a::` line while `a::\u{a0} ^ID`, the line the render writes for a block ending in that text, was text and went unescaped. The buffer strips the anchor before reading, so the saved text came back as a cleared property. In the seed the first read keeps the line as text only because it sits left of its bullet; the render normalizes the indent.

Decision: whitespace other than a space or tab after `::` is no separator, so `a::\u{a0}` is text, as `a::\u{a0}x` already was and as the block editor's inline parser reads it (JS `trim` drops the no-break space, leaving no separator). Fixed in `split_property_line` and its editor mirror `splitPropertyLine` (`source-buffer-document.ts`); `inline-property-parse.ts` already agreed.

Tests: the seed in `proptest-regressions/commands/pages/markdown_source_apply.txt`, `a_no_break_space_after_the_colons_is_text` in `import.rs`, and a typed row in `markdown_document_tests.rs` that the regenerated `conformance/document-lines.vectors.json` carries to the editor's reader. All three, and the vitest vector case, were red before the fix. Ran: `cargo test` on `agaric-engine` `import::` and `agaric` `source_apply`/`markdown`/`property_line` (nextest is not installed in this session), vitest `src/editor`, `src/components`, `inline-property-parse`, workspace clippy.
