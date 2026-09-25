# Session 1824 — grammar follow-ups from #5162–#5166

This PR batches the non-blocking review notes from the #5160 PRs merged in this sweep. Two of them changed user content.

**Numbers inside a list item.** `- Numbers to remember:\n  42. That is all.` imported as an ordered child `That is all.`, which lost `42.` and re-exported as `1.`. The CommonMark interruption rule decides when a list-marker-looking line starts an item inside a paragraph: only a non-empty item, and an ordered one only when it starts at 1. The rule applied at the top level but not inside a list item. It now applies there too, in Import, Source and paste, and in the mock.
- An empty `-` at an item's content column still starts a block. Agaric's export and copy write an empty child that way, and the CommonMark reading would turn it into parent text.
- A check drove 31 block trees through render and parse, with lines like `2. x`, `- x` and `1.` in every position. Agaric's own output reads back to the same tree.

**Code survives Export → Import.** Import rewrote every tab as two spaces before parsing and dropped blank lines inside fenced code, so a round trip changed code. Tabs now stay as written; the indentation reader already counted a tab as a level. Blank lines inside a fence are kept. A comparison against the old behaviour on 27 tab-bearing shapes, Logseq's tab-indented outlines among them, gave the same trees. The only differences were the two intended ones: fence blank lines kept, and `-\t-` read as paste and Source read it. The mock's export now indents continuation lines under their bullet, as the backend does.

**Paste into a table cell or a nested list.** A paste that would make blocks there cut the table or list in two. It now pastes as plain lines, the Ctrl/Cmd+Shift+V path.

**Smaller fixes.**
- `paste_blocks`' rustdoc and editor.md claimed the block-start rule held in a heading. A heading's `## ` is text before the cursor, so the block keeps its type, and a test pins it.
- Doc comments now say what the fixpoint property and the lost-text oracle check.
- Two inert finding keys are gone from the reference-token vectors.
- The waiver path the review questioned was right: the citation guard resolves it from `src/`, and a repo-root spelling fails it.
- Spaced thematic breaks (`- - -`) stay as they are. A fix needs a new escape position in the renderer and a matching unescape, not a few lines.

**Review.** An independent reviewer ran the full suite and probed tabs, the interruption rule against everything Agaric writes, and a hard break in a table cell after Phase 2c.
- **A defect, fixed:** the table/list guard read only the plain text. So a heading or list item copied from a web page, one line of text with structural HTML, still split the table. The HTML path now takes the same literal route, and its test failed before the fix.

**Worth knowing.**
- Import now stores `#\tH` as written. Rust reads it as a heading, but the editor wants a space after `#`, so the block shows `#\tH` as text; paste and Source already did this. `key::\tvalue` is likewise not a property.
- The Source proptests never generate a `2.` line, so the interruption rule rests on its 13 Rust and 5 mock cases.

**Verified.**
- Every fix's test failed before the change. Each fix was broken again on a copy, and the file was restored and checked with `cmp`.
- `cargo nextest run --workspace` 6542 passed.
- Doc-tests 10 passed.
- vitest across all 847 files, 19403 passed.
- `npm run typecheck` is clean.
- 75 Playwright tests pass across the paste, import/export, Source, list and table specs.
- Clippy and fmt are clean.
- No conformance fixture moved.
