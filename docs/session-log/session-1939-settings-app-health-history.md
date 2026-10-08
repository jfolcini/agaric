# Session 1939 — Settings: App health tab and Edit history tab (#5360, #5361)

Two Settings changes from the user's notes, reworked after the maintainer
rewrote both issues with detailed proposals.

#5360:

- The touch-gestures card leaves Help, along with its strings; the first-run
  coach mark no longer points at it.
- The integrity check moves out of Data into the Status tab, relabelled
  "App health" (id `status` kept, so `?settings=status`,
  `agaric://settings/status` and the palette still work). That tab now sits in
  the Help group, after Help.
- The "Enable the integrity check" switch and its device preference are gone:
  Run is always shown and is the only trigger.
- The bug report dialog no longer sweeps the vault on open. `SettingsView`
  holds the last Run's result, and Help › Report a bug carries it; leaving
  Settings drops it.
- The palette entry reads "Open App health".

#5361: an Edit history tab, after Data in Data & sync, holds the row whose
button opens the full-page History view. Hosting the view inside the tab
would need its header filter bar and document-wide keyboard handler
reworked; the maintainer chose the button. The palette keeps opening the
view directly.

Docs: FEATURE-MAP, `docs/features/views.md`, `UI-MAP.md`, and three stale
"Settings › Status" mentions elsewhere.

Verified (builder and reviewer): moving the card above the status panel, or
owning the result in the tab instead of `SettingsView`, turned the tests red
on copies; targeted vitest (32 files) 1088 passed; typecheck exit 0; oxlint
and oxfmt clean; Playwright settings, settings-phone, history-revert,
history-advanced, sync-ui, mobile-overflow and editor-lifecycle, 90 passed.
