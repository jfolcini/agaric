<!-- markdownlint-disable MD060 -->
# Pickers & Slash Menu

Inline pickers let you reference other content or insert structure without leaving the keyboard. Each is triggered by typing a character (or pair) in the editor. The trigger characters are **not user-rebindable**; [Keyboard](keyboard.md#whats-not-rebindable) documents the other structural bindings that are fixed.

## The pickers

| Trigger | Picker | What it inserts | When to use |
| --- | --- | --- | --- |
| `[[` | **BlockLinkPicker** | A page-link chip pointing at the page or block you pick. | "Link to my project plan" / cross-reference |
| `@` | **AtTagPicker** | An inline tag-reference chip (e.g. `@urgent`). | Lightweight tagging inline in a sentence |
| `((` | **BlockRefPicker** | A *block reference* — embeds the contents of another block, kept live (edit-in-place). | Quote yourself; pull a definition into context |
| `{{` | **QueryPicker** | A single *Insert query…* item that opens the visual **QueryBuilder**. Type anything after `{{` and it yields to hand-written `{{query …}}` syntax with ghost-text completion. | Discover embedded queries without the slash menu |
| `/` | **SlashCommand** | Varies — task, date, structure, formatting, property, query, repeat-rule. See full catalog below. | Insert structure or quickly set metadata |
| `::` | **PropertyPicker** | Inserts `key::` text (plus a trailing space); type the value after it — when the block is saved (blur/focus switch), a line that is exactly `key:: value` is committed to the property system and stripped from the text. See [properties.md](properties.md) → Inline syntax. | Set a custom property in flow |
| `:` | **EmojiPicker** | The matching Unicode emoji, replacing the `:shortcode`. Needs at least two word characters after the colon and whitespace before it, so `3:30`, `http://` and the `::` property trigger stay dormant. Can be turned off in Settings → Editor. | `:tada` → 🎉 |

The popups share the same look (the `SuggestionList` component) and the same keyboard model: `↑ ↓` to move, `Enter` or click to pick, `Esc` to cancel. The popup positions itself near the trigger character and flips to stay on screen.

## How pickers match

- The query is what you type *after* the trigger character.
- Matching is fuzzy (`match-sorter`) — substring matches and reorderings count.
- Each row shows a short breadcrumb (parent page or namespace) when relevant, so you can disambiguate same-named pages.
- For `[[` and `@`, results are scoped to the active space. Cross-space targets are hidden.
- Pickers respect aliases — if a page has an alias, typing the alias matches.

## Slash menu commands

Typing `/` opens the slash menu. Commands are fuzzy-matched as you type — the IDs below are short keywords, so a partial match is enough. Recently-used commands surface in their own group at the top.

| Category | Commands |
| --- | --- |
| **Tasks** | `todo`, `doing`, `done`, `cancelled`; priorities `priority-high`, `priority-medium`, `priority-low` (P1 / P2 / P3) |
| **Dates** | `date`, `due`, `schedule` — open the date picker for the matching property |
| **References** | `link`, `tag`, `block-ref` — insert a page link, tag, or block reference inline (sub-menu picker); `attach` a file; `emoji` opens the emoji picker |
| **Formatting** | `bold`, `italic`, `code-mark`, `strike`, `highlight` — apply a mark without reaching for the chord |
| **Structure** | `h1`–`h6`, `quote`, `code`, `callout` (sub-menu: tip / note / info / warning / error), `table` and `table-no-header` (with an optional dimension suffix — `table 4x6` is 4 rows × 6 columns), `numbered-list`, `bullet-list`, `divider`, `turn` (convert this block to another type), `duplicate` |
| **Properties** | `effort`, `assignee`, `location` — sub-menus offer presets and a custom-value entry; `/property` opens **AddPropertyPopover** for any key |
| **Templates** | `template` — opens **TemplatePicker** to insert a template page's children under the current block |
| **Queries** | `query` — insert an `{{query …}}` block; opens the visual **QueryBuilder** |
| **Repeat rules** | `repeat` — sub-menu with `+` (default), `.+` (completion-based), `++` (skip-past-today) variants for daily / weekly / monthly / yearly. Custom intervals (e.g. `+3d`) are set directly in the property drawer or by editing the `repeat` property value. |

The repeat-rule mode semantics (`+` vs `.+` vs `++`) are explained in [journal-and-agenda.md](journal-and-agenda.md) → *Projected entries*.

## How to add a slash command

The command catalog (visibility + category metadata) lives in `src/lib/slash-commands.ts`; the `useBlockSlashCommands` hook (`src/components/block-tree/use-block-slash-commands.ts`) just re-exports those arrays and `searchSlashCommands`, then drives dispatch. To add a command:

1. Add a `PickerItem` to the right array in `src/lib/slash-commands.ts` — the top-level `SLASH_COMMANDS` array, or a category sub-array (e.g. `HEADING_COMMANDS`, `CALLOUT_COMMANDS`) for sub-menu entries. Set its `category` to the matching `slashCommand.categories.*` i18n key.
2. Wire it into `searchSlashCommands` (`src/lib/slash-commands.ts`), which is what the picker queries — top-level `SLASH_COMMANDS` entries are matched directly; sub-menu arrays must be `matchSorter`-ed and spread into the merged `results` (gate on a prefix where appropriate, as `/turn` does for `TURN_INTO_COMMANDS`).
3. If the command performs a novel operation (not just a turn-into / property set already handled), add its handler in the matching `useBlockSlashCommands/useSlashCommand*` sub-hook (`useSlashCommandDate`, `useSlashCommandProperty`, `useSlashCommandStructural`, `useSlashCommandMarks`, or `useSlashCommandTemplate`) by extending the `SlashHandlerTables` slice (`exact` or `prefix`) it returns. `useBlockSlashCommands` merges the slices and dispatches by `id`.

## Pitfalls to know

- **The picker popup steals the next keystroke.** Once `↑ ↓ Enter Tab Esc Backspace` open the picker is visible, those keys go to the picker — not your block keyboard handler.
- **Type more to narrow.** If the picker shows too many results, keep typing — fuzzy match narrows in real time.
- **Cancel with `Esc`.** Clicking outside also cancels, but the click triggers blur — `Esc` is safer mid-edit.
- **`[[Project/Roadmap]]` works for nested pages.** Forward slashes are how the namespace hierarchy is encoded in titles; the picker shows the breadcrumb.
- **Cross-space cannot be linked.** If you can't find a page in the picker, check the active space — the picker filters to it.
