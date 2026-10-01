# Session 1854 — Edit as Markdown: a plain-text editor whose lines keep their blocks (#5160 phase 5-5a)

The textarea with a `^ULID` at the end of every bullet is gone. Edit as Markdown is now a plain-text TipTap editor whose lines carry their block ids out of sight, saved through phase 5-4's `line_ids`.

**What changed.**
- **The buffer** (`src/editor/source-buffer.ts`, `PageSourceBuffer.tsx`).
  - One `line` node per line, text only: no marks, no input rules, no node conversions. Each line has a `blockId` attribute, rendered as `data-block-id`.
  - It loads from `get_page_buffer`. A save sends the lines joined with `\n`, each line's id as `line_ids`, and `base_source = source`.
  - It is an accessible multiline textbox, styled like the old textarea. Stale, conflict and merge, the save report, `Ctrl+S`, the Cancel confirm and the `line N:` selection all still work.
- **Ids follow the start of their line**, one rule in an `appendTransaction`.
  - After any change, a line takes the id of the old line whose start it now begins with. A line that no start moved onto keeps the id it holds, unless another line holds that id.
  - So Enter keeps the id where the split text starts, and the new line has none. Joining two lines keeps the first line's id (D-e), and an empty first line gives way to the second.
  - A cut takes the ids of the line starts it removes. Pasted where a line starts, the first pasted line takes its own id when no line holds it. So a cut line pasted back is a move, and a copy is a new block.
  - Text from outside pastes as lines with no id, and a `^ULID` in it stays text (D-a). Copying gives `text/plain`, one line per line, with no ids.
- **Keys (X6, the 5a part).**
  - Enter on a `-`, `*`, `+`, `1.` or `1)` line continues the list with the same indent and marker, numbered one up, and a task line continues as `- [ ]`.
  - Enter on a line holding only its marker clears it, ending the list. A thematic break (`* * *`) is excluded.
  - `Shift+Enter` splits without a marker.
  - Undo is TipTap history at its normal grouping.
- **Drafts** are stored as `{ base, text, lineIds }`. An old `{ base, text }` draft is never loaded into the buffer (D-f). It shows read-only above the buffer with *Copy earlier edits* and a note, and stays stored until the buffer is edited, saved or discarded.
- **Lazy.** `PageSourceEditor` reaches the buffer only through `React.lazy`, with the Spinner while it loads.
- **The store** sends `lineIds`, and its tests now save by line ids. The backend's anchored path is untouched, for 5c.
- **e2e.**
  - `e2e/page-source-edit.spec.ts` is ported to the keyboard: triple-click a line, type, cut, paste, Enter.
  - A new spec edits a line, adds a bullet with Enter, moves a line by cut and paste, saves, and re-reads the blocks.
  - The e2e-tauri source helpers read and write lines with their ids (`pageSourceLines`, `setPageSourceLines`, `pageSourceButton`), and their five specs are ported.

**Rebased onto phase 5-3 (#5220, front matter).**
- The buffer opens with the page's front matter, its lines carrying no id. Nothing in the buffer special-cases it: a null-id line is text, and the id rule never gives it one.
- Two new vitest cases run against the real mock. One opens a page with aliases, finds the front matter first with null ids, and checks that saving it unchanged writes nothing. The other types an alias and edits a block, and checks the alias is saved and the one op is the block edit. Both were red against a mock buffer without front matter.
- The doc conflicts are merged keeping both sides.
- The Playwright spec's front matter alias case is ported to the keyboard, and its index-based assertions now skip the front matter.

**Worth knowing:**
- Enter at the very start of a line opens the empty line above, and the id stays with the text below. The text the block starts with is still on that line, so the save keeps it the same block.
- An id written directly on a line, without moving any line start, is put back by the rule. Only a paste (or `setContent`) gives a line a new id.
- Chromium reads a keyboard-moved selection into ProseMirror a moment late. The Playwright helpers wait for it (`moveSelection`) before a cut, paste or Delete, which would otherwise act on the old selection.
- The conflict dialog still diffs the anchored sources, so its list shows `^ID`s. 5c, which deletes the anchored path, is the place to change that.
- A line pasted from another page's buffer keeps its foreign id, and the backend saves it as a new block with a warning (D15). Stripping the id on paste is 5b.
- `.ProseMirror` sets a one-line `min-height` outside any CSS layer, so the buffer's `min-h-[50vh]` needs `!`. The buffer's classes are built in the shell: built in the lazy chunk, they split `class-variance-authority` into a new startup chunk.

**Verified.**
- vitest, after the rebase: `source-buffer` (33), `PageSourceEditor` (56), `page-blocks.page-source` (4), `PageEditor` (43), `page-source-apply` (54), `conformance` (183), `conformance-coverage` (26), `i18n` (115), `preferences` (49) and `page-source-diff` (8). That is 571 passed. `npm run typecheck`, `tsc -p tsconfig.e2e.json` and `tsc -p tsconfig.wdio.json` are clean, and so is knip.
- Playwright: `e2e/page-source-edit.spec.ts`, 11 of 11 with `--workers=2 --retries=0`. The e2e-tauri specs typecheck; they run in CI.
- Falsification on copies (restored and `cmp`'d). Every mutation turned tests red, across the 87 buffer and editor tests:

  | Mutation | Red |
  |---|---|
  | F1 a split copies the id (a held id is not dropped) | 15 |
  | F2 a join keeps the second id | 3 |
  | F3 `line_ids` read one line off | 49 |
  | F4 no list continuation | 15 |
  | F5 a cut leaves the id on the emptied line | 1 |
  | F6 a paste at a line start ignores the pasted id | 3 |
  | F7 copy uses ProseMirror's text serializer | 1 |
  | F8 foreign HTML parsed as HTML | 1 |
  | F9 an old-shape draft loaded into the buffer | 2 |
  | F10 the refused line not selected | 1 |
  | F11 the dirty check ignores ids | 1 |
  | F12 `Ctrl+S` not handled | 7 |
  | F13 the save sends no `line_ids` | 9 |
  | F14 no thematic-break exception | 1 |
  | F15 no history | 2 |
  | F16 history one step per keystroke | 1 |

- Bundle (`vite build` + `check-bundle-budget.mjs`, all within budget):
  - The startup `index` chunk went from 289745 B gzip on 85ac803d to 289732 B on this change alone, and 289749 B with phase 5-3 under it. The modulepreload set is unchanged, and the `editor` chunk is still not in it (144032 → 144036 B).
  - The lazy `PageEditor` chunk grew from 67679 to 69276 B raw, and is 69453 B with phase 5-3.
  - The new lazy `PageSourceBuffer` chunk is 5193 B raw, 2572 B gzip.
