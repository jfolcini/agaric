# Session 1858 — Edit as Markdown: the block editor's toolbar and block menu (#5160 phase 5-7)

The buffer now has the block editor's toolbar above it, and its block menu behind a toolbar button. A parity test fails when an action of either has no buffer version and no reason for leaving it out (D-c).

**What changed.**
- **One action list.**
  - The toolbar's actions are read from its config: every button `buildToolbarItems` can show (the table ops included), and Format's marks.
  - The block menu's are `BLOCK_MENU_ACTION_IDS` (`block-context-menu/types.ts`). Every row of `BlockContextMenu` now carries its id, and the type requires one, so a new row needs an id.
  - `source-toolbar-actions.ts` answers each id. A toolbar button maps to what the buffer does for it. Format and Turn into map to the buffer's own popover. A block-menu row is listed as shown. Anything left out goes on an exclusion list with one line of reason. The parity test holds every id to one or the other, and fails an empty reason or an entry naming no action.
- **The toolbar** (`PageSourceToolbar`, in the lazy buffer chunk).
  - It is built from the block editor's configs, so the icons, labels, tips and priorities are the same, with each action swapped for the buffer's.
  - It sits on `ToolbarFrame`, which holds the overflow, the roving tab stop and the touch pinning. That frame was extracted from `FormattingToolbar`, and both toolbars use it.
  - Format and Turn into reuse the block editor's triggers, which take a `menu` now. The priority badge's renderer takes an `onCycle`.
- **The edits** (`source-buffer-blocks.ts`) act on the block the cursor is in. That is the block a line starts, or the one whose line starts the run of lines the cursor is in.
  - **Turn into** goes through the block editor's own `convertBlockContent`, with the export's `- 1.` or `- -` marker for the list style. A further line that a quote or fence leaves bare gets the export's `\` escape, and loses it inside a fence.
  - **Priority and dates** are the export's `priority::`, `due_date::` and `scheduled_date::` lines, written at the block's text column, before its children. The priority steps through `getPriorityCycle`.
  - Format wraps the selection in a mark's markdown, and a second press unwraps it. `[[` closes around a selection, and `((` and `#` open their picker on what follows them. Insert date writes `[[YYYY-MM-DD]]`, Insert query makes the block's text `{{query …}}`, Emoji writes the emoji, and Divider makes the text `---`.
  - Delete and Duplicate take the block's children along.
  - PR 6's indent, dedent, move and cycle commands now take an explicit line range, so the menu can aim them at a block.
- **The block menu** is `BlockContextMenu`, reused as it is.
  - Its actions are a `BlockActions` bag over the buffer's edits (`sourceBlockActions`).
  - A new `actionIds` prop shows only the rows the buffer has, so the excluded ones never appear.
  - A block the save has yet to create has no id. It passes `''` and has no Copy block reference row.
- **Phone (X9, D2+D3).** On touch, the pinned toolbar carries Cancel (the buffer's discard) and Save, both at priority 100. New line is raised to 100 so it stays visible at 390 px. The Cancel and Save row under the buffer is not shown there.
- **Docs.** editor.md describes the toolbar, the block menu, what is left out and why, and the phone bar. FEATURE-MAP is updated.

**Left out of the buffer, with the reasons the parity test holds:**
- **Toolbar:** Insert table and the table operations, because a table is its `|` rows. Properties, because the drawer would write the saved block behind the buffer.
- **Block menu:** Open link and Copy URL; the three content copies (select the lines and copy them instead); Merge (Backspace at a line's start already joins it); Collapse; Zoom in; History; Properties.
- Attachments stay out of the buffer (D-d), and neither the toolbar nor the menu has an attach action to leave out.

**Worth knowing:**
- **Indent and Dedent from the menu take the block's subtree along**, as the block editor's do. Tab and `Ctrl+Shift+→`/`←` still act only on the lines the selection touches (PR 6), so a child is left at its own column. I did not change the keys.
- **Insert tag types `#`.** The buffer's tag picker opens once a name starts (PR 6's rule), where the block editor's `@` opens at once.
- **Block actions on the toolbar** (TODO, priority, dates, Turn into) act on the block the cursor is in. `Ctrl+Enter` acts on the line the selection starts on, so on a block's second line the button works and the key does nothing.
- **The menu's `blockId` of `''`** reaches nothing. Every bag callback ignores it, and the rows that read it are left out for that block.

**Verified.**
- **vitest: 1211 passed across 32 files.** These are the new `source-buffer-blocks` (22), `source-toolbar-parity` (51) and `PageSourceToolbar` (27); `PageSourceEditor` (64), `FormattingToolbar` (68) with the group renderers, `BlockContextMenu`, the other buffer suites, `editor-toolbar`, `EditableBlock`, `useRovingTabindex` and i18n.
  - The new suites came after the code they cover, so the falsification below is what shows each one red.
  - The parity test is red when an implementation is removed, and when a toolbar button or a menu id is added without one (F4, F5a, F5b).
- **Typechecks.** `npm run typecheck`, `tsc -p tsconfig.e2e.json` and `tsc -p tsconfig.wdio.json` are clean, and so is knip.
- **Playwright:** `e2e/page-source-edit.spec.ts`, 18 of 18 with `--workers=2 --retries=0`. Four cases are new:
  - Turn into from the toolbar;
  - the block-menu button's Move Up;
  - on the 390 px phone, New line, Cancel and Save are on screen and Save saves;
  - on the phone, Cancel asks first.
- **Falsification on copies** (restored and `cmp`'d):

  | Mutation | Red |
  |---|---|
  | F1a the menu acts on the caret's line, not its block's | 2 |
  | F1b the menu acts on the line below | 4, and the e2e Move Up case |
  | F2a Set due date opens the scheduled picker | 1 |
  | F2b Block reference types `[[` | 1 |
  | F2c Turn into always writes `h2` | the e2e Turn into case |
  | F3 no Save on the phone bar | 3, and the e2e phone Save case |
  | F4 the emoji action removed | 3 (parity, the button list, Emoji) |
  | F5a a toolbar button with no buffer version | 1 (parity) |
  | F5b a block-menu id with none | 1 (parity) |
  | F6 an exclusion with a blank reason | 1 |
  | F7 the menu shows every row | 1 |
  | F8 Copy block reference offered for a new block | 1 |
  | F9 Bold written as `*` | 1 |
  | F10 menu Indent leaves the block's own lines | 1 |
  | F11 a rewrite drops the line's id | 9 |
  | F12 property lines at the bullet's column | 8 |
  | F13 the priority skips a step | 3 |
  | F14 Delete leaves the children | 1 |
  | F15 Duplicate inserts above | 2 |
  | F16 a mark never unwraps | 1 |
  | F17 no `\` escape on a bared further line | 1 |
  | F18 the block at the cursor does not walk up | 4 |
  | F19 a fence's lines start blocks | 2 |
  | F20 the frame never shows its overflow | 7 (`FormattingToolbar`) |

  F17 passed at first: the only escape case was a first line. A further-line case was added, and it went red.
- **Bundle** (`vite build` + `check-bundle-budget.mjs`, all within budget), against a build of PR 6 on this machine:
  - The startup set in full (the entry plus every modulepreloaded chunk) went from 1894099 to 1894943 B raw, and from 584983 to 585755 B gzip.
  - The `index` chunk alone went from 290228 to 296611 B gzip (the budget is 302082). Rolldown regrouped the startup chunks: `markdown-serializer` and `markdown-common` folded into `index`, and `useListKeyboardNavigation` and `storage` split out of it. The `editor` chunk is unchanged and still not preloaded.
  - The lazy `PageSourceBuffer` chunk went from 10850 to 27744 B raw (4677 to 11140 gzip).
  - The lazy `block-link-picker` chunk, which the buffer shares with `RovingEditorHost`, now also holds the toolbar frame: 17842 to 47594 B raw. `RovingEditorHost` went from 86006 to 57093 B raw.
