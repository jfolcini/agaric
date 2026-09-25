# Session 1823 — grammar, phase 2c: a line break inside a block

Phase 2c of #5160 (D2, X1). Since Phase 2a (#5165) the Rust parsers read "a paragraph is a block; a single line break is a line inside it". The editor still read a stored `\n` as two paragraphs, so the next blur after a typo fix split the block into siblings. It also pulled a stored `key:: v` line out as a property and folded a stored `- [ ] x` into a checkbox, although the user had typed neither. The editor now agrees with the parsers.

**The change.**
- A stored `\n` inside a paragraph is a hard break, and a hard break writes back as `\n`. The legacy backslash-newline reads as one too. Sibling paragraphs are separated by a blank line.
- The blur classifies only what the edit added. A block splits when the edit added top-level blocks. A `key:: value` line becomes a property only when its key is new, and a leading checkbox folds only when the loaded text had none. The baseline is the text the editor loaded, read before the unmount resets it. It is used at all three blur call sites, the debounced commit and the eight restructure handlers.
- A block at rest renders the break.
- The formatting toolbar has a "New line" button (Shift+Enter) for phones. It survives the phone-width overflow.
- The seven X1 rows in `block-content.vectors.json` are plain edits now.

**Decisions the plan didn't cover.**
- A blank line right after a paragraph separates it from the next. Any other blank line is an empty paragraph. This is the serializer's exact inverse; the fixpoint property found the case that needed it.
- A loaded `status:: todo` line whose value is edited stays text. Only a new key is extracted.
- Paragraphs inside a list item are separated by an indented blank line.
- `> a\n> b` is one quoted paragraph with a break.

**Left as is.** Duplicate, copy and Edit as Markdown still don't see a draft that introduces a property line, a split or a task marker. Committing it before the unmount would strip or split the stored text while the editor still shows the unclassified text. With the new baseline, a block loaded with `key:: v` no longer pauses the debounced commit, so the gap is narrower than it was. The scope note is in `active-draft-flush.ts`.

**Review.** An independent reviewer ran the full suite and probed stored content, the blur rule, the interaction with 2b's paste splice, and the toolbar.
- **A defect, fixed:** a focus and blur with no edit rewrote every stored two-paragraph block as one paragraph with a break. Paragraphs out of the editor carry the schema default `todoState: null`, and the serializer's plain-paragraph check wanted no attribute at all. It now reads the attribute by truthiness, as the task prefix does. A vitest and a Playwright test failed on the old check.
- Two 2b tests had pinned the old meaning: a splice tail spelled `here\nnext line` for two paragraphs, and a caret helper that skipped hard breaks. Both now follow D2.

**Worth knowing.**
- The legacy marker still lands in the store at a few seams: an empty line inside a paragraph, a 2b splice fragment that starts or ends at a break, and two Shift+Enters in a row. The editor reads these correctly, and the next real edit rewrites them. Until then Source and export show a trailing `\`, which is CommonMark's own hard-break syntax.
- A blank line after a list, heading or fence reads as an empty paragraph. So a Source-authored block like `- b\n\na` gains one blank line on its first real edit, then stays put.

**Verified.**
- Every new test failed before its change, and each fix was broken again on a copy and restored with `cmp`.
- After the review fixes:
  - `npm run typecheck`, `typecheck:e2e` and `typecheck:e2e-tauri` are clean;
  - vitest passes every test file, 19458 tests;
  - the Rust vector and conformance tests pass (3);
  - 262 Playwright tests pass across the editor, paste, toolbar, mobile, list, Source, undo and import/export specs.
- `e2e-tauri/block-line-break-persist.e2e.ts` writes a two-line block through the real backend and reads it back after a page round trip. CI runs it.
