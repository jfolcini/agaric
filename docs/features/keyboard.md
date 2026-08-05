<!-- markdownlint-disable MD060 -->
# Keyboard

Every action in Agaric is keyboard-reachable. The catalog below lists the shortcuts that ship out of the box; `src/lib/keyboard-config/catalog.ts` is the source of truth.

## Where to customise

Settings → Keyboard. Each entry shows its current binding and a "Record" button. Conflicts surface inline as you record. Resetting an entry restores its default. Customisations persist in local storage and propagate live to other open tabs / windows.

## What's not rebindable

- The **picker triggers** — `[[`, `@`, `((`, `{{`, `/`, `::`, `:` — are part of the editor's character grammar, not shortcuts. They can't be moved.
- A set of **structural** bindings always keeps a binding and offers no Record button: `Enter` (save block), `Backspace` (merge / delete), `Shift+Enter`, the arrow-key block navigation and selection chords, `Ctrl+B` / `Ctrl+I`, and the History list's `j` / `k` / range-select.

## Editor & block operations

| Shortcut | Action |
| --- | --- |
| `Enter` | Split block at the cursor |
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
| `Ctrl+Alt+1` … `Ctrl+Alt+6` | Turn the focused block into a heading (level 1-6). Not `Ctrl+1`…`Ctrl+6` — those are reserved for switching spaces (see **Global navigation**) and are a no-op while a block is focused, same as any other digit chord typed into the editor |
| `Ctrl+Enter` | Cycle the block's task state |
| `Ctrl+Shift+P` | Open the **Property Drawer** for the block |
| `Ctrl+Shift+D` | Open the date picker (inserts a date at the cursor). The *due* and *scheduled* pickers are toolbar-only — they have no default binding |
| `Ctrl+Shift+Y` | Open block history |
| `Ctrl+Shift+J` | Duplicate block (and its subtree) |
| `Ctrl+Shift+T` | Turn block into another type |
| `Ctrl+Backspace` (on empty block) | Delete the block |

## Formatting marks

| Shortcut | Action |
| --- | --- |
| `Ctrl+B` | Bold (inside the editor; outside it the same chord toggles the sidebar) |
| `Ctrl+I` | Italic |
| `Ctrl+E` | Inline code |
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
| `Ctrl+Space` | Toggle the focused block's selection |
| `Ctrl+C` / `Ctrl+X` / `Ctrl+V` | Copy / cut / paste the selected blocks |

## Global navigation

| Shortcut | Action |
| --- | --- |
| `Ctrl+F` | Find within the current page (in-page find bar) |
| `F3` / `Shift+F3` | Next / previous in-page match |
| `Ctrl+Shift+F` | Open the **Search** view (find across pages) |
| `Ctrl+K` | Open the command palette (outside the editor) |
| `?` | Open the **Keyboard Shortcuts** panel |
| `Escape` | Close all overlays; clear selection |
| `Ctrl+1` … `Ctrl+9` | Switch to the Nth space (alphabetical) |
| `Ctrl+B` | Toggle the sidebar (only when focus is outside the editor) |
| `Ctrl+N` | Create a new page |
| `Ctrl+T` | Open in new tab (desktop) |
| `Ctrl+W` | Close active tab (desktop) |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous tab (desktop) |
| `Ctrl+Alt+N` (`⌘⌥N` on macOS) | Open **Quick Capture**. A true global OS hotkey — fires even when the app is in the background. It lives in Settings → General, not the Keyboard tab |

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
