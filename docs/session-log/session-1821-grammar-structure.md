# Session 1821 — grammar, phase 2a: one block grammar for import, Source and paste

Phase 2a of #5160. Import, Edit as Markdown (Source) and paste each had their own idea of which lines start a block. Only `- ` started one, and every other line was glued onto the bullet above, so a README imported as one block and an LLM answer as a few glued ones. The three Rust parsers now share one CommonMark-shaped grammar (decision D1), and the mock follows it. Phase 1's corpus snapshots (#5164) show every change as a diff; each was reviewed line by line.

**The rules** (one open-block stack in `parse_block_lines`):
- **Block starts.** `-`, `*`, `+`, `1.` and `1)` all start a block; `-<tab>` does too. A numbered item is stored as an ordered block, with its ordinal re-derived.
- **Nesting.** A line nests by its marker's content column (S7), so 2-, 3- and 4-space and tab outlines keep their tree. Depth is the stack size, which retires the old `indent / 2` depth and its misleading clamp.
- **Paragraphs.** A paragraph is one block and a blank line separates blocks (D2+D3). An indented or lazy continuation line joins its block.
- **Interrupting a paragraph.** Outside a list, a list item can start in the middle of a paragraph only if it is non-empty and, when numbered, starts at 1. This is CommonMark's rule, so hard-wrapped prose keeps a line like `2024.` or `42. That is all.` as text; before this change the number was silently lost.
- **Headings.** A heading is always its own block. Outside a list, a heading owns the blocks after it until the next heading of the same or a higher level (D16). A heading inside a list item owns nothing. The renderer writes every block as `- `, so Agaric's own output reads back unchanged.
- **Fences.** ```` ``` ```` and `~~~` fences need three or more characters and close only on the same character in a run at least as long (S4). Nothing inside a fence is a bullet, heading, property or anchor, including a `- ` line in a column-0 fence (S5).
- **Unclosed fences.** In import and paste an unclosed fence ends with its list item, as CommonMark reads it. In Source it stops at the next bullet carrying a block anchor, with a warning (D5).
- **Paste.** Paste uses the same grammar and no longer has its one-block-per-line fallback (S3).
- **Import titles.** Import drops a leading `# Title` equal to the title derived from the file name, so Export All → Import round-trips (S6).
- **Renderer escapes.** The renderer escapes every line shape whose meaning the grammar changed: any list marker, headings, fence openers of either character, and `key:: `. This now goes through one engine predicate; the app's copy is deleted.

**What stays pinned.** `CORPUS_FINDINGS` drops S1–S7. The front matter a Source buffer would read as blocks stays S8 (Phase 5).
- One test flips as D5 decided. `- ```\n- interior\n```` used to fold into one block through a one-line peek (#2866); it is now three blocks, as CommonMark reads it.
- Six `codeFenceCases` name-rule vectors flip to the new fence reading.
- The mock pins D16 in a unit test, because the fixture harness can't carry `#` in content.

**Review.** An independent reviewer probed about 120 content shapes, each placed as a block with a child and a sibling. It also probed a 60-deep mixed tree, the clipboard round trip, the D5 rule through a real save, the title drop (CRLF included), mock parity over the whole corpus, and 20k-line documents (import 43 ms).
- **No existing page reads back differently, and no clipboard tree pastes back differently.**
- **It deleted the import warning about list-like lines kept inside a fence.** Under CommonMark the fence decides, so the warning fired on every correct reading.
- **It fixed a flaw in the loss property's own check:** the check read tabs as spaces in every mode, although only import does.
- **It fixed three mock tests** still pinning the old import.
- **It corrected the mock's handling of NBSP indentation and its title match.**
- **It restored the escaped characters in the reference vectors,** which the builder's tooling had turned into literal invisible characters.
- **It found the paragraph-interruption loss above,** fixed here with a test that went red first on all three parsers and the mock.

**Left open** (not losses, noted for later):
- `- - -` and `* * *` read as bullet text rather than as horizontal rules.
- A column-0 closing fence under a list item ends the item, as CommonMark and GitHub read it.
- Import still drops blank lines inside fenced code and turns tabs in code into spaces. That predates this change and is next on the list.

**Verified.**
- Every new grammar test was red on the old parser: 16 of 16, plus the interruption test on all three parsers and the mock.
- Mutants on copies, each restored and `cmp`-checked, were all killed: headings, fence length, the Source anchor rule, the title strip, heading escapes, the mock's markers, and each clause of the interruption rule.
- Full suite, run by the reviewer before the interruption fix:
  - `cargo nextest run --workspace` passed in parts: app library 1210, app integration 1520, other crates 3805.
  - Clippy and fmt are clean.
  - vitest passed across every directory.
  - Seven Playwright specs that paste or import through the mock passed 46 tests.
- After the fix, the import, markdown, Source, clipboard, paste and conformance tests passed 467 of 467. Clippy and fmt are clean.
