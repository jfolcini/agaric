# Session 4495 — the editor toolbar in groups: one Task group with a Date menu, rare inserts in More, rules that show

Part of the #7040 UI review, item S12's editor-toolbar part (maintainer decision 14, as corrected).

**What shipped**

- **The desktop bar** reads Format, Turn into, Link, Tag | TODO, Priority, Date ▾, Properties | Undo, Redo, More.
  - **One Date menu.** Insert date, Set due date and Set scheduled date were three bar buttons; they are one Date ▾ menu, each row with its glyph (`DATE_ICONS` from #7103: a flag for due, a calendar clock for scheduled) and its name. On a phone it is a sheet titled "Date" (Popover `sheetTitle`, as Turn into does).
  - **Rare inserts in More.** Block reference, Insert query, Emoji, Insert table and New line always sit in More on desktop (`IN_MORE` in `items.ts`, an `inMore` flag that `computeOverflow` honours before the bar is measured). Width overflow still works for every other button. A phone keeps New line on the bar (#5160): `buildToolbarItems` takes a `touch` option.
  - **Shortcuts stay learnable.** A row in More or the Date menu shows its shortcut with `Kbd` after its name (New line's Shift+Enter, Insert date's Ctrl+Shift+D), from the same lookup the bar's tooltips use, so a rebinding follows. It shows when `useKeyboardHints` is true, the gate the block menu's rows use.
- **Rules that show.** `Separator`'s `data-[orientation=vertical]:h-full` measured 0 px in the toolbar's flex row; it is `self-stretch` now. A rule needs a kept button since the last kept rule, so the group emptied into More leaves no double rule.
- **Edit as Markdown** shares the Date menu (`renderDateMenu` with the buffer's own actions) and the same More.

**Decided against**

- Math and footnote have no toolbar buttons, and code block lives in Turn into, so the issue's list for More shrank to the five inserts above (decision 14, corrected).
- The phone's `○ P` priority glyph stays: no clearer rendering exists to swap in.

**Tests**

- vitest: `items` (the Task group's order, the rare inserts in More, New line kept on touch), `FormattingToolbar` (two rules on desktop, three on touch; More holds exactly the five; the Date menu), `MetadataGroup`, `toolbar-config`, `shared` (a row's shortcut, hidden on touch until a keyboard shows itself), `PageSourceToolbar`, `source-toolbar-parity`, `page-toolbar`.
- e2e (mock lane): `toolbar-controls` (the 1440 bar, More's rows and New line's Shift+Enter, the Date menu's rows and Insert date's Ctrl+Shift+D), `phone-toolbar` (New line on a phone's bar; the Date sheet), and the rule's 16 px height.
- Shown red on the old sources and each under one mutation: the separator back to `h-full`, the Date menu without `sheetTitle`, Date after Properties, two date rows, Insert table out of `IN_MORE`, the touch exception removed, the old separator rule, the keyboard-hints gate removed.
- **Edited to the new bar:** `FormattingToolbar.test` (separator count, More always present, item count), `toolbar-config.test` (the metadata buttons split into task, date and metadata), `items.test`, `PageSourceToolbar.test`, `source-toolbar-parity`, `page-toolbar.test`, `locale-catalogs` (`toolbar.date` same as English in French), and the e2e `date-chip-editing`, `toolbar-and-blocks`, `toolbar-controls`, `toolbar-icons` (16 → 10 icons), `toolbar-touch-labels` (the desktop hover now reads Properties), `phone-toolbar`; the UI review tour shoots the Date menu and More.
