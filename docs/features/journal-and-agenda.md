<!-- markdownlint-disable MD060 -->
# Journal & Agenda

The **Journal** is the default landing view and the only one mounted eagerly. It is your daily writing surface and the home of the agenda. Reach it from the sidebar's calendar icon.

The Journal renders one of four **modes** that all share a single date cursor:

| Mode | What you see | Picker / hotkey |
| --- | --- | --- |
| **Daily** | One day's blocks plus a Due Panel and a Done Panel for that day. | Default. Click the day in the date picker. |
| **Weekly** | Monday–Sunday sections, each a mini Daily view. | Toggle in the Journal header. |
| **Monthly** | Calendar grid with coloured dots on days that have content. | Toggle in the Journal header. |
| **Agenda** | Flat task list across a date range, with filters and grouping. | Toggle in the Journal header. |

Per-space: every space has its own date cursor and mode. Switching spaces restores wherever you left off.

## Navigation

| Action | Trigger |
| --- | --- |
| Previous day / week / month | `Alt+←` |
| Next day / week / month | `Alt+→` |
| Jump to today | `Alt+T` (or *Today* button in the Journal header) |
| Pick a date | Calendar icon → date picker |
| Open Agenda mode | *Agenda* button in the Journal header |

The date picker shows **coloured dots** on days that already have content: one dot per source type (page / due / scheduled / property). Hovering reveals the count. Empty days are unmarked.

## Due Panel (Daily mode)

The Due Panel surfaces today's tasks that have a due / scheduled / property-derived date.

- **Header counts** like *"2 Due · 1 Scheduled · 1 Properties"* — a source breakdown so you can see at a glance where today's load comes from.
- **Source filter pills**: *All / Due / Scheduled / Properties*. Click one to narrow the list to that source only.
- **Hide-before-scheduled toggle**: hides scheduled tasks whose scheduled date hasn't arrived yet (useful if you only want what's actionable now).
- **Overdue label**: tasks past their due date show *(Xd overdue)*. Clicking jumps to the task in its source page.
- **Property pills**: tasks pulled in via a property carry a pill in the form `key = value` so you can see why they landed in the panel.

## Done Panel (Daily mode)

The Done Panel lists what you completed today, grouped by source page. Useful for end-of-day review and for finding the page you just closed something out from.

## Agenda mode

Flat task list across a date range with filtering, sorting, and grouping.

- **Default state filter** opens with TODO and DOING only — DONE / CANCELLED are hidden until you clear the filter. This keeps "what's in flight" the first thing you see.
- **Default grouping**: by page. Tasks without a page collect into a muted "No page" group at the end.
- **Default sort**: by state (DOING → TODO → DONE → CANCELLED). Within a state, by date.

### Filter dimensions

You can stack any combination of:

- **Status** (TODO / DOING / DONE / CANCELLED)
- **Priority** (P1 / P2 / P3 / none)
- **Due date** preset (overdue, today, this week, this month, no date, custom range)
- **Scheduled date** preset (same shape as due-date)
- **Completed date** preset
- **Created date** preset
- **Tag** (single or boolean expression)
- **Property** (`key:value`)

The *Clear all filters* button resets to defaults. Sort / group preferences persist per device.

### Projected (future-occurrence) entries

For repeating tasks, Agenda mode projects future occurrences within the viewed date range. They render with a dashed border and a *"Projected"* label so you don't mistake them for committed tasks. The projection respects all three end-conditions:

- **`repeat-until`** — stop at a date.
- **`repeat-count`** — stop after N occurrences total.
- **Repeat mode**:
  - **`+`** (default) — shift from the original date by the interval (e.g. `+1w` weekly).
  - **`.+`** (dot-plus / completion-based) — every occurrence anchors to *today*, not to the previous date. Use when "every week starting from when I completed the last one" matters more than the calendar.
  - **`++`** (plus-plus / skip-past-today) — like default, but advances past today first so stale occurrences don't pile up after a long absence.

Projected entries deduplicate against the cached projection — the agenda you see is the same whether the cache is warm or cold.

## Inline date editing

Date chips on agenda entries (due, scheduled) are clickable. Click opens an inline date editor with a text input that accepts natural-language strings (`today`, `tomorrow`, `+3d`, `next monday`, `Apr 15`) plus a calendar widget. Press Enter to apply, Escape to cancel.

## Repeating tasks

Repeating tasks are configured via properties (see [properties.md](properties.md) → Repeat properties). Marking a repeating task DONE auto-rolls it to the next occurrence according to the rule; the previous occurrence stays as a completed entry in the Done Panel and the History view.

## Inline tasks in the editor

In the editor (any block can be a task), the **task state cycle** is `Ctrl+Enter`. The cycle moves TODO → DOING → DONE → (clear). Re-cycle on DONE jumps back to TODO (or, on a repeating task, advances the recurrence). Priority is set directly with `Ctrl+Shift+1` / `Ctrl+Shift+2` / `Ctrl+Shift+3` (P1 / P2 / P3). Dates open with `Ctrl+Shift+D` (due) and `Ctrl+Shift+S` (scheduled).
