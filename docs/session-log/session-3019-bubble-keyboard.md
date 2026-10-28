# Session 3019 — The selection bubble's buttons work from the keyboard (#6159)

Set out to fix #6159: the keyboard could not operate the selection bubble that appears over selected text.

**Shipped:**
- **Enter or Space on the mark and link buttons now acts.** They only answered `pointerdown`, so a keyboard click (a click with `detail` 0) did nothing. They now spread `toolbarPressHandlers`, as page mode's bubbles do.
- **The arrow keys move between the buttons.** `useRovingTabindex` read `e.key` off the event TipTap's `BubbleMenu` hands to handler props. That event is `Object.create(nativeEvent)`, and reading `key` on it throws `Illegal invocation` in Chrome, on every key. The hook now reads `e.nativeEvent.key`, which is the same value for every other caller (a plain React `div`).
- **One Tab reaches Bold.** TipTap's plugin view sets the bubble container's `tabIndex` to 0, so the container was a second tab stop. Setting -1 once after mount does not hold, because ProseMirror rebuilds every plugin view when another plugin registers, and each rebuilt view sets 0 again. TipTap's `onShow` runs on every show, so the container's `tabIndex` is set there.

**Depended on #6161.** In block mode, Enter on a focused bubble button was taken by the block keyboard rules, which saved the block. #6161's guard (keys aimed at a control are left to it) fixed that, so this branch waited for it to merge.

**Left alone:** the image and page-link bubbles' containers are also tab stops. They do not use the roving hook, and nothing reported them.

**Tests:**
- `e2e/bubble-keyboard.spec.ts` covers block mode and page mode. With Tab-indents off, it selects text with the keyboard, presses Tab once to reach Bold, then Space, then Enter. It checks the stored Markdown is `**hello** **world**` after navigating away and back.
- In vitest: a TipTap-shaped event for the hook, a keyboard click for the mark and link buttons, and a pointer press that toggles once.
- Each was shown red.

**Suites:**
- vitest over `src/hooks`, the toolbar and editor dirs, and `src/components/pages` (7,109 tests);
- typecheck, lint and the manual-stage hooks;
- Playwright: the bubble, toolbar, table, emoji and keyboard-collision specs (100).
