# Session 2202 — Settings regrouped so each control lives where people look (#5629)

#5629 found Settings filing controls where nobody looks: General held four
unrelated rows, reporting a bug took three tabs, sync status sat under Help,
and Edit history was a tab holding one button. The issue's table was the
spec, and every claim it made checked out against the code. Its path was
off: the view lives in `src/components/pages/`.

What moved:

- Quick capture went to Keyboard, labelled system-wide.
- Deadline warning went to Notifications, renamed Tasks & reminders. The
  `notifications` id is kept so links survive.
- Debug mode and the welcome tour went to Help, beside Report a bug.
- Sync status and Retry went to the top of Sync & devices, split out of
  `StatusPanel` as `SyncStatusCard`.
- Edit history became a row in Data, and its tab is gone.
- Journal date format went from Appearance to General.

`TAB_IDS` is now derived from `TAB_GROUPS`, so the rail order and the id
list can no longer drift. A test pins the order.

Old links keep working. A `history` tab id lands on Data, whether it arrives
as `?settings=`, a persisted tab, or an `agaric://settings/` deep link; every
other old id is unchanged. Properties hides the internal `is_space`
definition, whose delete always failed.

Skipped, because each is a wording or design call the issue leaves open:
relabelling the relay switch, the optional "AI agents" label, and the
Properties intro line. The floating button still covers a control mid-scroll
on phones. That is inherent to a floating button, and the last control
clears it at the end of the scroll, which a phone test now pins on Keyboard.

Review changed three things. The moved sync status card repeated "No
paired devices yet" when nothing was paired, so it now renders only once a
device is paired. Its Retry button duplicated the device list's Sync all and
per-device Sync now, with no shared busy state, so one device could be asked
to sync twice; the card is now status only and the list owns every sync
action. This departs from the issue's table, which predates seeing the two
side by side. Hiding `is_space` had also hidden it from the duplicate-key
check, so typing that key in Create re-added the row. The list now filters
only when it renders.

Tests assert the persisted effect of every moved control: localStorage, the
navigation store, or a remount. Each new test was shown red against a break
of the code it covers. One test carried over into Keyboard passed with its
row removed and was deleted, since `QuickCaptureRow`'s own test covers it.
Screenshots of every tab in light and dark, at desktop and phone width, were
read back after the change.
