# Session 4303 — the References sort pick lost its click to the moving list

`property-types-happy-paths.spec.ts` "sorts the References panel numerically" opened the panel's Sort select and clicked the `estimate` option, and under parallel load the listbox sometimes stayed open on Created. Logging pointer events from the page showed why: the press landed on `estimate` and the release, at the same coordinates, on `effort`. Radix's item-aligned Select scrolls the chosen item into line on open and grows as its viewport scrolls, and Playwright's own scroll-into-view of the option sets that off, so the list was still moving when the click was aimed (the option's y varied from 573 to 697 across runs). A release on a neighbour picks nothing, since that item saw no mouse press, and the click goes to their common parent. It is #6891's mechanism on a desktop Select. A user does not press and release across a row while the list scrolls, so the app stays as it is.

The test now presses Enter on the option, which needs no aim, as `openSettingsTab` does since #6891. `chooseSelectOption` has the same click, but its twelve calling specs ran 342 of 342 green at 8 workers, so it is left alone until one of them is shown red.

## What ran

- Before, on 088d761: the test ×80 on 8 workers failed 8 of 80; the instrumented copy failed 1 of 60 with the press on `estimate` and the release on `effort`.
- After: ×160 on 8 workers, 160 of 160.
- Falsified: with the mock's backlink sort comparing numbers as strings, the test goes red on the `[nine, twelve]` assertion.
