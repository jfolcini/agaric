# Session 1829 — tasks on every surface (#5160 Phase 4a)

Phase 4a of #5160: decisions D6 (checkboxes everywhere) and D7 (Logseq/Org task syntax on import), rows P1, P2 and P9, and X11.

**What changed.**
- **Import reads checkboxes.** `- [ ]`, `[/]`, `[x]`/`[X]` and `[-]` become TODO, DOING, DONE and CANCELLED, as Source and paste already read them. The test that pinned "import reads no checkbox" is flipped.
- **Export writes them.** The four states are written as a checkbox; any other state still writes `todo_state::`. Export then Import keeps every state.
- **HTML-pasted task items get their state** instead of landing as `- [ ] text`. The Playwright spec now reads the state back over IPC.
- **Typing** `[ ] `, `[/] `, `[x] ` or `[-] ` at the start of a block sets the state, with or without the `- `. It stays text mid-sentence, in a later paragraph and inside a real list.
- **Import only (D7):**
  - Logseq/Org keywords become the state: TODO/LATER/WAIT(ING), DOING/NOW/IN-PROGRESS, DONE, CANCEL(L)ED.
  - `[#A]`–`[#C]` become the first, second and third option of the `priority` definition.
  - `SCHEDULED:`/`DEADLINE:` planning lines become the dates, and a repeater becomes `repeat`.
  - An unreadable planning line stays text, counted in one warning.
  - Typing and paste keep `TODO` as a word.
- **Export escapes** a first line that would read back as a keyword or cookie (`\TODO`, `\[#A]`), and a continuation line that would read as a planning line. So a round trip never invents a task.
- **The mock** reads checkboxes on paste and import. Two `paste_blocks.json` steps pin it.

**Review.** An independent reviewer ran the full suite and broke each claim on a copy (13 mutants, each turned a test red). It also probed Export → Import → Export over 20 task shapes; the result was byte-identical.
- **One wrong result, fixed:** the text after the cursor, split off by a paste that ends in a code block, was read as a task. It is verbatim again, as the mock already had it.
- **Worth knowing:**
  - With `todo_state` or `priority` options narrowed, a checkbox, keyword or cookie outside them fails the whole import. An explicit `todo_state::` line already did this. Phase 4b's D11 (a refused value stays text with a warning) covers it.
  - Export's `\TODO` and `\[#A]` show their backslash in Obsidian, Logseq and GitHub, which escape only ASCII punctuation. That is the price of Export → Import identity, the same shape as the `\key:: value` escape.
  - The planning-line escape also shows in the Source buffer and the clipboard, where nothing needs it.
  - Two planning lines each carrying a repeater keep the last one.

**Verified.**
- `cargo nextest run --workspace`: 6566 passed.
- Doc-tests: 10 passed. clippy and fmt are clean.
- vitest: 19536 passed across 851 files.
- The three typechecks are clean.
- Playwright: 194 passed across the 24 task, paste, import/export, Source and toolbar specs.
- The e2e-tauri spec (a Logseq import through the real backend) typechecks; CI runs it.
