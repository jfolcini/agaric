# Session 3101 — Paste, copy and MCP append read the Document dialect

This is #6190, steps 1, 2 and 4, including #5691 item P (the maintainer's D2 and D4). Since G3, Edit as Markdown reads and writes the line-split Document dialect. Paste, Agaric's own block copy and the MCP append tools still used the old outline dialect, and page-mode paste read Markdown with the editor's own parser.

**Changed:**
- **Paste.** `parse_pasted_text` reads `ParseMode::Document`, as text from outside.
  - `- x` and `* x` are bulleted blocks, `1. x` a numbered one, `+ x` a plain child of a list block, and `- [ ] x` a task.
  - A heading owns nothing.
- **Copy.** Agaric's own block copy (`render_clipboard_source`) writes Document and checks itself against the paste reader, so a copy pastes back as the same blocks. A proptest pins that round trip; its seed file is committed.
- **Page mode.** Paste reads through `parsePastedText`, the TS port of the paste reader, and gives each item its style. The mock's paste and copy follow, re-pinned by backend-authored fixtures and a `pasted` section in the Rust-authored vectors.
- **MCP.** `append_markdown` and `capture` read agent Markdown this way too. The description warns against appending `get_page_markdown`'s outline as it is: its `- ` items would each come in bulleted.
- **Fuzz target.** It covers the Document readers.
- **File import is unchanged.**

**Trap found in review:**
- Widening the single-line paste route sent a lone `3. foo` pasted after text through the block splice, which rewrote it as `1. foo`.
- A single list line now takes the block route only where the paste starts the block, as the backend's splice decides.

**A restart in the middle:** the container restarted mid-build. A continuation agent inherited the diff, finished it, and triaged the proptest seed it found. That seed was a half-finished copy writing an empty plain child as an indented `\` under a bullet; the final copy writes `+`.

**Not done here:**
- Step 3 retires the outline dialect. Duplicate, journal templates, the MCP page read and write tools, and `get_page_source` with `Dialect::Source` still use it.
- An HTML list paste still makes in-block lists rather than list-styled blocks.
- After text, block mode keeps a first pasted line's marker while page mode drops it.

**Red first:** each new behaviour was shown red with one command that backs up, traps a restore, mutates, checks `! cmp -s`, and runs. That covers:
- the paste mode;
- the copy layout;
- the mock's paste and copy;
- the TS reader;
- page-mode styles;
- the single-line route, at a block start and after text;
- the cross-page clipboard join.

**Suites:**
- nextest, the whole workspace, in partitions (7,238); clippy, the `SQLX_OFFLINE` check and fmt;
- vitest, the whole suite; typecheck, lint and knip; the manual-stage hooks;
- Playwright, the whole lane. The 6 specs failing there fail on a clean checkout of main in this container.
- WebdriverIO on a native build: 10 specs, including paste-splice and block-clipboard.
- A Rust-against-TS differential over 52,000 paste inputs, with no mismatch.
