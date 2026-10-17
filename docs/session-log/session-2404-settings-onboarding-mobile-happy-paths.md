# Session 2404 — Happy-path specs for Settings, onboarding and the edge swipe

These are #5741's mock-lane items, part of the #5726 sweep. Each spec was
shown red by a product mutation, and a reviewer re-ran every mutation.

**Shipped:**
- **`settings-general.spec.ts`**: week start Sunday and the "Month D, YYYY"
  format reshape the weekly view's first and last day and the daily
  heading. The spec runs under `page.clock`.
- **`settings-appearance.spec.ts`**
  - Dark adds the `dark` class and changes the computed background, and
    the palette's Toggle theme flips it back.
  - Animations Off sets `data-motion="off"` and stops transitions. A fresh
    boot in a second page checks it again: without the boot-time
    `useMotionPreference`, animations came back until Settings was opened.
  - Tooltip delay Fast opens after 150 ms and not before. The spec drives
    it with `page.clock`, after running out Radix's skip-delay window.
- **`settings-tasks-reminders.spec.ts`**: the deadline warning sets the
  Due panel's Upcoming window, at 3 days and at 7.
- **`settings-help.spec.ts`**
  - Debug mode adds `· code: <kind>` to the pairing dialog's error banner.
  - Show tour reopens Welcome, and closing it sets the first-run flag.
  - Check for updates reports "latest" and "available". The spec answers
    `plugin:updater|check` by wrapping `invoke` after boot, because the
    mock refuses the updater by design. It first waits for the boot-time
    check to settle on "Last check failed", so the click cannot join it.
- **`onboarding-first-run.spec.ts`**: a fresh vault shows Welcome, and
  Get Started dismisses it.
  - The spec boots a second page on a phone profile and waits for the
    gesture coach-mark. That proves the new launch has decided not to
    show Welcome. On desktop nothing renders at that decision, so an
    absence check there would race the lazy chunk.
- **`mobile-edge-swipe.spec.ts`**: a CDP touch swipe from the left edge
  opens the drawer, and a nav tap closes it.
- **`chooseSelectOption`** now lives in `e2e/helpers.ts`. It replaces two
  copies.

**Premises that were wrong:**
- There is no "Long" tooltip delay; the spec tests Fast.
- The theme lives in classes, not `data-theme`.
- Welcome has no tour pages.
- Debug mode's codes never show in a toast, only in dialog and panel
  banners. The switch's description said "notifications", so it now says
  where the codes appear.

**Not here:** the e2e-tauri items (launch at login, the Quick Capture
hotkey, the reminder ledger, the integrity check, the materializer
metrics) and the two Android-only items.

**Ran:**
- the seven settings, onboarding and swipe spec files together (25
  passed), and each new file with `--repeat-each=3`;
- `npm run typecheck`;
- vitest on `src/lib/i18n` and `src/components/settings`.
