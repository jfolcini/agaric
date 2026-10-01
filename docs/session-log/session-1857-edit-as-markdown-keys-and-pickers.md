# Session 1857 — Edit as Markdown: the keyboard catalog's outline keys and the `[[`, `#`, `((` pickers (#5160 phase 5-6)

The buffer now takes the block editor's keys and pickers, acting on lines of markdown.

**What changed.**
- **Outline keys** (`src/editor/source-buffer-keys.ts`). These are the catalog's bindings by id, read through `matchesShortcutBinding` on each keypress, so a rebind in Settings → Keyboard is honoured. No new defaults (D-b).
  - **Indent and dedent.** `indentBlock` and `dedentBlock` (`Ctrl+Shift+→` / `←`) act on the line at the cursor, or on every line a selection touches. A selection ending where a line starts leaves that line out, as text editors do. Indent adds two spaces at the line start; dedent removes up to two leading spaces, or a tab.
  - **Tab and Shift+Tab** do the same while *Tab indents blocks* is on, the block editor's rule and its accessibility opt-out. With it off, Tab moves focus.
  - **Cycle a task.** `cycleTaskState` steps a list line through `nextTaskState`, the block editor's own list: none, `[ ]`, `[/]`, `[x]`, `[-]`, none. It writes the checkbox after the marker, nested lines included.
  - **Move up and down.** `moveBlockUp` and `moveBlockDown` move the line and its subtree (the lines after it indented deeper, blank lines between them included) past the sibling subtree above or below. A selection's sibling subtrees move together, and blank lines between the two units stay between them. A move does nothing at the top or bottom of its parent, nor into or out of the front matter, nor for a selection whose lines are not siblings.
- **Ids under these keys.** Indent, dedent and the cycle edit text past a line's start, so the start stays put and the line keeps its id. A move replaces the range with the same line nodes in the new order, in one step. Each replaced line's start is gone, so `lineIdsAfter` falls back to the id the line carries.
  - That is the simpler of the two options: no transaction meta, and no change to the id plugin. It holds under 5b's new cut rule too, which takes ids only for a `uiEvent: 'cut'`.
  - Undo inverts the one step, so order and ids come back together.
- **Pickers** (`src/editor/source-buffer-pickers.ts`). `[[`, `#` and `((` are the block editor's pickers: `createPickerPlugin`, `createSuggestionRenderer`, and `useBlockResolve`'s `searchPages`, `searchTags` and `searchBlockRefs`. A choice is written as text:
  - `[[Title]]` (full title; an alias match as `[[alias]]`; a `|label` typed before picking kept).
  - `#name`, or `#[[name]]` when the bare form would not read back as that tag. This is `tagText`, the export's `tag_reads_back_bare` probe, over `scanNameTokens`.
  - `((ULID))`.
  - *Create* writes the name as typed, and the save creates it.
  - `#` opens by the block editor's rule (`completedTag`): at a line start or after whitespace, never mid-word or on `#42`, and not in a fenced code block. A fence left open ends at the next line carrying an id (D5).
  - `[[` and `((` close once their brackets do, and `#[[` stays a tag.
  - The pickers run ahead of the buffer's keys (priority 1100), so an open picker takes Enter, Tab and Escape.
- **Escape with a picker open closes the picker, not the buffer.** `PageSourceBuffer` now skips keys ProseMirror already handled (`defaultPrevented`).
- **`Ctrl+Enter` no longer saves.** It is the catalog's `cycleTaskState`. The hard-coded `Ctrl+Enter` save alias left over from the textarea is gone, and `Ctrl+S` (`savePageSource`) saves.
- **The suggestion renderer drops `aria-multiline` while the editor is a combobox, and puts it back on exit.** axe's `aria-allowed-attr` refused it on the open picker, in the block editor too.
- **The hint says how to leave:** "Escape leaves the editor, asking first when you changed it." Tab no longer leaves the field, so this is WCAG 2.1.2's notice. Escape is the way out, as 5a had it.
- **Docs.** keyboard.md has an *Edit as Markdown* table (Enter and Shift+Enter included), and the page-level rows moved into it. editor.md and FEATURE-MAP describe the keys and pickers.

**Worth knowing:**
- **Binding conflicts** (D-b: reported here, defaults unchanged).
  - `cycleTaskState`'s `Ctrl+Enter` was also the buffer's save alias; the catalog binding won.
  - `Ctrl+Shift+←/→` (indent and dedent) shadow word-wise selection in the buffer.
  - `Cmd+Shift+↑/↓` on macOS (the moves) shadow select-to-document-start and select-to-document-end.
  - The block editor makes the same trades.
- The mock's source save models no task checkbox (`parseSourceBuffer` keeps `[/]` as text), so the `Ctrl+Enter` test checks the re-read buffer line, not `todo_state`.
- The pickers' search is not debounced, as the block editor's pickers are not. Tags come from a per-space cache, and pages from the cache up to two characters, then FTS. `useDebouncedCallback` cannot return the promise the Suggestion `items` callback needs.
- **Deferred to PR 7:** the shared toolbar, the parity test, the phone Save and Cancel, and the block-menu button.

**Verified.**
- **vitest: 604 passed** across `source-buffer` (33), the new `source-buffer-keys` (14) and `source-buffer-pickers` (12), `PageSourceEditor` (64), `PageEditor`, `suggestion-renderer`, `use-roving-editor`, `SuggestionList.keyboard-routing` and the i18n suites.
  - Before the keys were wired in, 13 of the 14 key tests were red. The one that passed is the front-matter no-op, which F11 below reddens.
  - Before the pickers and the `Ctrl+Enter` change, 6 `PageSourceEditor` tests were red.
- **Typechecks.** `npm run typecheck`, `tsc -p tsconfig.e2e.json` and `tsc -p tsconfig.wdio.json` are clean, and so is knip.
- **Playwright:** `e2e/page-source-edit.spec.ts`, 14 of 14 with `--workers=2 --retries=0`. The three new cases were run against a 5a build, and all three were red there: Tab indents and saves as a child, the move shortcut saves the order, and `[[` picks a page.
- **Falsification on copies** (restored and `cmp`'d):

  | Mutation | Red |
  |---|---|
  | F1 indent rebuilds the line, so the id rule drops its id | 4 |
  | F2 a move puts back fresh lines without ids | 7 |
  | F3 a move ignores the moved line's subtree | 2 |
  | F3b the sibling passed is its line alone | 1 |
  | F4 the cycle order wrong (DONE before DOING) | 3 |
  | F5 `#` opens mid-word (no tag rule) | 3 |
  | F5b `#` opens in a fenced code block | 1 |
  | F6a a tag always written bare | 5 |
  | F6b a page written by its leaf label | 2 |
  | F6c a block ref written by its text | 1 |
  | F6d a page written as `[[ULID]]` | 3 |
  | F7 the buffer acts on a key the editor took (an open picker's Escape cancels) | 1 |
  | F8 the combobox keeps `aria-multiline` | 2 |
  | F9 Tab indents with *Tab indents blocks* off | 2 |
  | F10 the move chord hard-coded, not the catalog's | 1 |
  | F11 a move enters the front matter | 1 |
  | F12 the `Ctrl+Enter` save alias back, acting even where the editor took the key | 1 |
  | F13 the pickers below the buffer keys | 3 |
  | F14 the keys not in the buffer | 16 |
  | F15 `[[` stays open after `]]` | 1 |
  | F16 a pick does not close its picker (`#` reopens) | 1 |
  | F17 a selection ending at a line start takes that line | 1 |

  Restoring the alias alone turned nothing red: with the `defaultPrevented` guard, `cycleTaskState` takes the key first, so the alias was dead code.
- **Bundle** (`vite build` + `check-bundle-budget.mjs`, all within budget), against a 5a build:
  - The startup `index` chunk went from 289749 to 290218 B gzip.
  - Startup in full (the entry plus every modulepreloaded chunk) went from 583605 to 583875 B gzip.
  - Rolldown regrouped the modules the buffer now shares with startup: `markdown-common`, `page-display` and `chevron-toggle` are their own preloaded chunks, and `useListKeyboardNavigation` is no longer one. The `editor` chunk (144036 B) is still not preloaded.
  - The lazy `PageSourceBuffer` chunk went from 5193 to 10825 B raw (2594 to 4701 gzip).
  - The picker plumbing moved out of `RovingEditorHost` (103185 to 86006 B raw) into a new lazy chunk, `block-link-picker`, that both import (17842 B raw, 6367 gzip).
