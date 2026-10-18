# Session 2538 — launch at login, the Quick Capture hotkey and due reminders on the real backend (#5741)

Real-lane specs for #5741 items 2, 5 and 7.

**Specs:**
- **`settings-desktop-integration.e2e.ts`, item 2 (launch at login):**
  - The switch writes `~/.config/autostart/Agaric.desktop` with
    `Exec=<the binary under test> --silent`, keeps its state across a
    navigation, and removes the file when turned off.
  - The entry lives in the real `$HOME`, so a developer's own entry is moved
    to `Agaric.desktop.wdio-backup` and restored afterwards.
  - After a killed run, the next run drops the leftover entry and keeps the
    backup.
- **Same file, item 5 (Quick Capture hotkey):**
  - The shortcut is rebound from Ctrl+Alt+N to Ctrl+Alt+J.
  - `xdotool` pressing the new chord at the X server opens Quick Capture.
  - The old chord no longer opens it within 5 s. The new chord opening
    within the same window shows that 5 s is long enough.
- **`reminder-due-task.e2e.ts`, item 7 (due reminder fires once):**
  - A passive `dbus-monitor` records the app's `Notify` calls.
  - Task A, due today, is notified exactly once after the reminder time.
  - A later due task B is notified, and A still only once.
  - The run takes about three minutes, so it has its own file.

**Corrections and findings:**
- **`is_registered` is not granted to the window.** The spec waits for the
  dialog instead. `isGlobalShortcutRegistered`, which had no callers and
  could never succeed, is deleted with its mock handler and tests.
- **WebKitGTK ignores WebDriver keys in a `type="time"` input.** The spec
  sets the value through the native setter and checks the saved value after
  a round trip.
- **The maintenance daemon runs a 60 s job only every 120 s.** `last_run` is
  stamped when the job ends and compared against the next tick's start. A
  reminder can come up to two minutes late. The fix gets its own PR.

**CI:** the lane installs `xdotool` and `dbus-bin`. The apt cache key moved
to `-v5`, since #5829 had used `-v4`.

**Shown red:**
- **Item 2:** the switch's save branch inverted.
- **Item 5:** the chord frozen; and, separately, the old registration and
  its handler outliving the rebind.
- **Item 7:** the reminder ledger key unique per run, so A notifies twice.
  The review re-ran this one.

**Ran:**
- each file twice on a rebuilt binary (about 15 s and 3 m);
- typecheck, `typecheck:e2e-tauri`, vitest over the touched areas, oxlint,
  oxfmt, knip, and prek on the changed files.
