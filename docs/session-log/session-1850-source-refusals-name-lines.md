# Session 1850 — Edit as Markdown refusals name their line; multi-line property values fit the buffer (#5160 phase 5-2)

#5160 X3 and X5, plus follow-up note 108.

**What changed.**
- **A refused save names its line and selects it (X3).**
  - The parser records the buffer line each block starts on (`ParsedBlock::line`, source mode only, counted from the buffer's first line).
  - Every refusal about a block of the buffer starts with `line N: `: an anchor written twice (in a plain save and in a merge), an anchor naming no block of the page, two moved anchors in one block, a value its definition refuses, and the depth and op-cap limits, at the block where they were reached.
  - The editor reads the `line N: ` prefix off the message (`refusedLineRange`) and selects that line in the textarea. A structured field would have meant a new `AppError` shape across every command for one caller; the prefix travels through the existing envelope unchanged.
  - A lowercase `^id` is the block it spells: `restore_text_anchor` keeps a block id uppercase, as ids are stored.
  - After a merge, a block names its line in the buffer; a block only the page holds names none.
- **A multi-line property value fits the buffer (X5).** Export and import had no form for one (export writes it raw, which re-imports as content), so the buffer takes the YAML/JSON double-quoted string: a value with a line break, surrounding whitespace, or that itself reads as a quoted string is written `key:: "two\nlines"`; a quoted value in the buffer or a paste is decoded; every other value, backslashes included, is written and read as it is. Copy, paste and Duplicate go through the same render, so the copy refusal for such values is gone, Duplicate copies them, and a page holding one opens and saves.
- **Note 108.** No save count falls back to `u32::MAX`: `apply_block_properties` counts in `u32` (import widens it with `u64::from`), and the repeat-bound deletes are counted one by one.
- **Mock.** The mock's refusals carry the same `line N: ` prefix, and it reads a lowercase ULID anchor uppercase. `apply_page_source.json` gains a lowercase-anchor step both stacks pass.

**Worth knowing:**
- Line numbers count from the buffer's first line. When YAML front matter lands in the buffer (phase 5-3), its lines must be counted too, or every refusal names a line too early.
- The read-back refusal (`read_base`) still fires for a carriage return in a block's text, which splits the line; its test now uses one.
- A cap reached while deleting blocks names nothing: the deleted block is not in the buffer.
- Export still writes a multi-line value raw; X5 was scoped to the buffer.

**Verified.**
- Red first: the 14 new or changed Rust tests failed against stubs (no lines, no uppercase, identity writer, trim-only reader); 4 of the 5 new vitest cases failed against the original editor and mock (the fifth, a `null` case, failed under a mutation below).
- `cargo nextest run --workspace` over the parser, source, merge, copy, paste, duplicate and import tests, the conformance fixtures and the bindings check: 616 passed.
- clippy (`agaric-engine`, `agaric`, all targets, `-D warnings`) and `cargo doc` with the pre-push rustdoc lints are clean. No `.sqlx` or bindings change.
- vitest: `PageSourceEditor`, the mock's `page-source-apply`, `conformance`, `conformance-coverage`, `clipboard-source` and `duplicate-block` (307 passed), and the paste and import files that run the mock's outline parser (381 passed). `npm run typecheck` is clean.
- Playwright `e2e/page-source-edit.spec.ts`: 6 passed.
- Falsified on copies: dropping the writer's quoted-value check, the merge's buffer line, the merge's duplicate-anchor line, the line on a refused property write and the line on a refused create each turned its test red (two controls stayed green); in the editor, an off-by-one line, an unanchored `line N:` match and a missing selection each turned a test red, and the mock without the uppercase anchor failed its test and the conformance step.
