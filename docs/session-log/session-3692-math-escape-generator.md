# Session 3692 — the Markdown generators stop spelling foreign math (#6277)

The round-trip proptests in `markdown_source_tests.rs` and `markdown_document_tests.rs` could generate stored text holding `\(` or `\[` with its closer later on the line, e.g. `SCHEDULED: <2026-10-01> \(a \)`. A foreign read takes that as math (`normalize_foreign_inline`, #6033 S4) and reads `$a$`, so the round trip failed at random on unrelated PRs: Dependabot #6467's `cargo-tests (1)`, at `an_export_with_every_block_anchored_imports_as_its_tree`.

No writer stores that text. The editor writes `\(` only before `((ULID))` and never writes `\)`, and paste, import and the MCP append and update paths normalize the form. So the generators were wrong, not the app.

- **Existing-test edits (approved by the maintainer):**
  - `arb_line` (in `markdown_source_tests.rs`) and `arb_own_block_line` (in `markdown_document_tests.rs`) reject a line where `holds_foreign_math` finds the pair.
  - The filter sits on the line, not on `arb_word`, because the pair can span two words or a line prefix (`\`, `\[ ] `) and a word, and the math reader works per line. A lone escape is still generated.
- **New test:** `a_stored_latex_inline_span_reads_back_as_math` pins the intended foreign reading: stored `\(a\)` and `x \(a\)` export and read back as `$a$` and `x $a$`.
  - Red when the `\(` reader in `import.rs` is broken: it received `\(a\)`.
  - Not pinned: `a:: \(a\)`. Through parse and normalize it reads `\a:: $a$`, a reading this PR leaves open.
- **Reproduced:** with CI's seed added to the regression file and the filters off, the test fails exactly as on #6467 (`$a$` against `\(a \)`). With the filters on, it passes. The seed is not committed.
- **Ran:**
  - every `source_tests::` test, which includes `document::`;
  - `cargo fmt --all --check`;
  - `cargo clippy --workspace --all-targets -- -D warnings`.
