# Session 4275 — App health counters explain themselves on a tap

First PR of #6895. Every counter on Settings › App health, and on the Sync status card in Sync & devices, kept its meaning in a Radix hover tooltip. A tap never opens one. On an iPhone 13 profile, tapping "Writes the sync engine missed" showed nothing, so its "Should stay at zero; if not, run the integrity check" never reached a phone user. The trigger was 21 px tall, and a screen reader heard a button that did nothing.

The maintainer settled the pattern (#6895):

- A `Tooltip` is supplementary only: an icon's name the control's `aria-label` already carries, or a shortcut.
- Anything the user needs is visible text or the new `InfoPopover` (`src/components/ui/info-popover.tsx`).
- The counter label itself is the trigger.

## What shipped

- **`InfoPopover`.** It wraps Radix Popover around the label text.
  - It opens on tap, click, Enter and Space, and closes on Escape or a press outside, with focus back on the label.
  - The label keeps the dotted underline and gets `touch-hit-area`.
  - The popover is `aria-labelledby` its trigger, so it is announced by the label it explains.
  - It has no variants yet. The "?" icon trigger that the app-wide sweep needs adds the first one.
- **`MetricLabel`** in `StatusPanel.tsx` now renders an `InfoPopover` instead of the button-plus-Tooltip.
- **i18n keys.** The `status.*Tooltip` keys are renamed `status.*Info` in all five catalogs; the strings are unchanged.

## Traps

- **axe on a portal.** The explanation is portalled to `body`. `axe(document.body)` then trips the `region` rule on the test's bare body, so the StatusPanel test runs axe on the container and on the open dialog separately.
- **Screenshot timing.** A screenshot taken straight after the tap catches Radix's fade-in, and the FAB shows through. That is not a stacking bug: the popover is z-50 and the FAB z-40.

## What ran

- `just check-fe`: typecheck, oxlint, and 1133 vitest files, all passed. The oxlint warnings are pre-existing ones in files this PR does not touch.
- New tests: `src/components/ui/__tests__/info-popover.test.tsx` (5), and the StatusPanel counter-explanation block (4 tests, plus 1 for the sync card). They replace the hover and `tabIndex` assertions that pinned the old tooltip.
- `e2e/app-health-info.spec.ts` covers an iPhone 13 profile (44 px hit area, finger tap opens, tap outside closes) and desktop (Enter opens, Escape closes with focus back, click opens).
- Next to it, `settings`, `integrity-report`, `mobile-overflow` and `a11y` passed, 86 tests in all. `just e2e-related` names the whole lane for a new `ui/` file, so CI's run is the check.
- **Falsified, each in one restoring command, each going red on the predicted assertion:**
  - No `touch-hit-area`: the class assertion in vitest and the 44 px assertion in e2e.
  - No `aria-labelledby`: every dialog-by-name lookup.
  - `onCloseAutoFocus` prevented: both focus-return assertions.
  - `onInteractOutside` prevented: the outside-press test.
  - `open={false}`: every open assertion, including the phone tap.
  - `origin/main`'s StatusPanel: both e2e tests.
