# Session 1992 — lazy-load interaction-only dialogs

Set out to take the dialogs and pickers named in #5441 off the boot path. A
builder died mid-work; a continuation agent reviewed its diff, finished it and
verified it.

Shipped: the block-tree dialogs, the date and template pickers, the calendar
dropdowns, the Due-panel reschedule calendar, the query builder, the backlink
add-filter row and the agenda filter builder load with `lazy()` and mount only
while open. The App search overlays mount only while their store says open and
preload on idle. A `date-fns` vendor chunk keeps react-day-picker off the boot
preload list. Budgets for `index`, `datepicker` and `date-fns` come from a
real build; the other chunks were left alone so a full `--update` did not
loosen unrelated drift.

Traps: the boot import-graph test resolved a folder import to the directory
and never walked into it, so it could not catch a static `EmojiPicker` import
until its resolver was fixed. `AgendaFilterBuilder` re-exported the sort
controls, which kept the builder static; the re-export is gone. An inherited
"measured" timing comment had no harness behind it and was deleted.

Not done: the coverage-based share of boot JS executed, which needs a
Playwright coverage harness. Suites run: full vitest, typecheck, lint, build
plus the bundle-budget check, and the Playwright specs that cover the moved
overlays.
