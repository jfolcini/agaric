# Session 4030 — tag chips take a 44 px touch area on single-line rows (#6532)

Finished the `claude/6532-chip-touch-rows` branch from the overnight handover (#6667), the last box of #6532. The maintainer decided on 2026-11-13 that tag chips get the 44 px area only on single-line rows: the Tags browser list, the page header tag list, agenda and task rows, and search result rows. Chips inside wrapping block text keep their drawn size.

What shipped: the Tags browser's tag button takes `touch-hit-area`; `BlockListItem`'s text span carries `tag-chip-row`, and `.tag-chip-row .tag-ref-chip` grows a hit area 44 px tall and exactly as wide as the chip, so two chips side by side never take each other's taps. That covers the agenda, Done, Due, unfinished-tasks and a page's tagged-items rows. The page header's tag chips are not tappable (their remove button already takes 44 px), and search result rows render a text snippet with no chips, so neither needed a change.

Trap: the inherited CSS centred the pseudo-element with `translate(-50%, -50%)` and `width: 100%`. Its computed width matched the chip, yet a tap one pixel left of the second chip landed on it: a fractional horizontal translate widened the hit box. Anchoring the pseudo-element at `left: 0` with only a vertical translate fixed it.

Ran: `e2e/phone-touch-targets.spec.ts` (9 pass), shown red twice, once with the row rule removed (the agenda chip's 44 px probe fails) and once without `touch-hit-area` on the Tags browser chip; vitest over TagList, BlockListItem and agenda (482 pass).
