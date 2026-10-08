# Session 1928 — review notes from #5349

#5349 dropped the CSS `uppercase` from small section labels, so their i18n
strings now show as written. Eleven were Title Case, so they did not match the
sentence-case style the PR set:

- the unfinished-tasks "This week" bucket;
- the Settings rail's "Data & sync" group;
- nine keyboard-shortcut categories: "Block tree", "Block selection",
  "Undo / redo", "List selection", "History view", "Page editor",
  "Editor formatting", "Suggestion popup" and "Quick capture".

The reviewer named only the first, so I swept the rest.

Left as is: the reviewer's other note. In week view, today's highlight plate
(`bg-accent/[0.08]`) is narrower than the hanging control lane, so the grip
sits outside it. The tint is barely visible in either theme, and the grip
hangs in the same margin on every other row.

Verified: the UnfinishedTasks, KeyboardShortcuts, KeyboardTab, SettingsView
and i18n suites pass (8 files, 432 tests). No test asserts these strings.
