# Session 1812 — markdown source mode, phase 3b

Phase 3b of #5140 moves the system clipboard to the Rust grammar:
- copy and cut in block-select mode;
- the three context-menu copy rows;
- paste in block-select mode, HTML paste, and a new route for an outline pasted into an editor.

I re-planned it against the code before building; the re-plan comment on #5140 has the twelve changes from the 08:32 plan.

**Today's defect.**
- The TS path wrote each block's content verbatim, one line per block, and pasted it back with `parseIndentedMarkdown`. So a multi-line block, such as a code block, came back as one block per line.
- Every paste lost task state, priority, dates, list style and properties.
- A copied block ref humanised to `((Name))`, which paste couldn't resolve.
- Paste committed one batch per depth level, so a failure part-way left a partial paste.

The new Playwright specs show two of these on the old code. A two-line code block pasted back as four blocks. A parent pasted into an editor lost its child.

**Backend.**
- **`get_blocks_source`** renders the chosen blocks in a new `RenderMode::Clipboard`. It is the source grammar with humanised names and raw block refs, and no `^ID` anchors. A block keeps its anchor only when the anchorless bullet wouldn't read back: it leaves a fence open, its content ends in ` ^word`, or it ends in a blank line. The render→parse proptest now runs in both modes.
- **`paste_blocks`** runs in one transaction:
  - `parse_pasted_text` reads the input as an outline when its first non-blank line is a `- ` bullet, and otherwise as one block per line by indentation. A tab counts as one level.
  - The importer's resolve-or-create resolvers turn names into refs. They now take a narrow `NameCtx`; import is unchanged.
  - 3a's helper creates the blocks. It is renamed `create_parsed_blocks`, and now places the k-th top-level block at slot + k; before, every root got the same slot.
  - Properties are written with 3a's `copying` rule.
  - The reply lists the pages and tags it created first, then the pasted blocks.
- **The op cap is counted as written,** against the same 1000-op limit, so `planned_ops` and its second copy of the stamp rules are gone (#5153 review note).
- **The capability** now grants `clipboard-manager:allow-read-text`, so block-select paste reads through the plugin instead of the unverified `navigator` fallback.

**Frontend.**
- **Copy.** Every copy path awaits `flushActiveDraft()`, reads `get_blocks_source` and writes the clipboard. "Copy block content" leaves out children. Cut removes only after the write succeeds.
- **Paste.** The paste reducer makes one IPC and records one undo entry. It tells the pickers about created pages and tags in the space captured before the IPC (#4338, #4391). The resolve cache has no per-space setter, so, as before, it seeds whichever space is live.
- **HTML paste** sends structured blocks, so the newline sentinel is gone.
- **Outlines into an editor.** Text whose first line opens with `- ` goes to the block path, even a single copied block. A lone task line stays with TaskPaste, and a lone `-` is just a dash. The route was first built to accept `*`, `+` and numbered lists too, but the backend reads only `- ` as a bullet, so it was narrowed to match.
- **Deleted.** `block-clipboard.ts`, `paste-internalize.ts`, `outlineToIndentedMarkdown` and their tests: about 1.2k TS lines.

**Conformance.**
- `paste_blocks` is pinned by a backend-authored fixture. It covers an outline with a continuation line and a child, two roots landing in order, plain lines, a multi-line `Blocks` item, and three refusals.
- `get_blocks_source` takes `get_page_source`'s waiver (#5071).

**Review.** An independent reviewer found no blocking defect. The copy→paste round trip held across every edge shape it tried, including:
- an empty or whitespace first line;
- a lone fence line, and a child under an open fence;
- marker-shaped and anchor-shaped lines;
- trailing blank lines and a trailing ` ^word`.

It also confirmed the op cap counts the name pass, and that import is byte-identical. I fixed four of its findings before pushing:
- **Copy sends selection roots.** Copy used to send every selected id, so Ctrl+A then Ctrl+C on a page of more than 1000 blocks hit the id cap.
- **Copy refuses a line-broken property value.** A value with a line break would have silently corrupted on copy and paste, so copy refuses it, as Duplicate already does.
- **One copied block pastes as a block.** A single copied block pasted into an editor as the literal `- foo`, because the editor route needed two lines. It now takes any `- ` text except a single task line, which TaskPaste owns.
- **The space-less anchor branch now has a test.**

**Verified.**
- Rust: the workspace nextest filter `paste|blocks_source|duplicate|markdown|source|import|export|conformance` passes 615 of 615. The full workspace run passed everything but the fixture that was waiting on authoring. Clippy, rustdoc links and fmt are clean.
- Both conformance sides pass, with `paste_blocks.json` authored by the backend.
- vitest passes on every touched suite. The Playwright paste, clipboard and duplicate specs pass.
- `e2e-tauri/block-clipboard.e2e.ts` is unrun locally, because that lane needs a native build.
- Every new or changed test was reddened by a mutation against a copy.

**Named gaps.**
- A literal `#5` or `[[x]]` in pasted text still resolves or creates (#1484).
- External text ending in ` ^word` loses the word, because it reads as an Obsidian anchor.
- External text's `- 2024. Year` reads as an ordered item, and reserved-key lines such as `template::` are dropped.
- A markdown list followed by paragraphs, pasted as plain text, folds the paragraphs into the last bullet.
- Cut makes one undo entry per root.
- A paste's undo can merge with a flush edit inside the 500 ms window.
- A ref-declared key whose pasted value isn't a live id refuses the whole paste.
- A paste over 1000 ops (about 200–330 task blocks) is refused. After a cut, the source is already in the trash, and one Ctrl+Z on the source page restores it.
