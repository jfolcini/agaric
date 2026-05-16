<!-- markdownlint-disable MD060 -->
# Properties

Every block in Agaric can carry typed properties. Some properties are built in (and drive features like the agenda); the rest are user-defined.

## Value types

| Type | What you get |
| --- | --- |
| **Text** | Free text. |
| **Number** | Plain integer or decimal; numeric sort. |
| **Date** | ISO-8601 date. Inline date editor accepts natural language (`today`, `+3d`, `Apr 15`, `next monday`). |
| **Boolean** | Toggle. |
| **Select** | Pick one of a fixed list of options; the option list lives on the property definition (edit via the property drawer). |
| **Ref** | Reference to another page; resolved by ULID so renames don't break it. |

Properties are defined once (key + type + optional configuration like select options); thereafter you can set the property on any block via the **Property Drawer**, the slash menu, or by typing `key::` inline in the editor.

## Built-in properties

These ship out of the box and back specific features:

| Key | Type | Used by |
| --- | --- | --- |
| `todo_state` | Select (TODO / DOING / DONE / CANCELLED) | Editor task cycle; Agenda filter |
| `priority` | Select (P1 / P2 / P3) | Editor priority cycle; Agenda filter; visual chip |
| `due_date` | Date | Agenda Due panel; date-property colour |
| `scheduled_date` | Date | Agenda Due panel; date-property colour |
| `completed_date` | Date | Done panel; Agenda filter |
| `created_date` | Date | Agenda filter; History timestamps |
| `effort` | Number | Optional task sizing |
| `assignee` | Ref | Optional task ownership |
| `location` | Text | Optional task context |

## Repeat properties (recurring tasks)

Five properties drive recurrence on a task:

| Key | Meaning |
| --- | --- |
| `repeat` | The rule. Examples: `+1w`, `.+1w`, `++1w`, `+3d`, `daily`, `weekly`, `monthly`, `yearly`. The leading prefix is the mode (see below). |
| `repeat-until` | A cut-off date — projection stops once `current > until`. |
| `repeat-count` | Total number of occurrences. |
| `repeat-seq` | How many have already fired (incremented when DONE rolls the task forward). |
| `repeat-origin` | The original anchor date — preserved so `.+` mode can re-anchor on completion. |

For the `+` / `.+` / `++` mode semantics, see [journal-and-agenda.md](journal-and-agenda.md) → *Projected entries*.

Marking a repeating task DONE rolls it forward: a new occurrence is generated, `repeat-seq` increments, and the previous occurrence stays as a completed entry in History / the Done panel.

**Recipe — weekly until end of year:** `due_date = 2026-05-22`, `repeat = +1w`, `repeat-until = 2026-12-31`.

## The Property Drawer

Opens via `Ctrl+Shift+P` or the toolbar's Properties button. A slide-out sheet (mobile = bottom sheet) on the focused block.

- **Built-in date fields** at the top — `due_date`, `scheduled_date`, plus `completed_date` and `created_date` (read-only).
- **Custom property rows** below — one row per property. The editor switches by type: text input, number input, date picker, checkbox, dropdown (with edit-options affordance), page picker.
- **Add a property** with the "+" button → **AddPropertyPopover** (search existing definitions, or create new with type picker).
- **Blur-to-save** — closing the drawer or moving focus commits the change.

## Inline display

Set properties appear as chips on the block:

- Up to a small handful of chips render inline; the rest collapse into a *"+N"* badge.
- Click a chip to open the inline editor for that property.
- Each property type has a dedicated chip: priority pip + label, date chip with overdue colour, ref chip with target title.

## Inline syntax (`::`)

Type `::` (or any prefix you've already typed) inside a block to open the **PropertyPicker**. Pick an existing property key, then type its value. This commits the property without leaving flow.

## Property change events

When a property value changes, downstream surfaces (DuePanel, DonePanel, LinkedReferences, Agenda) auto-refresh — you don't need to navigate away and back.

## Where to manage definitions

**Settings → Properties** lists every property definition with type, usage count, and edit affordances. From there you can rename a property key, change its type (with confirmation when destructive), or add / edit / remove select options. The same view is also reachable via the `agaric://settings/properties` deep link.

## Pitfalls to know

- **Type changes are destructive.** Switching a property from `text` to `number` can drop values that don't parse.
- **Select options are part of the definition, not the value.** Renaming an option propagates to every existing value of that property.
- **Repeat with no `due_date` or `scheduled_date` doesn't project.** A repeat rule needs at least one anchor date to know where to start.
- **`repeat-seq` is mutated automatically** when a task is DONE. Hand-editing it can confuse the projection.
- **Natural-language date input** is local to the inline date editor; the underlying storage is always ISO-8601.
