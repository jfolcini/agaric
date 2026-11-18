# Session 4284 — explanations open on a tap, app-wide

Second PR of #6895, after #6900 (App health). The maintainer set the rules on #6895:

- A `Tooltip` only repeats an icon's name its `aria-label` carries, or a shortcut.
- Anything a user needs opens from an ⓘ beside it (`InfoPopover variant="icon"`).
- A disabled control's reason goes behind an ⓘ beside it.
- A hover-only exact time becomes a tap/Enter toggle.
- A broken `[[link]]` chip explains itself with Remove inside instead of deleting on a tap.

## What shipped

- **Primitives.** `InfoPopover` gains the `icon` variant (CVA) and passes `data-testid` through. `RelativeTime` (`src/components/common/`) swaps "3h ago" in place to the exact time and back.
  - Both keep their clicks, and the popover's Escape, out of a selectable row around them. React bubbles a portal's events to the trigger's ancestors: History rows select on click, and the block-history list collapses on Escape.
- **ⓘ explanations:**
  - task-state help, repeat help, the History op-type legend;
  - template placeholders: one ⓘ for the whole list, replacing a tooltip per unfocusable `<code>`;
  - tag-filter modes and "Include nested blocks", the due-panel sources, Advanced Query All/Any and NOT;
  - History's synced and non-reversible marks.
- **Visible text.** Agenda filter dimensions show their description as text, since an ⓘ inside a menu item would nest controls.
- **Disabled reasons behind an ⓘ:** space delete, local graph, add property, page mode's blocked Page, and the inherited-tag note.
- **Space delete.** A non-empty space already says why under its row, so it gets no ⓘ; the last space and a space still being checked do.
- **History time.** History rows use `RelativeTime`. A block-history sheet's restorable row is itself a button, so its time stays text; its expanded Restore button names the exact time instead.
- **Broken link chip (static block).** It is a popover trigger, with Remove inside. The editor-side chip in `block-link.ts` is left for #6895's last PR.
- **Dead hints deleted.** Neither could ever open: the empty block's paperclip tooltip, and the attachment resize `title`.

## Traps

- **`Tooltip` remounts its trigger.** The `Tooltip` wrapper rendered a different tree when given `open`, so `EditModeSwitch` keeping the Page hint shut while blocked remounted Page and dropped its focus. The controlled branch now renders inside the same (null) context provider.
- **`data-slot` override.** An `InfoPopover` that overrode its content's `data-slot` broke `activePopover`, which every e2e helper uses (`[data-slot="popover-content"]`). The override is gone.
- **`fingerTap` needs the target on screen.** It presses the box's coordinates, so a spec scrolls the target into view first.
- **Phone alignment check.** `phone-views.spec.ts` compared the tops of the 44 px phone Select and the old 44 px "?" button. The ⓘ is smaller, so the check now compares their middles, which is what "share a row" means.

## What ran

- Vitest, all 1136 files, green; typecheck and oxlint clean.
- Every new test was shown red by breaking the code it covers, each in one restoring command. That includes the e2e spec `e2e/info-cues.spec.ts` (phone and desktop):
  - ⓘ never opens: red;
  - time never swaps: red;
  - the time's click reaches the row: red, on `aria-selected`.
- Playwright: 109 related specs, 684 passed and 3 failed. Two of the failures were the `data-slot` trap, fixed and re-run green with the review fixes (59 passed).
- The third, `phone-header-bar` › Settings header, did not reproduce in 10 repeats. Nothing in this diff renders there.
- An independent review found no blocking defect. Its five non-blocking findings are fixed: the Escape leak, the `EditModeSwitch` gap and remount, axe on the open chip, the duplicate space reason, and comment wraps.

## Review notes folded in

- **Page link focus.** Page mode's link in the Markdown buffer (`PageSourceEditor`, `PageModeLink`) had two trees, so a blocked reason arriving while it had focus remounted it and dropped the focus. It now keeps one shape: one `Tooltip`, shut while blocked, and the link and its ⓘ in one box. With that, `InfoPopover`'s `className` prop has no caller left and is removed.
- **Relative time.** `RelativeTime` re-renders on `useMinuteClock`, so "3m ago" ages while History stays open. The unused `now` prop is removed.
- **Merge with #6908.** The Due panel's count strings became whole messages; the catalogs keep those and add this PR's `duePanel.filterInfoLabel`.
