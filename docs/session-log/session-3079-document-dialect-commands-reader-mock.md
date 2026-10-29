# Session 3079 — The buffer commands, the TS reader and the mock speak the Document dialect

This is #5691 G2b. G1 (#6162) and G2a (#6175) built the line-split format's grammar in Rust (`Dialect::Document`). G2b exposes it and teaches the other two sides to read and write it. It is additive: every UI call site still passes `dialect: null`, which means Source. G3 flips the default.

**Changed:**
- **Commands:**
  - `get_page_buffer` and `apply_page_source` take an optional `dialect` (`source`, `document`, or null for Source). They wire it to `get_page_buffer_as` and `apply_page_source_as`.
  - MCP and Duplicate stay Source.
  - The bindings are regenerated. tauri-specta emits `Option<T>` as a required `T | null`, so three exact-payload test assertions gained `dialect: null`; nothing else in them changed.
- **TS reader:**
  - `parseDocument` (`source-buffer-document.ts`) ports the Rust scan rule by rule.
  - `readBlocks` and `blockAt` take a dialect, Source by default. The per-line Source helpers are not threaded, because where a Document block starts depends on scan state (open blocks, the blank line before, fences, the item column).
- **Mock:**
  - `get_page_buffer` and `apply_page_source` render and save the Document dialect.
  - A save writes list markers, task checkboxes and property lines the way the backend does:
    - a three-way diff of base, edited and current marks;
    - the backend's write order;
    - task state, priority and dates through their own commands, so undo reverts them;
    - a task's hidden list style dropped with an edit;
    - values typed by their definition;
    - a refusal before any write.
- **Conformance:** `apply_page_source_document.json` is new, 11 steps whose `expected` the backend authors:
  - an unedited save appends no op;
  - a text edit, a restyle, a ticked and an unticked checkbox;
  - property line edits, empties and additions;
  - a stale merge;
  - a refused priority that writes nothing;
  - new lines with markers.

  Every other fixture is byte-identical.

**Red first:**
- **The command ignoring `dialect`:** the Rust apply arm and query arm and the mock's `grammarOf` each fail the fixture.
- **The mock's reader missing an escape:** 8 vector rows fail.
- **`readBlocks` treating a heading under text as a continuation:** the typed rows fail.
- **Review's fixture steps against the first mock:** all three conformance tests fail; the restyle was never written, so the next step's base is stale.
- **Review's further reds:** a lone-surrogate value, and the mock's own ids in anchored mode.

**Review found:**
- **Parity defect:** the mock's Document save wrote no marker, checkbox or property line, while the backend writes all three. The fix and the fixture steps are above.
- **Mock ids:** `MOCK…` and `BLOCK01` are not Crockford. So a page with an unterminated fence was refused on an unedited save in the mock. Anchored mode now takes an id predicate; Rust stays Crockford.
- **A quoted value with a lone surrogate:** `JSON.parse` keeps it, while serde_json refuses it and Rust keeps the text. TS now does the same.
- **Grammar check:** a differential fuzz of `parseDocument` against the Rust parse ran on about 260,000 buffers. A backend-authored render comparison covered about 5,300 random blocks. Neither found another divergence.

**A second review of the mock's write path** read it against the Rust apply path line by line and found four more divergences. Each was fixed with a backend-authored fixture step that was red before the fix:
- On a stale buffer that both sides edited, a marked block's fork lost its marks, and the buffer's marks landed on the page's block.
- A property changed differently on each side did not fork the block.
- A delete against a property-only change compared text alone.
- A ref line that named no page passed the pre-write check, then failed mid-save.

**Known differences**, listed in the mock's handler comment:
- D13 key folding;
- an empty `key::` line for a key the block does not hold;
- a number or boolean its definition refuses;
- page-level `key::` lines;
- number formatting at extreme magnitudes;
- error message text.

**For G3:**
- the Source-only editing helpers need a Document form;
- the commands' Tauri wrappers are covered only by an e2e-tauri round trip that sends `document`;
- the maintainer's fence decision stays: text right under a closing fence is in the code block, as vector case 5 pins.

**Suites:**
- nextest, the whole workspace (7,211 tests);
- clippy, `SQLX_OFFLINE` check and fmt;
- vitest, the whole suite (23,884 tests);
- typecheck, lint and knip;
- the manual-stage hooks;
- Playwright: the page-source, Markdown and page-mode specs (171).
