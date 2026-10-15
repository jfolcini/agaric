# Session 2114 — Real-backend specs for #5365's properties, attachments, block and source items

Testing invariant 4 asks that the real-backend lane carry what the mock lane
cannot prove. #5365 listed the non-sync items still missing there; five spec
files cover them, each in its own vault:

- `due-date-agenda.e2e.ts`: `/due` today on a TODO shows the due chip, lists
  under TODO in the Due panel once `agenda_cache` catches up (a re-mount poll,
  as `search-bm25-order` does), and counts in the week view's badge; and a
  task checkbox edited through Edit as Markdown moves the block to DOING in the
  panel.
- `page-source-property-lines.e2e.ts`: a `key:: value` line added, edited and
  emptied through the page source becomes, changes and deletes the property; a
  refused value blocks the save, names the line, and writes nothing, including
  the block-text edit in the same save.
- `attachment-image-render.e2e.ts`: a pasted PNG renders from its stored bytes
  (`blob:` src, `naturalWidth > 0`), and survives a page-source save of an
  unrelated line with its `attachment:` ref unchanged.
- `block-structure-roundtrip.e2e.ts`: Enter mid-text then Backspace at the
  start gives two rows then one with the text and the source id intact; Tab,
  Shift+Tab and move up/down leave the stored order and levels as shown.
- `page-rename-lookup.e2e.ts`: a page renamed from its header is found by the
  new title, and not the old, in the Pages filter and the `[[` picker.

Not added: the Agenda-view half of the `/due` item (the default Agenda filter
is status-only, so the row shows with or without a due date and the assertion
could not fail), and the `::`-picker item, which reaches the same flush path
`escape-property-line.e2e.ts` already covers. The sync items wait on the
two-device harness.

None of these could run here (no tauri-driver); this PR's real-backend lane is
their first run. Gates: `tsc -p tsconfig.wdio.json`, oxlint, oxfmt,
`npx vitest run e2e-tauri`, the vault-isolation and driver-gate checks, typos.

**First run: 40 of 42; one spec bug, one shipped app bug.** `due-date-agenda`'s
second test waited for the task's static row, but the reopened page hands the
editor back to the focused task; it now waits for the row in either state, as
`block-duplicate` does. `block-structure-roundtrip` found a real bug: on Linux,
Shift+Tab never dedented a block. WebKitGTK reports `ISO_Left_Tab` as
`key: "Unidentified"` with `code: "Tab"` (checked on WebKitGTK 2.52.6, the CI
runner's version), and the native-listener handlers tested `e.key === 'Tab'`,
so the browser moved focus instead. React's synthetic `key` and ProseMirror
keymaps (`w3c-keyname`) already normalise it; the native listeners did not.
`isTabKey` in `keyboard-config/keys.ts` now treats that shape as Tab, used by
the shortcut matcher (`previousTab`, rebindings), the block dedent rule and its
opt-out guard, the Edit-as-Markdown buffer, and the template picker's focus
trap. Vitest tests dispatch the WebKitGTK event shape at each site; each was
red with its fix reverted. The Chromium mock lane could not see this.
