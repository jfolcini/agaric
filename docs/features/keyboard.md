<!-- markdownlint-disable MD060 -->
# Keyboard

Every action in Agaric is keyboard-reachable. The catalog below lists the shortcuts that ship out of the box. All shortcuts (except the five picker triggers) are user-customisable.

## Where to customise

Settings → Keyboard. Each entry shows its current binding and a "Record" button. Conflicts surface inline as you record. Resetting an entry restores its default. The customisations persist in local storage and propagate live to other open tabs / windows.

## What's not rebindable

The five **picker triggers** — `[[`, `@`, `((`, `/`, `::` — are part of the editor's character grammar. They can't be moved.

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
| `Ctrl+.` | Collapse / expand block children |
| `Ctrl+Enter` | Cycle the block's task state |
| `Ctrl+Shift+P` | Open the **Property Drawer** for the block |
| `Ctrl+Shift+D` | Open the date picker for `due_date` |
| `Ctrl+Shift+S` | Open the date picker for `scheduled_date` |
| `Ctrl+Backspace` (on empty block) | Delete the block |

## Formatting marks

| Shortcut | Action |
| --- | --- |
| `Ctrl+B` | Bold |
| `Ctrl+I` | Italic |
| `Ctrl+E` | Inline code |
| `Ctrl+Shift+X` | Strikethrough |
| `Ctrl+Shift+H` | Highlight |
| `Ctrl+Shift+C` | Code block (convert current block) |
| `Ctrl+K` | Add / edit external link on the selection |

## Page-level (works inside or outside the editor)

| Shortcut | Action |
| --- | --- |
| `Ctrl+Z` | Undo (in-editor history when focused; page-level otherwise) |
| `Ctrl+Y` | Redo |
| `Ctrl+Shift+E` | Export current page as Markdown |

## Global navigation

| Shortcut | Action |
| --- | --- |
| `Ctrl+F` | Focus the Search input (opens **Search** view if not active) |
| `?` | Open the **Keyboard Shortcuts** panel |
| `Escape` | Close all overlays; clear selection |
| `Ctrl+1` … `Ctrl+9` | Switch to the Nth space (alphabetical) |
| `Ctrl+B` | Toggle the sidebar |
| `Ctrl+N` | Create a new page |
| `Ctrl+T` | Open in new tab (desktop) |
| `Ctrl+W` | Close active tab (desktop) |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous tab (desktop) |
| `Ctrl+Alt+N` | Open **Quick Capture** (global OS hotkey — fires even when the app is in the background) |

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
| `Backspace` (after a chip) | Re-expand the chip to its source text for editing |

The picker captures these keys *before* the block-keyboard handler sees them; that's deliberate.

## Customisation rules

- Bindings are local-storage-keyed; clearing site data resets to defaults.
- The same shortcut can't be assigned to two actions in the same scope.
- A subset of "system" shortcuts can't be rebound to nothing — they always have a binding (e.g. `Escape`, `Enter` in the editor).
- The user-customised binding persists across reloads via a `storage` event so other tabs pick up the change immediately.
