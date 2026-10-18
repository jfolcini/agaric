# Session 2593 — The Quick Capture hotkey raises a minimized window, and journal template variables on the real backend (#5735)

#5735 asked for two real-backend specs: journal template variables expanded for the
day being created, and the global Quick Capture hotkey working while the app is
unfocused. The first needed no product change. The second found a bug.

**Bug:** with Agaric minimized, Ctrl+Alt+N opened the Quick Capture dialog inside a
window that stayed minimized, so nothing appeared. `useQuickCaptureShortcut` calls
`unminimize`, `show` and `setFocus`, and no capability granted them; the app log said
"not allowed" for `show` and `set_focus`. `src-tauri/capabilities/desktop.json` now
grants `core:window:allow-unminimize`, `-show` and `-set-focus`, desktop-only like the
global-shortcut plugin that fires the handler.

**Specs:**
- `journal-template-variables.e2e.ts` (new file: the backend copies only the oldest
  page flagged as journal template, so a second template in the existing file's vault
  would be shadowed). A template using `<% weekday %>`, `<% date+1 %>`,
  `<% today:FORMAT %>`, `{{title}}` and `{{cursor}}` is applied to a day three days
  back, created from the date picker; after a round trip the block reads the values
  for that day.
- `journal-template-quick-capture.e2e.ts` gains "the OS hotkey captures onto today
  from a minimized window": xdotool minimizes the window, the chord is pressed at the
  X server, the dialog shows and the window regains focus, and the saved note is in
  today's section after a round trip. `pressChord` moved to `helpers.ts` for it.

**Shown red:** the unfixed capability (the focus wait); Quick Capture writing to
yesterday in `quick_capture_block_inner` (the today-section assertion);
`apply_journal_template_in_tx` expanding against the clock instead of the day (the
expanded-text assertion). On Linux `set_focus` also restores a minimized window, so
the spec pins `show` and `set-focus`; `unminimize` stays because the handler calls it
and macOS needs it.

**Not paired in a blocking lane:** the capability ACL runs only inside Tauri, so no
vitest or mock-backed spec can see it; any `src-tauri/` change already routes through
the real lane (`scripts/classify-changes.sh`).

**Ran:** the three changed real-lane files (`journal-template-quick-capture`,
`settings-desktop-integration`, `journal-template-variables`) on a binary rebuilt from
this tree; `npm run typecheck:e2e-tauri`, oxlint, oxfmt and `npx vitest run e2e-tauri`.
