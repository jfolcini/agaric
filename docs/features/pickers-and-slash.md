<!-- markdownlint-disable MD060 -->
# Pickers & Slash Menu

Inline pickers let you reference other content or insert structure without leaving the keyboard. All five are triggered by typing a single character (or pair) in the editor. The trigger characters are **not user-rebindable** (every other shortcut is).

## The five pickers

| Trigger | Picker | What it inserts | When to use |
| --- | --- | --- | --- |
| `[[` | **BlockLinkPicker** | A page-link chip pointing at the page or block you pick. | "Link to my project plan" / cross-reference |
| `@` | **TagPicker** | An inline tag-reference chip (e.g. `@urgent`). | Lightweight tagging inline in a sentence |
| `((` | **BlockRefPicker** | A *block reference* — embeds the contents of another block, kept live (edit-in-place). | Quote yourself; pull a definition into context |
| `/` | **SlashMenu** | Varies — task, date, structure, property, query, repeat-rule. See full catalog below. | Insert structure or quickly set metadata |
| `::` | **PropertyPicker** | Inserts `key::` text; selecting an existing key wires the value to the property system. | Set a custom property in flow |

All five popups share the same look (the `SuggestionList` component) and the same keyboard model: `↑ ↓` to move, `Enter` or click to pick, `Esc` to cancel. The popup positions itself near the trigger character and flips to stay on screen.

## How pickers match

- The query is what you type *after* the trigger character.
- Matching is fuzzy (`match-sorter`) — substring matches and reorderings count.
- Each row shows a short breadcrumb (parent page or namespace) when relevant, so you can disambiguate same-named pages.
- For `[[` and `@`, results are scoped to the active space. Cross-space targets are hidden.
- Pickers respect aliases — if a page has an alias, typing the alias matches.

## Slash menu commands

Typing `/` opens the SlashMenu. Categories (in display order):

Categories (fuzzy-matched as you type — the actual command IDs are short keywords, not literal strings; type a partial match):

| Category | Commands |
| --- | --- |
| **Tasks** | `todo`, `doing`, `done`, `cancelled`; priorities `priority-high`, `priority-medium`, `priority-low` (P1 / P2 / P3) |
| **Dates** | `date`, `due`, `schedule` — open the date picker for the matching property |
| **References** | `link`, `tag` — insert a page link or tag inline (sub-menu picker) |
| **Structure** | `h1`–`h6`, `quote`, `code`, `callout` (sub-menu: tip / note / info / warning / error), `table` (with dimension suffix, e.g. `table 4x6`), `numbered-list`, `divider` |
| **Properties** | `effort`, `assignee`, `location`, `attach` — sub-menus offer presets and a custom-value entry; `/property` opens **AddPropertyPopover** for any key |
| **Templates** | `template` — opens **TemplatePicker** to insert a template page's children under the current block |
| **Queries** | `query` — insert an `{{query …}}` block; opens the visual **QueryBuilder** |
| **Repeat rules** | `repeat` — sub-menu with `+` (default), `.+` (completion-based), `++` (skip-past-today) variants for daily / weekly / monthly / yearly. Custom intervals (e.g. `+3d`) are set directly in the property drawer or by editing the `repeat` property value. |

The repeat-rule mode semantics (`+` vs `.+` vs `++`) are explained in [journal-and-agenda.md](journal-and-agenda.md) → *Projected entries*.

## How to add a slash command

Add an entry to the matching category file under `src/hooks/useBlockSlashCommands/`, an i18n key under `slash.*`, and (if it does a novel operation) the handler.

## Pitfalls to know

- **The picker popup steals the next keystroke.** Once `↑ ↓ Enter Tab Esc Backspace` open the picker is visible, those keys go to the picker — not your block keyboard handler.
- **Type more to narrow.** If the picker shows too many results, keep typing — fuzzy match narrows in real time.
- **Cancel with `Esc`.** Clicking outside also cancels, but the click triggers blur — `Esc` is safer mid-edit.
- **`[[Project/Roadmap]]` works for nested pages.** Forward slashes are how the namespace hierarchy is encoded in titles; the picker shows the breadcrumb.
- **Cross-space cannot be linked.** If you can't find a page in the picker, check the active space — the picker filters to it.
