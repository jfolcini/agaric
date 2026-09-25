# Session 1825 — grammar, phase 2c part 1: a line break inside a block

Phase 2c of #5160 (D2, X1), first half. Since Phase 2a (#5165) the Rust parsers read "a paragraph is a block; a single line break is a line inside it". The editor read a stored `\n` as two paragraphs, so the next blur after a typo fix split a block from Source, import or paste into siblings. The editor now reads and writes a line break the way the parsers do.

The change was built and reviewed as one PR (#5167). The review bot timed out on it twice at its 30-minute limit, so the maintainer asked for a split. This half is the reading and writing. The second half is the blur rule: a blur only classifies what the edit added. That half also adds the phone "New line" button.

**The change.**
- A stored `\n` inside a paragraph is a hard break, and a hard break writes back as `\n`. The legacy backslash-newline reads as one too.
- Sibling paragraphs are separated by a blank line.
- A line that starts another construct (a list, a heading, a fence, a table, a quote) still ends the paragraph.
- A block at rest renders the break.
- A focus and blur with no edit writes nothing. The comparison is on canonical forms, so a legacy backslash-newline is rewritten only by the next real edit.

**Decisions the plan didn't cover.**
- A blank line right after a paragraph separates it from the next. Any other blank line is an empty paragraph. This is the serializer's exact inverse; the fixpoint property found the case that needed it.
- Paragraphs inside a list item are separated by an indented blank line.
- `> a\n> b` is one quoted paragraph with a break.

**The vectors.** The rows this half fixes flip to plain edits: two lines of prose, a line shaped like an anchor, and two trailing spaces before a break. The row "a second line shaped like a property" moves from a split to a property extraction. It keeps its X1 finding until the blur rule lands, because the blur still extracts a `key:: v` line it did not add.

**Review.** An independent reviewer ran the full suite on the whole change.
- **A defect, fixed:** a focus and blur with no edit rewrote every stored two-paragraph block as one paragraph with a break. Paragraphs out of the editor carry the schema default `todoState: null`, and the serializer's plain-paragraph check wanted no attribute at all. It now reads the attribute by truthiness, as the task prefix does. A vitest and a Playwright test failed on the old check.
- Two 2b tests had pinned the old meaning: a splice tail spelled `here\nnext line` for two paragraphs, and a caret helper that skipped hard breaks. Both now follow D2.

**Worth knowing.**
- The legacy marker still lands in the store at a few seams: an empty line inside a paragraph, a 2b splice fragment that starts or ends at a break, and two Shift+Enters in a row. The editor reads these correctly, and the next real edit rewrites them. Until then Source and export show a trailing `\`, which is CommonMark's own hard-break syntax.
- A blank line after a list, heading or fence reads as an empty paragraph. So a Source-authored block like `- b\n\na` gains one blank line on its first real edit, then stays put.

**Verified, on this half alone.**
- `npm run typecheck` is clean.
- vitest passes every test file, 19452 tests.
- 15 Playwright tests pass across the line-break, paste, HTML paste, nested-list blur and text-editing specs.
- `e2e-tauri/block-line-break-persist.e2e.ts` writes a two-line block through the real backend and reads it back after a page round trip. CI runs it.
