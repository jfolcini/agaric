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
| **Ref** | Reference to another page, picked from the page picker (it lists pages, not tags); resolved by ULID so renames don't break it. |
| **URL** | Declares that a key holds a link. Stored and edited as text — that is all the engine enforces. Opening is decided by the value, not the declaration: any property value that parses as `http`, `https` or `mailto` gets an open-link control on its inline chip, whatever its declared type. |

Properties are defined once (key + type + optional configuration like select options); thereafter you can set the property on any block via the **Property Drawer**, the slash menu, or by typing `key::` inline in the editor.

## Built-in properties

These back specific features. Their definitions are fixed: the same in every vault, they can't be edited or deleted, and Settings shows them with a lock.

| Key | Type | Used by |
| --- | --- | --- |
| `todo_state` | Select (TODO / DOING / DONE / CANCELLED — that order is the cycle) | Editor task cycle; Agenda filter |
| `priority` | Select (1 / 2 / 3) | Editor priority cycle; Agenda filter; visual chip |
| `due_date` | Date | Agenda Due panel; date-property colour |
| `scheduled_date` | Date | Agenda Due panel; date-property colour |
| `completed_at` | Date | Done panel; Agenda filter |
| `created_at` | Date | Agenda filter; History timestamps |

The repeat properties below, the list style (`listStyle`: bullet / ordered) and the space keys (`space`, `is_space`) are built in too.

A block that holds a priority level or task state from before these options were fixed keeps it, and an out-of-range priority shows a neutral badge and sorts after the three levels. Writing such a value again is refused.

A new vault also starts with a few ordinary definitions you can edit or delete: `status`, `url`, `effort`, `assignee` and `location`. The `due` definition, which duplicated `due_date`, is gone from every vault; a value a block holds under `due` stays, as an undeclared property.

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

Removing `repeat` (`/repeat remove`, its delete button, or its line in *Edit as Markdown*) removes the `repeat-until`, `repeat-count` and `repeat-seq` the task holds with it, in one undo, so a rule set later starts over. `repeat-seq` and `repeat-origin` have no delete button of their own; only recurrence writes them.

**Recipe — weekly until end of year:** `due_date = 2026-05-22`, `repeat = +1w`, `repeat-until = 2026-12-31`.

## The Property Drawer

Opens via `Ctrl+Shift+P` or the toolbar's Properties button. A slide-out sheet (mobile = bottom sheet) on the focused block.

- **Built-in date fields** at the top — `due_date`, `scheduled_date`, plus `completed_at` and `created_at` (read-only).
- **Custom property rows** below — one row per property. The editor switches by type: text input, number input, date picker, checkbox, dropdown (with edit-options affordance), page picker.
- **Add a property** with the "+" button → **AddPropertyPopover** (search existing definitions, or create new with type picker).
- **Blur-to-save** — closing the drawer or moving focus commits the change.

## Inline display

Set properties appear as chips on the block:

- Up to a small handful of chips render inline; the rest collapse into a *"+N"* badge.
- Click a chip's key to rename the key, and its value to open the inline editor for that property.
- Priority, due and scheduled dates have their own chips: priority pip + label, date chip with overdue colour.
- A ref chip shows its target's current title (a rename shows at once); clicking the title opens the target. A boolean chip says *Yes* or *No*; clicking it opens the Property Drawer, where the value is a checkbox.

## Inline syntax (`::`)

Type `::` inside a block to open the **PropertyPicker**. Pick an existing property key (this inserts the text `key::` plus a trailing space), then type its value. When the block is saved — on blur, or when focus moves to another block — any line that is *exactly* `key:: value` is committed to the property system and the line is stripped from the block's text.

The parsing rules match the Logseq/Markdown importer, so inline entry and file import agree on what a property line is:

- The whole line (after trimming) must be `key:: value`, a space or a tab after the `::`. A `::`-plus-space appearing mid-sentence, or `::` without a following space (`std::vector`), never matches.
- Keys are 1–64 characters of letters, digits, `-`, `_` — the same alphabet the backend enforces. A key names the built-in key or definition it matches ignoring case and treating `-` and `_` alike, and is stored in that spelling: `Priority::` sets the priority, `due-date::` the due date. There are no aliases: `due::` is its own key, not `due_date`. A key that matches two definitions this way is kept as typed.
- The value is stored per the key's **definition type**: text and select keys store the text (select values must be one of the defined options); number keys parse the value as a number; date keys require the `YYYY-MM-DD` shape; boolean keys accept exactly `true` or `false`; `repeat` must be a rule the recurrence engine reads. A value that doesn't fit the key's type leaves the line as literal text. A ref-typed key takes a block id, a `[[Title]]` or a plain title of a page in the block's space (exact, then case-insensitive, then alias; never a tie). A key with no definition is written as text — no definition is created for it, so it won't appear in Settings → Properties until you declare it.
- If the key already has a value on the block, the inline write **updates** it (same upsert as the drawer).
- A line is stripped **only after its property write succeeds.** If the write is rejected (invalid select option, unparseable number, backend error), the line stays as literal text — nothing you typed is lost — and a single "Kept as text: …" toast names each such line (for a bad `repeat` rule, the toast says what is wrong with it).
- **Empty values are not committed.** `key::` (with the trailing space but no value) followed by blur writes nothing and the text stays literal (the backend rejects empty property values).
- Reserved, exporter-managed keys are never parsed inline, in any spelling; those lines stay literal. The list is `space`, `is_space`, `template`, `created_at`, `completed_at`, `repeat-seq` and `repeat-origin`. The repeat rule itself (`repeat`, `repeat-until`, `repeat-count`) is an ordinary property line here, as on every markdown surface.
- Lines inside fenced code blocks are never treated as property lines.

Multiple property lines in one block (soft line breaks via Shift+Enter) are supported — each is committed and stripped independently. Pasted multi-paragraph content is split into separate blocks before saving and is not property-parsed; the importer handles property lines in imported files.

## Property change events

When a property value changes, downstream surfaces (DuePanel, DonePanel, LinkedReferences, Agenda) auto-refresh — you don't need to navigate away and back.

## Where to manage definitions

Definitions belong to a space: each space declares its own keys, and a key's type in one space says nothing about it in another. They sync with the space to your other devices; when two devices change the same key before they sync, the later change wins. A value a block already holds under a key whose type changes on another device is read again under the new type once it arrives. A new space starts with the built-ins plus editable `status` (select: active, paused, done, archived), `url`, `effort`, `assignee` and `location`; it does not copy another space's definitions.

**Settings → Properties** lists the property definitions of the space picked in its *Definitions in* selector (the active space by default), each with its type and how many of that space's blocks use it (blocks in the Trash left out). From there you can create a definition, delete one no block of that space uses, edit a select key's options as a JSON array, and *Copy to space…* a definition into another space. A block in the Trash still counts against a delete, so a definition showing 0 uses can still be refused, and the refusal says so. Copying keeps a definition the target already has under that key and says so. Each create, options edit, delete and copy offers Undo on its toast. A built-in definition shows a lock and offers none of these. Renaming an option is not built yet (#5841).

**Rename** moves a definition to a new key, with every value the space's blocks hold under the old one, the Trash included. The new key must be free in that space: not a built-in, not a key the app keeps for itself (`template`, `accent_color`, … — those are never renamed either), not declared, and not held by any block. **Merge into…** folds one definition into another of the same type: each value moves to the target key, a block that already holds the target keeps its own value and loses the merged one, and a select target gains the merged key's options it lacks; the merged definition goes away. The dialog first shows how many values move and how many are removed, blocks in the Trash counted too; if those counts change before you confirm, it shows the new ones and asks again. Both offer Undo on their toast, which puts the old key, its values and the target's options back, and undoing an earlier change to a block's value lands it under the key it lives under now, whether this device or another renamed or merged it since. A saved query or filter that names the old key in its text is not rewritten.

**Change type…** converts every value the space's blocks hold under a key, the Trash included, to another type, and removes each value the new type cannot hold. A value becomes a number when its text is one (spaces around it ignored, `1e3` allowed), a boolean when it is exactly `true` or `false`, a date when it is exactly `YYYY-MM-DD` and a real day, and a ref when it is a block id (whether or not that block exists; one that does not is not shown). Numbers and booleans never become each other, and any value becomes text or a URL as it reads (a ref as its block id). Changing to select asks for the options; a value outside them is removed. The dialog shows how many values are converted and how many are removed, and its *Removed* and *Converted* tabs list the blocks holding them; if the values change before you confirm, it shows the new counts and asks again. Undo on the toast puts back the old type, and each value the change converted to another form or removed, even on a block changed since. A value written since on any other block stays: a number or boolean as it is, any other value hidden when the old type cannot hold it (changing the type again shows it). Undoing an earlier change to a block's value converts it to the key's type now, or is refused, asking you to change the type back first, when that type cannot hold it. A built-in or app-internal key's type cannot change. History lists the change as *Properties rewritten*, `key: old → new`. A value another device writes under the old type before it receives the change, and the new type cannot hold, is not shown; changing the type back shows it again.

A rename and a merge reach your other devices with the space. A value another device writes under the old key before it receives the rename may stay under the old key, undeclared, or be lost to the rename, depending on the order the devices' changes merge; if it stays, declare that key again with the same type and merge it to fold it in. When two devices rename the same key to different names before they sync, the blocks end up holding both keys and both definitions exist; merging one into the other loses nothing. The same view is also reachable via the `agaric://settings/properties` deep link.

## Pitfalls to know

- **A new definition can't contradict values you already have.** A definition applies to every block of its space, and it can't be removed again while any value under that key exists there. Declaring `year` as `number` while some blocks hold `year = "circa 1920"` would therefore reject every later text edit of `year` anywhere, drop those values on the next sync, and leave you unable to withdraw the definition. So creating a definition is **refused** when values already stored under the key would not fit the type you picked; the message names the key, how many values are in the way, and what shape they are stored in. Declaring a type that every existing value already satisfies (all your `year` values are numbers) is allowed and does exactly what you'd expect. A bibliography import behaves differently on purpose: it leaves such a key undeclared and reports the skip in its warnings rather than refusing the whole import.
- **Moving a page to another space drops each value the target space defines differently.** A value stays when its key is built in, when both spaces define the key with the same type and options, or when neither defines it. Every other value, declared in only one of the two spaces or with another type or other options, is removed by the move. The move covers the page and its blocks, trashed ones included; a nested page keeps its own space. Before it drops anything, *Move to space* lists each property it would remove with its count, and each one expands to the pages and blocks holding the values. One undo moves the page back and restores them. A move that would remove more values than one undo can restore, counting the moves too, is refused; move fewer pages at a time.
- **Select options are part of the definition, not the value.** Editing the option list leaves existing values alone: a value whose option you removed or renamed keeps its old text.
- **Repeat with no `due_date` or `scheduled_date` doesn't project.** A repeat rule needs at least one anchor date to know where to start.
- **`repeat-seq` is mutated automatically** when a task is DONE. Hand-editing it can confuse the projection.
- **Natural-language date input** is local to the inline date editor; the underlying storage is always ISO-8601.
