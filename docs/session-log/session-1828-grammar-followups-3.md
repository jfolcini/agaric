# Session 1828 — grammar follow-ups from #5167–#5172

This PR batches the non-blocking review notes from the #5160 PRs merged in this sweep: the line-break split (#5169, #5172) and Phase 3a (#5171). Notes that touch the files Phase 3b is changing wait for it.

**What changed.**
- **`#\tHeading` is a heading in the editor too.** The Rust grammar, the mock, the page outline and block-type conversion already read it that way. A literal `#<tab>` paragraph is now escaped when written. The fix is in the editor rather than on import because Source stores what was typed: a tab typed there would otherwise still render as a paragraph.
- **`key::\tvalue` is a property line** on Import, Source and paste. One predicate, `split_property_line`, decides for all three and for the export escape, so stored text never turns into a property.
- **A paste with HTML but no plain text** into a table cell or list item no longer deletes the selection.
- **The backlink and trash rows are one line.** They render a line break as a space, like every other one-line preview. They also stop placing headings and tables inside a clamped row.
- **Import adopts an empty page only by its title**, exact or case-folded, never by an alias. Importing `Plan.md` no longer fills an empty `Roadmap` aliased `Plan`. Adopting a page no longer warns about the page's own aliases. The mock follows the same rule; the bot's review caught that it still adopted by alias.
- **The blur's parse memo keeps two entries**, so an indent or move parses twice instead of four times.
- **Smaller:**
  - The Source proptest generates `2.` and `42.` lines, which exercises the list-item interruption rule.
  - The list-ergonomics doc describes the current grammar.
  - editor.md names the paragraph-count trade.
  - An unreachable test branch is gone.

**Review.** An independent reviewer ran the full suite and broke every fix on a copy to confirm its test turns red.
- It corrected one false sentence in the new doc: `- p` then `\t\t- deep` is depth 1, a child of `- p`.
- It added the missing test for adoption by a case-folded title. Deleting that arm had turned no test red.
- Worth knowing:
  - A file exported by an older build with an unescaped `word::\t` continuation line now imports that line as a property.
  - The editor's inline property parse still wants a space after `::`.
  - Import trims an indented continuation line's leading spaces. This is older than this PR.

**Verified.**
- Every fix's test failed before its change and again when the fix was broken on a copy (restored, `cmp`).
- `cargo nextest run --workspace` passes 6557 tests.
- Doc-tests: 10 passed.
- clippy and fmt are clean.
- vitest: 19534 passed across 852 files.
- `npm run typecheck` is clean.
- 78 Playwright tests pass across the import/export, paste, table, backlinks, trash, markdown, line-break, Source and properties specs.
