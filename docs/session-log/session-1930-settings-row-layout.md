# Session 1930 — one row layout and per-tab cleanup for Settings (#5345)

This follows up #5332's new look in Settings. Four builders split the work by
file, a fifth did the copy, then an independent review.

What shipped:

- **One row.** `SettingRow` (`src/components/ui/setting-row.tsx`) puts the
  label and description on the left and the control on the right; on phones
  they stack.
  - With a `controlId`, the label names the control and the description
    describes it through `aria-describedby`.
  - `ToggleRow` wraps it and keeps its switch inline at every width.
  - Appearance, Editor, General, Notifications, Data (export, import, history)
    and Help use it. `FormField` is deleted.
- **Each tab named once.**
  - Panel titles that repeated or paraphrased the tab are gone: Notifications,
    Agent access, Keyboard Shortcuts, Property Definitions, Device Management.
  - Section titles lost their icons.
  - The first section titles under the page `h1` are now `h2`. The plan said
    `h3`, but axe flags `h1` → `h3` once the panel titles are gone.
- **Red and primary buttons.**
  - Triggers are outline `sm`, and only a confirm dialog's button is red.
  - "Disconnect all" hides at zero connections, so idle Agent access no
    longer shows two disabled red buttons.
  - "Unpair" is outline.
  - "Pair new device" and "Sync all" are normal width.
- **Agent access.**
  - The socket path, the config buttons and the kill switch show only while
    their toggle is on. Turning a channel off shuts its server and drops
    every connection (`set_marker_enabled` → `lifecycle.shutdown()`), so
    hiding the kill switch never hides a live connection.
  - The activity feed is its own section.
  - The tauri mock now reports the last `mcp_set_enabled` state.
  - The read-write warning badge wraps instead of overflowing a 360px phone.
    That bug predates this change, and a mobile-overflow spec now covers it.
- **Sync & devices.** The device ID is a plain row with its copy button
  beside it, and an empty peer list uses `EmptyState`.
- **Keyboard.** Each row reads action name, keys, edit; static rows have no
  hover; Reset is a ghost `xs` button.
- **Small fixes.**
  - Icon-only buttons are `IconButton`.
  - Dead `h-3.5 w-3.5` icon classes inside `Button` are deleted; Button's
    `size-4` rule always won.
  - Zero queues on Status are neutral, not green.
  - Quick capture uses `Input` and `Kbd`.
  - Properties' Create button keeps the default height, because it shares a
    row with an `h-9` input and select.
- **Copy.**
  - Eleven helper strings are 15–45% shorter.
  - Settings labels and buttons are sentence case, including the "Sync &
    devices" tab and the pairing dialog.
  - Five keys that nothing uses any more are deleted.
- **Corrected claims.**
  - The manual-address hint keeps "on this network": a manual address only
    reaches the bound subnet.
  - The relay text no longer implies some notes are unencrypted.
  - `docs/features/sync.md` no longer says a first pair always needs
    multicast, which QR pairing (#4037) made false.
- **Docs.** `views.md`, `sync.md`, `agent-access.md`, `keyboard.md`,
  `import-export.md`, `spaces.md` and `FEATURE-MAP.md` describe the new layout
  and labels.
- **AGENTS.md.** The mandatory-pattern line now prescribes `focus-ring-visible`
  instead of the half-alpha `ring-ring/50`, which fails 3:1. The maintainer
  approved this change in this session; the PR template matches.

The maintainer decided to leave two things as they are: "Import folder" and
"Import Obsidian vault" stay separate, and the toasts on week start, date
format and image policy stay.

Verified:

- `npm run typecheck`.
- Full vitest from the reviewer: 872 files, 20 762 passed, 51 skipped,
  1 expected fail.
- Playwright: 128 distinct tests across settings, settings-phone,
  agent-access, mcp-activity-events, import-export, keyboard-customization,
  properties-system, sync-ui, sync-pairing-flows, mobile-overflow,
  language-preference, history-revert, app-chrome and nav-active-item.
- axe is clean on every Settings tab at desktop and phone widths.
- Each builder and the reviewer showed new assertions red against a mutated
  copy, then restored it:
  - the gate opened;
  - an h3 put back;
  - the badge fix removed;
  - Unpair red again;
  - the stateless mock;
  - the old card-based Help;
  - the row-order swap.
