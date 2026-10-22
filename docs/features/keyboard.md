<!-- markdownlint-disable MD060 -->
# Keyboard

Every action in Agaric is keyboard-reachable. The catalog below lists the shortcuts that ship out of the box; `src/lib/keyboard-config/catalog.ts` is the source of truth.

## Where to customise

Settings → Keyboard. Each row shows the action, then its current keys, then an edit button that opens a field for typing the new binding (`Ctrl + Alt + K`). A binding Agaric cannot read is flagged as you type; one that clashes with another shortcut is flagged on its row once saved. A customised row also has *Reset to default*, and *Reset all to defaults* resets every row. Customisations persist in local storage and propagate live to other open tabs / windows.

## What's not rebindable

- The **picker triggers** — `[[`, `@`, `((`, `{{`, `/`, `::`, `:` — are part of the editor's character grammar, not shortcuts. They can't be moved.
- A set of **structural** bindings always keeps a binding and offers no Record button: `Enter` (save block), `Escape` (leave the block), `Backspace` (merge / delete), `Shift+Enter`, the arrow-key block navigation and selection chords, `Ctrl+B` / `Ctrl+I`, and the History list's `j` / `k` / range-select.

## Editor & block operations

| Shortcut | Action |
| --- | --- |
| `Enter` | Split block at the cursor |
| `Escape` | Leave the block, keeping what you typed, and select it |
| `Shift+Enter` | Soft line break inside the current block |
| `Backspace` (at block start) | Merge into the previous block |
| `Ctrl+Shift+→` | Indent block (and any selected siblings) |
| `Ctrl+Shift+←` | Dedent block |
| `Ctrl+Shift+↑` | Move block up |
| `Ctrl+Shift+↓` | Move block down |
| `Tab` / `Shift+Tab` | Indent / dedent the focused block. On by default; turn it off with *Tab indents blocks* in Settings → Editor to get plain focus navigation back. Suppressed while a picker popup is open |
| `Ctrl+.` | Collapse / expand block children |
| `Alt+.` | Zoom in to the focused block |
| `Escape` | Zoom back out |
| `Ctrl+Alt+1` … `Ctrl+Alt+6` | Turn the focused block into a heading (level 1-6). `Ctrl+1` … `Ctrl+9` select tabs and `Alt+1` … `Alt+9` switch spaces (see **Global navigation**) |
| `Ctrl+Enter` / `Ctrl+L` | Cycle the block's task state |
| `Ctrl+Shift+P` | Open the **Property Drawer** for the block |
| `Ctrl+Shift+D` | Open the date picker (inserts a date at the cursor). The *due* and *scheduled* pickers are toolbar-only — they have no default binding |
| `Ctrl+Shift+Y` | Open block history |
| `Ctrl+Shift+J` | Duplicate block and its subtree, with its task state, priority, dates, list style and properties |
| `Ctrl+Shift+V` | Paste as plain text: the clipboard's lines go into the block as they are, with no blocks made and no markdown read |
| `Ctrl+Shift+L` | Turn block into another type |
| `Ctrl+Backspace` (on empty block) | Delete the block |
| `Alt+Enter` (on or beside a page link or block reference) | Follow the link, as a click does; in blocks and in page mode |

## Formatting marks

| Shortcut | Action |
| --- | --- |
| `Ctrl+B` | Bold (inside the editor; outside it the same chord toggles the sidebar) |
| `Ctrl+I` | Italic |
| `Ctrl+Shift+K` | Inline code |
| `Ctrl+Shift+S` | Strikethrough |
| `Ctrl+Shift+H` | Highlight |
| `Ctrl+U` | Underline |
| `Ctrl+Shift+C` | Code block (convert current block) |
| `Ctrl+K` | Add / edit external link on the selection (inside the editor; outside it the same chord opens the command palette) |

## Page-level (works inside or outside the editor)

| Shortcut | Action |
| --- | --- |
| `Ctrl+Z` | Undo (in-editor history when focused; page-level otherwise) |
| `Ctrl+Y` / `Ctrl+Shift+Z` | Redo |
| `Ctrl+Shift+E` | Export current page as Markdown |
| `Ctrl+Shift+G` | Show current page in the graph (local mode) |
| `Ctrl+E` / `Ctrl+Shift+M` | Switch the page on screen between editing blocks and editing it as one document ([page mode](editor.md#page-mode)); desktop only, and nothing where the switch is not offered |
| `Ctrl+Space` | In a block: leave it, selected, with the selection cursor (a focus ring) on it. With blocks selected and focus in the block list: add or remove the block under the cursor |
| `Ctrl+↑` / `Ctrl+↓` | With blocks selected and focus in the block list: move the cursor to the block above / below without changing the selection. `Shift+↑` / `Shift+↓` select a range from the cursor |
| `Ctrl+C` / `Ctrl+X` / `Ctrl+V` | Copy / cut / paste the selected blocks as a markdown outline, keeping their task state, priority, dates, list style and properties |

## Edit as Markdown

The buffer uses the block editor's bindings from the catalog, your rebinds included, on lines instead of blocks. No key changes which block a line keeps.

| Shortcut | Action |
| --- | --- |
| `Enter` | Split the line. On a `-`, `*`, `+`, `1.` or `1)` line, start the next line with the same indent and marker, numbered one up (a task goes on as `- [ ]`); on a line holding only its marker, remove it, ending the list |
| `Shift+Enter` | Split the line without continuing the list |
| `Tab` / `Shift+Tab` | Indent the blocks at the cursor or selection, each with its further lines and children, two spaces / remove up to two leading spaces or a tab from them; a top-level block stays where it is. Follows *Tab indents blocks* in Settings → Editor: turned off, Tab moves focus as usual |
| `Ctrl+Shift+→` / `Ctrl+Shift+←` | Indent / dedent, whatever the Tab setting |
| `Ctrl+Shift+↑` / `Ctrl+Shift+↓` | Move the line, with the lines indented under it, past the sibling above / below it; a selection moves the siblings it touches together. Nothing at the top or bottom, and nothing moves into or out of the front matter |
| `Ctrl+Enter` / `Ctrl+L` | Step the task of the block at the cursor: none, `[ ]`, `[/]`, `[x]`, `[-]`, none again |
| `Ctrl+S` | Save |
| `Escape` | Close an open picker; else close the buffer, asking first when it changed |

## Global navigation

| Shortcut | Action |
| --- | --- |
| `Ctrl+F` | Find within the current page (in-page find bar) |
| `F3` / `Shift+F3` | Next / previous in-page match |
| `Ctrl+Shift+F` | Open the **Search** view (find across pages) |
| `Ctrl+K` | Open the command palette (outside the editor); the header Search button opens the same palette |
| `Ctrl+O` | Open the quick switcher: the palette's page search, inside the editor too |
| `Ctrl+P` | Open the palette's commands, inside the editor too |
| `Ctrl+Alt+←` / `Ctrl+Alt+→` | Back / forward, as the header's arrows. The mouse's back and forward buttons do the same, for desktops that keep `Ctrl+Alt+←/→` for workspaces |
| `?` | Open the **Keyboard Shortcuts** panel |
| `Escape` | Close all overlays; clear selection |
| `Alt+1` … `Alt+9` | Switch to the Nth space (alphabetical) |
| `Ctrl+B` | Toggle the sidebar (only when focus is outside the editor) |
| `Ctrl+N` | Open the **New page** dialog (type a title, Enter creates; a blank title makes an Untitled page) |
| `Ctrl+T` | Open in new tab (desktop) |
| `Ctrl+W` | Close active tab (desktop) |
| `Ctrl+Shift+T` | Reopen the last closed tab, on its pages and at its place (desktop; each window keeps its recently closed tabs for the session) |
| `Ctrl+1` … `Ctrl+8` / `Ctrl+9` | Select the Nth tab / the last tab (desktop) |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous tab (desktop) |
| `Space`, `←` / `→`, `Space` | On a focused tab: pick it up, move it, drop it; `Escape` puts it back (desktop) |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | Zoom the whole interface in / out / back to 100% (desktop; the level is kept per device and shown in Settings → Appearance → Zoom) |
| `Ctrl+Alt+N` (`⌘⌥N` on macOS) | Open **Quick Capture**. A true global OS hotkey — fires even when the app is in the background. It is the first row of Settings → Keyboard, labelled system-wide |

## Journal

| Shortcut | Action |
| --- | --- |
| `Alt+←` | Previous day / week / month |
| `Alt+→` | Next day / week / month |
| `Alt+T` | Jump to today |

## List & history views

| Shortcut | Action |
| --- | --- |
| `j` / `k` | Move selection down / up (History view) |
| `Home` / `End` | First / last item (History view) |
| `PageUp` / `PageDown` | Page through the list (History view) |
| `Space` | Toggle selection on the focused row (multi-select lists) |
| `Enter` | Activate the selected item |
| `Shift+Click` | Range-select |
| `Ctrl+Click` | Toggle a single item in / out of the selection |
| `Ctrl+A` | Select all visible |

## Picker popups (when visible)

| Shortcut | Action |
| --- | --- |
| `↑` / `↓` | Move selection in the picker |
| `Enter` / `Tab` | Insert the highlighted result |
| `Esc` | Close the picker without inserting |
| `Backspace` (after a chip) | Delete the whole chip in one keystroke (retype the trigger to reopen the picker) |

The picker captures these keys *before* the block-keyboard handler sees them; that's deliberate.

## Customisation rules

- Bindings live under the `agaric-keyboard-shortcuts` local-storage key; clearing site data resets to defaults.
- The same shortcut can't be assigned to two actions in the same scope. Chords bound in *disjoint* scopes (`Ctrl+B`, `Ctrl+K`) are not conflicts and aren't flagged.
- The structural bindings listed above always have a binding and can't be recorded over.
- Changes propagate to other open tabs immediately via a `storage` event.
