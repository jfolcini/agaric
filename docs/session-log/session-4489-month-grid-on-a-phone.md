# Session 4489 — the Month grid on a phone

Part of the #7040 UI review, item P2.

**What shipped**

- Gridlines run between the week rows as well as between the days. The grid is a column of rows with a 1px gap over `bg-border`, closed by a 1px border, where before only the day columns had gaps.
- A day's count sits right after its dots. With `ml-auto` it was pushed to the cell's far edge, about 18px from the dots on a 412px phone.
- On a touch screen every cell is at least 64px tall, a date and one count line, so a week with no counts is as tall as the rest. At 44px the empty weeks were shorter, which the new horizontal lines made plain.
- The dots keep their colours.

**Not done**

- The grid keeps its height; it is not stretched to fill a phone screen, since six stretched rows would be tall, mostly empty cells.
- The dot row still wraps when a day has three or more dot colours and a two-digit count on a 360px phone. It wrapped at the same width before.

**Tests**

- e2e `journal-month-grid` (mock lane, a Pixel 7 at 412×915): the paint between two weeks is the paint between two days; the count is within 6px right of its last dot and on its line; a tap opens that day. Both layout assertions were red on the old components.
- Falsified one mutation at a time: no gap on the grid, `ml-auto` back on the count, the cell's click handler removed, the 44px floor back. Each went red on the assertion that covers it.
- vitest `MonthlyDayCell`: the coarse-pointer floor assertion now reads `min-h-16`.
- Also run: the journal vitest suite; `theme-overlay`, `mobile-overflow` and `phone-header-bar` on the mock lane; `journal-monthly` and `agenda-advanced` on the bridge.
