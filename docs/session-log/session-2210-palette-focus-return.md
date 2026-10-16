# Session 2210 — Closing the palette returns focus to its opener (#5639)

Review of #5636's header search button found that closing the Ctrl+K palette
left keyboard focus on `<body>`, from every trigger. A keyboard user who
pressed Escape lost their place and had to Tab from the top of the page.

The cause is Radix's modal dialog content. On close it prevents FocusScope's
own return step and focuses `Dialog.Trigger` instead; the palette is opened
from a store and has no trigger, so nothing took focus. FocusScope's step
would not have helped either: it records the element focused when its effect
runs, and by then the palette input already had focus.

`CommandPalette` now handles `onCloseAutoFocus` and focuses the element the
store already captured on open, `previousFocusedElement`, the one `[[page]]`
insertion reads. It does so only while focus is on `<body>`, so a close that
navigates (a page, the search view) keeps the focus that navigation placed.

Two Playwright specs in `palette-desktop.spec.ts` pin both halves. Removing
the handler turned the Escape test red at `toBeFocused()` on the opener;
dropping the `<body>` check turned the escalation test red at the search
view's input. jsdom cannot reproduce Radix's close-time focus timing, so
there is no vitest test.
